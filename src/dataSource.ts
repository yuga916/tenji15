/**
 * データ取得元の抽象化。
 * - MockDataSource: ダミーデータ(開発・デモ用)
 * - OfficialDataSource: 公式配布の番組表(Bファイル)から実データを生成【実装済み】
 *   ※ 展示・オッズの直前反映(シグナルフェーズ)と結果(Kファイル)は次フェーズで追加
 *
 * 規約への配慮(2026/7確認): 配布ページに利用条件の明示なし・robots.txt全許可。
 * 取得は1日分=1リクエストの低負荷設計。展示・オッズページには現段階でアクセスしない。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Race } from "./types.ts";
import { fetchBFileText } from "./officialFetcher.ts";
import { parseBFile } from "./officialParser.ts";
import { venueByJcd } from "./venues.ts";
import { computePreProbs, computeInEscape, computeKimarite, buildPreVerdict, toEntries } from "./model.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BoatDataSource {
  fetchRaces(dateISO: string): Promise<Race[]>;
  readonly label: string;
}

/* ---------------- Mock ---------------- */
export class MockDataSource implements BoatDataSource {
  readonly label = "Mock (ダミーデータ)";

  async fetchRaces(dateISO: string): Promise<Race[]> {
    const raw = await readFile(path.join(__dirname, "..", "mock-data", "mock-races.json"), "utf-8");
    const races: Race[] = JSON.parse(raw);
    return races.map((r) => ({
      ...r,
      dateISO,
      raceId: `${r.venueSlug}-${dateISO}-${r.raceNo}`,
      updatedAt: new Date().toISOString(),
    }));
  }
}

/* ---------------- Official (公式配布・実装済み) ---------------- */

/** 番組表テキスト→Race[] 変換(テスト可能な純関数) */
export function convertBText(text: string, dateISO: string): Race[] {
  const { venues, warnings } = parseBFile(text);
  for (const w of warnings.slice(0, 10)) console.warn(`[official] 警告: ${w}`);
  if (warnings.length > 10) console.warn(`[official] 警告 他${warnings.length - 10}件`);
  if (venues.length === 0) {
    throw new Error("番組表のパース結果が0場でした。DEBUG_PARSER=1 で実ファイルの形式を確認してください。");
  }

  const races: Race[] = [];
  const now = new Date().toISOString();

  for (const vd of venues) {
      const venue = venueByJcd.get(vd.jcd);
      if (!venue) {
        console.warn(`[official] 不明な場コード: ${vd.jcd}`);
        continue;
      }
      for (const pr of vd.races) {
        const probs = computePreProbs(pr);
        const inEscape = computeInEscape(pr, venue, probs);
        races.push({
          raceId: `${venue.slug}-${dateISO}-${pr.raceNo}`,
          venue: venue.name,
          venueSlug: venue.slug,
          dateISO,
          raceNo: pr.raceNo,
          name: pr.raceName,
          grade: undefined, // グレードは節タイトルから将来付与
          status: "pre",
          closeTime: pr.closeTime,
          windDir: "—",
          windSpeed: 0,
          wave: 0, // 気象は展示フェーズで反映
          inEscapeProbPre: inEscape,
          inEscapeProb: inEscape,
          inNote: `${venue.name}の基準値(${venue.inEscapeBase}%)を1号艇と対抗勢の力関係で補正した事前値です。展示確定後に更新されます。`,
          kimarite: computeKimarite(inEscape),
          kimariteNote: "事前のスリット想定は枠なり。展示ST確定後に更新されます。",
          entries: toEntries(pr, probs),
          signals: [],
          verdict: buildPreVerdict(pr, venue.name, probs, inEscape),
          updatedAt: now,
          modelVersion: "v0.2.0-baseline",
        });
      }
    }

  console.log(`[official] ${venues.length}場 ${races.length}レースをパースしました`);
  return races;
}

export class OfficialDataSource implements BoatDataSource {
  readonly label = "Official (公式配布・番組表)";

  async fetchRaces(dateISO: string): Promise<Race[]> {
    const text = await fetchBFileText(dateISO);
    return convertBText(text, dateISO);
  }
}

/* ---------------- Factory ---------------- */
export function createDataSource(): BoatDataSource {
  const mode = process.env.DATA_SOURCE_MODE ?? "mock";
  if (mode === "official") return new OfficialDataSource();
  return new MockDataSource();
}

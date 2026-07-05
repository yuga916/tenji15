/**
 * データ取得元の抽象化。
 * - MockDataSource: ダミーデータ(開発・デモ用)
 * - OfficialDataSource: 本番用の箱。2系統のデータを統合する:
 *   (a) 公式配布ファイル(番組表・競走成績: www1.mbrace.or.jp 月別配布、利用条件の明示なし)
 *   (b) 公式サイトの直前情報ページ(展示・進入・オッズ: robots.txt全許可を確認済み)
 *
 * 実装方針(規約・負荷への配慮):
 * - 配布ファイルは1日1回の取得で足りる
 * - 直前情報は「締切前のレースのみ」対象に数分間隔まで(大量アクセス禁止条項を遵守)
 * - boatrace.jpサイトポリシーの「営利目的リンクお断り」文言に留意し、
 *   公式への直リンクは張らない(出典は文言で明記)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Race } from "./types.ts";

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

/* ---------------- Official (本番・実装はフェーズ2) ---------------- */
export class OfficialDataSource implements BoatDataSource {
  readonly label = "Official (公式配布ファイル+直前情報)";

  async fetchRaces(_dateISO: string): Promise<Race[]> {
    // TODO フェーズ2で実装:
    // 1. 番組表配布ファイル(B) をダウンロード→パース(固定長テキスト。LZH解凍が必要)
    // 2. 競走成績配布ファイル(K) で前日までの結果を取り込み(答え合わせ生成)
    // 3. 締切前レースのみ、直前情報ページから展示タイム・進入・オッズを低頻度取得
    // 4. diffエンジンでシグナル生成 → Race[] に統合
    throw new Error("OfficialDataSource は未実装です。DATA_SOURCE_MODE=mock を使用してください。");
  }
}

/* ---------------- Factory ---------------- */
export function createDataSource(): BoatDataSource {
  const mode = process.env.DATA_SOURCE_MODE ?? "mock";
  if (mode === "official") return new OfficialDataSource();
  return new MockDataSource();
}

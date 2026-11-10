/**
 * データ取得を1回実行して保存する(GitHub Actions / cron から呼ぶ入口)。
 *
 * 1) 番組表(B): 当日分を取得して日別ファイルへ保存。
 *    既存データとマージし、verified済みレースは上書きしない。
 *    取得失敗時は既存データ維持→(データが全く無い場合のみ)mockへフォールバック。
 * 2) 競走成績(K)=答え合わせ: 当日(22時以降)と過去2日分のうち、
 *    未verifiedレースが残る日だけ取得を試みる。未配布(404)は正常スキップ。
 */
import { createDataSource, MockDataSource } from "./dataSource.ts";
import { fetchKFileText, NotPublishedError } from "./officialFetcher.ts";
import { parseKFile } from "./resultsParser.ts";
import { applyResults } from "./verify.ts";
import { saveDay, loadDay, migrateLegacy, listDays, getMeta, setMeta } from "./store.ts";
import type { Race } from "./types.ts";

const OFFICIAL = (process.env.DATA_SOURCE_MODE ?? "mock") === "official";

export async function runPipelineOnce(dateISO?: string): Promise<void> {
  const today = dateISO ?? jstToday();
  await migrateLegacy();

  await updateRacecards(today);
  if (OFFICIAL) {
    await updateSignals(today);
    await prefetchTomorrow(today);
    await updateResults(today);
    // 女子選手一覧(💛マーク用)。14日に1回・失敗してもパイプラインは継続
    try {
      const { refreshFemaleRacers } = await import("./femaleRacers.ts");
      await refreshFemaleRacers(today, getMeta, setMeta);
    } catch (e) { console.warn(`[female] 更新失敗(継続): ${(e as Error).message}`); }
  }
}

/**
 * シグナルフェーズ: 締切が近いレースの直前情報(展示・進入・単勝オッズ)を反映。
 * SIGNALS_MODE=official-live のときのみ稼働(デフォルトOFF)。
 * - 対象: 締切まで25分以内の未確定レース(1回の実行で最大6レース)
 * - 1レース=2リクエスト、逐次+1.5秒間隔の低負荷設計
 */
async function updateSignals(today: string): Promise<void> {
  if ((process.env.SIGNALS_MODE ?? "off") !== "official-live") return;

  const races = await loadDay(today);
  if (!races || races.length === 0) return;

  const { venueBySlug } = await import("./venues.ts");
  const { fetchHtml, beforeInfoUrl, winOddsUrl, parseBeforeInfo, parseWinOdds, parseCloseTimes } = await import("./liveFetcher.ts");
  const { applyLiveInfo } = await import("./signals.ts");

  const now = Date.now();
  const diffOf = (r: Race) => (new Date(`${r.dateISO}T${r.closeTime}:00+09:00`).getTime() - now) / 60000;
  const open = races.filter((r) => r.status !== "verified");
  // 締切前25分以内を優先。予定時刻を過ぎた直後(20分以内)のレースも、締切の遅延に備えて確認する
  const upcoming = open.filter((r) => diffOf(r) > 0 && diffOf(r) <= 25).sort((a, b) => diffOf(a) - diffOf(b));
  const justPassed = open.filter((r) => diffOf(r) <= 0 && diffOf(r) > -20).sort((a, b) => diffOf(b) - diffOf(a));
  const targets = [...upcoming, ...justPassed].slice(0, 6);
  if (targets.length === 0) return;

  let updated = 0;
  for (const race of targets) {
    const venue = venueBySlug.get(race.venueSlug);
    if (!venue) continue;
    try {
      const beforeHtml = await fetchHtml(beforeInfoUrl(venue.jcd, race.raceNo, race.dateISO));
      await sleep(1500);
      let oddsInfo = null;
      try {
        const oddsHtml = await fetchHtml(winOddsUrl(venue.jcd, race.raceNo, race.dateISO));
        oddsInfo = parseWinOdds(oddsHtml);
        for (const w of oddsInfo.warnings) console.warn(`[live] ${race.venue}${race.raceNo}R: ${w}`);
      } catch (e) {
        console.warn(`[live] ${race.venue}${race.raceNo}R: オッズ取得失敗(展示のみ反映): ${(e as Error).message}`);
      }
      // 締切の遅延: 公式の締切予定時刻で、同じ場の未確定レースの時刻を更新
      const closeTimes = parseCloseTimes(beforeHtml);
      if (closeTimes.size >= race.raceNo) {
        for (const r of races) {
          if (r.venueSlug !== race.venueSlug || r.status === "verified") continue;
          const t = closeTimes.get(r.raceNo);
          if (t && t !== r.closeTime) {
            console.log(`[live] ${r.venue}${r.raceNo}R: 締切時刻を更新 ${r.closeTime} → ${t}`);
            r.closeTime = t;
            updated++;
          }
        }
      }
      const before = parseBeforeInfo(beforeHtml);
      for (const w of before.warnings) console.warn(`[live] ${race.venue}${race.raceNo}R: ${w}`);
      if (applyLiveInfo(race, before, oddsInfo)) updated++;
      await sleep(1500);
    } catch (e) {
      console.warn(`[live] ${race.venue}${race.raceNo}R: 直前情報取得失敗(事前評価のまま): ${(e as Error).message}`);
    }
  }
  if (updated > 0) {
    await saveDay(today, races);
    console.log(`[live] ${updated}レースにシグナルを反映しました`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 翌日番組の先行取得(SEO: 前夜からページを公開してインデックスの時間を稼ぐ)。
 * 翌日分Bファイルは夕方〜夜に配布されるため17時以降のみ、かつ未取得の間だけ試行。
 */
async function prefetchTomorrow(today: string): Promise<void> {
  if (jstHour() < 17) return;
  const tomorrow = addDays(today, 1);
  const existing = await loadDay(tomorrow);
  if (existing && existing.length > 0) return; // 取得済み(当日になれば通常フローで再取得される)

  try {
    const { fetchBFileText } = await import("./officialFetcher.ts");
    const { convertBText } = await import("./dataSource.ts");
    const text = await fetchBFileText(tomorrow);
    const races = convertBText(text, tomorrow);
    await saveDay(tomorrow, races);
    console.log(`[pipeline] 翌日(${tomorrow})の番組を先行公開: ${races.length}レース`);
  } catch (e) {
    if (e instanceof NotPublishedError) {
      console.log(`[pipeline] 翌日(${tomorrow})の番組は未配布(正常スキップ)`);
    } else {
      console.warn(`[pipeline] 翌日番組の取得失敗(致命的でない): ${(e as Error).message}`);
    }
  }
}

/* ---------- 1) 番組表 ---------- */
const RACECARD_REFRESH_MIN = 20; // 番組表の再取得間隔(公式への負荷を抑える)

async function updateRacecards(today: string): Promise<void> {
  // 前回取得から20分以内なら番組表の再取得をスキップ(5分間隔cronでも負荷は従来水準)
  if (OFFICIAL) {
    const meta = await getMeta();
    const last = meta[`bfetch-${today}`];
    const existing = await loadDay(today);
    if (last && existing && existing.length > 0) {
      const ageMin = (Date.now() - new Date(last).getTime()) / 60000;
      if (ageMin < RACECARD_REFRESH_MIN) {
        console.log(`[pipeline] 番組表は${Math.round(ageMin)}分前に取得済みのためスキップ`);
        return;
      }
    }
  }

  const source = createDataSource();
  console.log(`[pipeline] 番組表取得: ${today} / ソース: ${source.label}`);

  try {
    const fresh = await source.fetchRaces(today);
    // 番組表パースの警告を診断用に保存(除外されたレースがあった時に原因を後から確認できるように)
    if (OFFICIAL) {
      const { LAST_B_WARNINGS } = await import("./dataSource.ts");
      if (LAST_B_WARNINGS.length > 0) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir("data/debug", { recursive: true });
        await writeFile(`data/debug/b-warnings-${today}.txt`, LAST_B_WARNINGS.slice(0, 300).join("\n") + "\n", "utf-8");
      }
    }
    const existing = await loadDay(today);
    const merged = mergeDay(existing, fresh);
    const file = await saveDay(today, merged);
    if (OFFICIAL) await setMeta(`bfetch-${today}`, new Date().toISOString());
    console.log(`[pipeline] ${merged.length}レースを保存: ${file}`);
    return;
  } catch (e) {
    console.error(`[pipeline] 番組表取得失敗: ${(e as Error).message}`);
  }

  // フォールバック1: 既存データがあればそのまま維持(ビルドを継続)
  const days = await listDays();
  if (days.length > 0) {
    console.warn(`[pipeline] フォールバック: 既存${days.length}日分のデータを維持します`);
    return;
  }

  // フォールバック2(mockモードのみ): mockデータを使用。
  // officialモードではダミーデータが答え合わせアーカイブに混入しないよう空で保存し、
  // 次回の取得成功を待つ(サイトは空の状態でビルドされる)。
  if (!OFFICIAL) {
    console.warn("[pipeline] フォールバック: mockデータを使用します");
    const races = await new MockDataSource().fetchRaces(today);
    await saveDay(today, races);
    return;
  }
  console.warn("[pipeline] officialモードでデータなし: 空データで継続します(mock混入を防止)");
  await saveDay(today, []);
}

/**
 * 既存データとのマージ: verified済み・直前評価済み(signal)は残し、それ以外(事前評価)は新データで更新。
 * 2026-10-08修正: 以前はverifiedのみ保持していたため、20分ごとの番組表再取得で
 * 展示反映後の直前評価(status=signal, aiProb, marketProb, signals)が事前評価で上書きされ、
 * 確定時に直前評価がほぼ残っていなかった(14,221レース中24レース)。
 */
export function mergeDay(existing: Race[] | null, fresh: Race[]): Race[] {
  if (!existing || existing.length === 0) return fresh;
  const byId = new Map(existing.map((r) => [r.raceId, r]));
  const keep = (r: Race | undefined): r is Race => !!r && (r.status === "verified" || r.status === "signal");
  const merged = fresh.map((f) => {
    const old = byId.get(f.raceId);
    return keep(old) ? old : f;
  });
  // 新データに存在しない既存レース(番組変更等)も確定・直前評価済みなら残す
  const freshIds = new Set(fresh.map((r) => r.raceId));
  for (const old of existing) {
    if (!freshIds.has(old.raceId) && keep(old)) merged.push(old);
  }
  return merged;
}

/* ---------- 2) 答え合わせ(K) ---------- */
async function updateResults(today: string): Promise<void> {
  const targets = [addDays(today, -2), addDays(today, -1)];
  // 当日分のKファイルは全レース確定後(夜)に配布されるため22時以降のみ試行
  if (jstHour() >= 22) targets.push(today);

  for (const date of targets) {
    const races = await loadDay(date);
    if (!races || races.length === 0) continue;
    const pending = races.filter((r) => r.status !== "verified");
    if (pending.length === 0) continue;

    try {
      const text = await fetchKFileText(date);
      const parsed = parseKFile(text);
      const { updated, warnings } = applyResults(races, parsed);
      for (const w of warnings.slice(0, 10)) console.warn(`[verify] 警告: ${w}`);
      if (warnings.length > 10) console.warn(`[verify] 警告 他${warnings.length - 10}件`);
      if (updated > 0) {
        await saveDay(date, races);
        console.log(`[verify] ${date}: ${updated}レースを答え合わせ済み(verified)にしました`);
      } else {
        console.log(`[verify] ${date}: 更新対象なし(パース${parsed.venues.length}場)`);
      }
    } catch (e) {
      if (e instanceof NotPublishedError) {
        console.log(`[verify] ${date}: 成績ファイルは未配布(正常スキップ)`);
      } else {
        console.error(`[verify] ${date}: 取得失敗: ${(e as Error).message}`);
      }
    }
  }
}

/* ---------- helpers ---------- */
/** JSTの今日(YYYY-MM-DD)。Actionsのランナー(UTC)でも日付がズレないように */
function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function jstHour(): number {
  return new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
}

function addDays(dateISO: string, delta: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPipelineOnce(process.argv[2]).catch((e) => {
    console.error("[pipeline] 失敗:", e);
    process.exit(1);
  });
}

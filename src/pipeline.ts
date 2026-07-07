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
import { saveDay, loadDay, migrateLegacy, listDays } from "./store.ts";
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
  const { fetchHtml, beforeInfoUrl, winOddsUrl, parseBeforeInfo, parseWinOdds } = await import("./liveFetcher.ts");
  const { applyLiveInfo } = await import("./signals.ts");

  const now = Date.now();
  const targets = races
    .filter((r) => r.status !== "verified")
    .filter((r) => {
      const close = new Date(`${r.dateISO}T${r.closeTime}:00+09:00`).getTime();
      const diffMin = (close - now) / 60000;
      return diffMin > 0 && diffMin <= 25;
    })
    .sort((a, b) => a.closeTime.localeCompare(b.closeTime))
    .slice(0, 6);
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
async function updateRacecards(today: string): Promise<void> {
  const source = createDataSource();
  console.log(`[pipeline] 番組表取得: ${today} / ソース: ${source.label}`);

  try {
    const fresh = await source.fetchRaces(today);
    const existing = await loadDay(today);
    const merged = mergeDay(existing, fresh);
    const file = await saveDay(today, merged);
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

/** 既存データとのマージ: verified済みは残し、それ以外は新データで更新 */
function mergeDay(existing: Race[] | null, fresh: Race[]): Race[] {
  if (!existing || existing.length === 0) return fresh;
  const byId = new Map(existing.map((r) => [r.raceId, r]));
  const merged = fresh.map((f) => {
    const old = byId.get(f.raceId);
    return old && old.status === "verified" ? old : f;
  });
  // 新データに存在しない既存レース(番組変更等)もverifiedなら残す
  const freshIds = new Set(fresh.map((r) => r.raceId));
  for (const old of existing) {
    if (!freshIds.has(old.raceId) && old.status === "verified") merged.push(old);
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

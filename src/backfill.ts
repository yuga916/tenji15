/**
 * 過去分の競走成績(Kファイル)バックフィル。
 *
 * 公式配布アーカイブを1日ずつ遡って取得し、生データは保存せず
 * コンパクトな集計(data/history/agg.json)に積み上げる。
 *
 * - 1回の実行で BACKFILL_DAYS 日分だけ処理(既定30日) → 夜間cronで少しずつ進む
 * - リクエスト間に2秒スリープ(配布サーバーへの配慮)
 * - 進捗カーソルは agg.json 内に保持(cursor = 次に取得する日付、過去方向へ移動)
 * - 目標: HISTORY_YEARS 年前まで(既定3年)
 *
 * 実行: node --experimental-strip-types src/backfill.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchKFileText } from "./officialFetcher.ts";
import { parseKFile } from "./resultsParser.ts";
import { VENUES } from "./venues.ts";

const ROOT = path.join(process.cwd(), "data", "history");
const AGG_PATH = path.join(ROOT, "agg.json");
const MANSHU = 10000;

export interface MonthAgg { races: number; lane1Win: number; manshu: number; }
export interface VenueAgg {
  races: number;
  laneWins: number[];      // index0=1号艇 … 枠番別1着数
  courseWins: number[];    // 実進入コース別1着数
  kimarite: Record<string, number>;
  payoutSum: number;       // 3連単払戻の合計(平均算出用)
  payoutCnt: number;
  manshu: number;          // 3連単1万円以上
  maxPayout: number;
  maxPayoutDate: string;
  byMonth: Record<string, MonthAgg>;   // "1"〜"12"
  byRaceNo: Record<string, { races: number; manshu: number; lane1Win: number }>; // "1"〜"12"
  /** 単勝回収率算出用: 勝った枠番別の単勝払戻合計と、その払戻が取れたレース数(index0=1号艇) */
  winBetSumByLane: number[];
  winBetCntByLane: number[];
  /** 風速バケット別("0-2","3-5","6+")のレース数・イン1着・万舟 */
  byWind: Record<string, MonthAgg>;
}
export interface RacerAgg {
  name: string;
  starts: number;
  wins: number;
  top2: number;
  top3: number;
  /** コース別 [starts, wins, top2] × 6 (index0=1コース) */
  byCourse: [number, number, number][];
  f: number;               // フライング数
  stSum: number;           // 本番ST合計(F除く)
  stCnt: number;
  lastDate: string;
}
export interface ManshuRecord { date: string; jcd: string; raceNo: number; amount: number; combo: string; popularity?: number; }
export interface HistoryAgg {
  version: 1;
  cursor: string;          // 次に取得する日付(過去方向)
  target: string;          // ここまで遡ったら完了
  done: boolean;
  fetchedDays: number;
  failedDates: string[];   // 取得/解析に失敗した日(再試行はしない)
  from: string;            // 集計済み範囲(古い側)
  to: string;              // 集計済み範囲(新しい側)
  races: number;
  venues: Record<string, VenueAgg>;   // key=jcd
  racers: Record<string, RacerAgg>;   // key=登番
  manshuTop: ManshuRecord[];          // 高配当トップ(最大100件)
}

const isoAddDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emptyVenueAgg(): VenueAgg {
  return {
    races: 0, laneWins: [0, 0, 0, 0, 0, 0], courseWins: [0, 0, 0, 0, 0, 0], kimarite: {},
    payoutSum: 0, payoutCnt: 0, manshu: 0, maxPayout: 0, maxPayoutDate: "",
    byMonth: {}, byRaceNo: {},
    winBetSumByLane: [0, 0, 0, 0, 0, 0], winBetCntByLane: [0, 0, 0, 0, 0, 0],
    byWind: {},
  };
}

/** 風速(m)をバケット名に変換 */
export function windBucket(speed: number | undefined): string | null {
  if (speed === undefined || Number.isNaN(speed)) return null;
  if (speed <= 2) return "0-2";
  if (speed <= 5) return "3-5";
  return "6+";
}

/** 旧スキーマのaggに新フィールドを補完(後方互換) */
export function normalizeAgg(agg: HistoryAgg): HistoryAgg {
  for (const v of Object.values(agg.venues)) {
    v.winBetSumByLane ??= [0, 0, 0, 0, 0, 0];
    v.winBetCntByLane ??= [0, 0, 0, 0, 0, 0];
    v.byWind ??= {};
  }
  return agg;
}

export async function loadAgg(): Promise<HistoryAgg | null> {
  try {
    return normalizeAgg(JSON.parse(await readFile(AGG_PATH, "utf-8")) as HistoryAgg);
  } catch {
    return null;
  }
}

function newAgg(): HistoryAgg {
  const years = Number(process.env.HISTORY_YEARS || 3);
  const start = isoAddDays(jstToday(), -8); // 直近1週間は通常パイプラインが担当
  const target = isoAddDays(jstToday(), -Math.round(years * 365.25));
  return {
    version: 1, cursor: start, target, done: false, fetchedDays: 0, failedDates: [],
    from: start, to: start, races: 0, venues: {}, racers: {}, manshuTop: [],
  };
}

/** 1日分のK解析結果を集計に反映 */
export function applyDay(agg: HistoryAgg, dateISO: string, parsed: ReturnType<typeof parseKFile>): number {
  const month = String(Number(dateISO.slice(5, 7)));
  let raceCount = 0;
  for (const v of parsed.venues) {
    const va = (agg.venues[v.jcd] ??= emptyVenueAgg());
    for (const race of v.races) {
      const winner = race.rows.find((r) => r.rank === 1);
      if (!winner) continue;
      raceCount++;
      va.races++;
      if (winner.lane >= 1 && winner.lane <= 6) va.laneWins[winner.lane - 1]++;
      if (winner.course && winner.course >= 1 && winner.course <= 6) va.courseWins[winner.course - 1]++;
      if (race.kimarite && race.kimarite !== "—") va.kimarite[race.kimarite] = (va.kimarite[race.kimarite] ?? 0) + 1;

      const p3t = race.payouts.find((p) => p.bet === "3連単");
      const pWin = race.payouts.find((p) => p.bet === "単勝" && Number(p.combo) === winner.lane);
      if (pWin && winner.lane >= 1 && winner.lane <= 6) {
        va.winBetSumByLane[winner.lane - 1] += pWin.amount;
        va.winBetCntByLane[winner.lane - 1]++;
      }
      const wb = windBucket(race.windSpeed);
      if (wb) {
        const wA = (va.byWind[wb] ??= { races: 0, lane1Win: 0, manshu: 0 });
        wA.races++;
        if (winner.lane === 1) wA.lane1Win++;
        if (p3t && p3t.amount >= MANSHU) wA.manshu++;
      }
      const mA = (va.byMonth[month] ??= { races: 0, lane1Win: 0, manshu: 0 });
      mA.races++;
      if (winner.lane === 1) mA.lane1Win++;
      const rKey = String(race.raceNo);
      const rA = (va.byRaceNo[rKey] ??= { races: 0, manshu: 0, lane1Win: 0 });
      rA.races++;
      if (winner.lane === 1) rA.lane1Win++;
      if (p3t) {
        va.payoutSum += p3t.amount;
        va.payoutCnt++;
        if (p3t.amount >= MANSHU) {
          va.manshu++;
          mA.manshu++;
          rA.manshu++;
        }
        if (p3t.amount > va.maxPayout) {
          va.maxPayout = p3t.amount;
          va.maxPayoutDate = dateISO;
        }
        if (p3t.amount >= MANSHU) {
          agg.manshuTop.push({ date: dateISO, jcd: v.jcd, raceNo: race.raceNo, amount: p3t.amount, combo: p3t.combo, popularity: p3t.popularity });
          agg.manshuTop.sort((a, b) => b.amount - a.amount);
          if (agg.manshuTop.length > 100) agg.manshuTop.length = 100;
        }
      }

      // 選手集計
      for (const row of race.rows) {
        if (!/^\d{4}$/.test(row.regNo)) continue;
        const ra = (agg.racers[row.regNo] ??= {
          name: row.name, starts: 0, wins: 0, top2: 0, top3: 0,
          byCourse: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
          f: 0, stSum: 0, stCnt: 0, lastDate: dateISO,
        });
        if (dateISO >= ra.lastDate) {
          ra.lastDate = dateISO;
          if (row.name) ra.name = row.name; // 新しい表記を採用
        }
        ra.starts++;
        if (row.rankCode === "F") ra.f++;
        if (row.st !== undefined && row.st >= 0) {
          ra.stSum += row.st;
          ra.stCnt++;
        }
        const rank = row.rank;
        if (rank === 1) ra.wins++;
        if (rank !== undefined && rank <= 2) ra.top2++;
        if (rank !== undefined && rank <= 3) ra.top3++;
        const c = row.course;
        if (c && c >= 1 && c <= 6) {
          const bc = ra.byCourse[c - 1];
          bc[0]++;
          if (rank === 1) bc[1]++;
          if (rank !== undefined && rank <= 2) bc[2]++;
        }
      }
    }
  }
  agg.races += raceCount;
  if (dateISO < agg.from) agg.from = dateISO;
  if (dateISO > agg.to) agg.to = dateISO;
  return raceCount;
}

async function main() {
  const days = Number(process.env.BACKFILL_DAYS || 30);
  const agg = (await loadAgg()) ?? newAgg();
  if (agg.done) {
    console.log(`[backfill] 完了済み(${agg.from} まで遡り済み・${agg.races}レース)。何もしません`);
    return;
  }
  await mkdir(ROOT, { recursive: true });

  let processed = 0;
  while (processed < days && !agg.done) {
    const date = agg.cursor;
    if (date <= agg.target) {
      agg.done = true;
      break;
    }
    try {
      const text = await fetchKFileText(date);
      const parsed = parseKFile(text);
      const n = applyDay(agg, date, parsed);
      agg.fetchedDays++;
      console.log(`[backfill] ${date}: ${n}レース集計 (通算${agg.races})`);
    } catch (e) {
      agg.failedDates.push(date);
      console.warn(`[backfill] ${date}: 取得失敗(スキップ) ${(e as Error).message}`);
    }
    agg.cursor = isoAddDays(date, -1);
    processed++;
    await sleep(2000);
  }

  await writeFile(AGG_PATH, JSON.stringify(agg), "utf-8");
  console.log(
    `[backfill] 保存: ${AGG_PATH} / 範囲 ${agg.from}〜${agg.to} / ${agg.races}レース / 選手${Object.keys(agg.racers).length}人` +
    (agg.done ? " / ★目標到達(完了)" : ` / 残り目標 ${agg.target}`)
  );
}

const isDirect = process.argv[1] && /backfill\.ts$/.test(process.argv[1]);
if (isDirect) {
  main().catch((e) => {
    console.error("[backfill] エラー:", e);
    process.exit(1);
  });
}

export const _internal = { VENUES };

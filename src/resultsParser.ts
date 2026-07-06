/**
 * 公式配布・競走成績(Kファイル)パーサ。
 *
 * 入力: LZH解凍後のテキスト(Shift_JISをデコード済みの文字列)
 * 出力: 場ごと・レースごとの 着順 / 決まり手 / 気象 / 払戻 の生データ
 *
 * 実ファイルの構造(概要):
 *   STARTK
 *   <JCD>KBGN        … 場ブロック開始(JCD=場コード2桁)
 *   ［成績］などのヘッダ行
 *   <N>R <レース名> H<距離>m <天候> 風 <向> <速>m 波 <高>cm
 *   着 艇 登番 選手名 ﾓｰﾀｰ ﾎﾞｰﾄ 展示 進入 ｽﾀｰﾄﾀｲﾐﾝｸﾞ ﾚｰｽﾀｲﾑ  <決まり手>
 *   ----------------------(区切り線)----------------------
 *   01 1 4444 選手名 12 44 6.72 1 0.11 1.49.9   … 6行(F/L/K/S等の着外コードあり)
 *   (払戻: 単勝/複勝/２連単/２連複/拡連複/３連単/３連複。拡連複は継続行あり)
 *   <JCD>KEND
 *   FINISHK
 *
 * 方針はBファイルパーサと同じ「寛容なパース」。固定バイト位置に依存せず、
 * 崩れた行は警告として収集する(DEBUG_PARSER=1 で未マッチ行を出力)。
 */
import { zenToHan } from "./officialParser.ts";

export interface ParsedResultRow {
  rankCode: string;     // "01"〜"06" / "F"(フライング) / "L"(出遅れ) / "K0","K1"(欠場) / "S0"〜"S2"(失格)
  rank?: number;        // 1〜6(着外コードのときはundefined)
  lane: number;         // 艇番
  regNo: string;
  name: string;
  course?: number;      // 実際の進入コース
  st?: number;          // 本番ST(秒)。F時は負値
  raceTime?: string;    // 例 "1.49.9"
}

export interface ParsedPayout {
  bet: string;          // 単勝/複勝/2連単/2連複/拡連複/3連単/3連複
  combo: string;        // 例 "1-2-3"
  amount: number;       // 円
  popularity?: number;  // 人気
}

export interface ParsedRaceResult {
  raceNo: number;
  raceName: string;
  kimarite: string;     // 逃げ/差し/まくり/まくり差し/抜き/恵まれ("—"=検出不可)
  weather?: string;
  windDir?: string;
  windSpeed?: number;   // m
  wave?: number;        // cm
  rows: ParsedResultRow[];
  payouts: ParsedPayout[];
}

export interface ParsedVenueResults {
  jcd: string;
  races: ParsedRaceResult[];
}

export interface ParseKResult {
  venues: ParsedVenueResults[];
  warnings: string[];
}

const KIMARITE_RE = /(まくり差し|まくり|逃げ|差し|抜き|恵まれ)\s*$/;
/** レースヘッダ: 「1R <レース名> H1800m <天候> 風 <向> <速>m 波 <高>cm」相当 */
const RACE_HEADER_RE = /^\s*(\d{1,2})R\s+(.*?)\s*H?\s*(\d{3,4})m\s*(.*)$/;
/** 着順行: 着順コード + 艇番 + 登番4桁 + 残り */
const ROW_RE = /^\s*(0[1-6]|[FLSK]\d?)\s+([1-6])\s+(\d{4})\s+(.*)$/;
/** 着順行の末尾数値ブロック: ﾓｰﾀｰ ﾎﾞｰﾄ 展示 進入 ST [ﾚｰｽﾀｲﾑ] */
const ROW_TAIL_RE = /(\d{1,3})\s+(\d{1,3})\s+(\d\.\d{2})\s+([1-6])\s+(F?\s?\.?\d{0,2}(?:\.\d{2})?)\s*(\d\.\d{2}\.\d)?\s*$/;
/** 払戻行(賭け式は継続行で省略されることがある) */
const PAYOUT_RE = /^\s*(単勝|複勝|2連単|2連複|拡連複|3連単|3連複)?\s+([1-6](?:[-=][1-6]){0,2})\s+([\d,]+)(?:\s+人気\s*(\d+))?\s*$/;
const BET_WORDS = ["単勝", "複勝", "2連単", "2連複", "拡連複", "3連単", "3連複"];

function parseSt(token: string): number | undefined {
  const t = token.replace(/\s+/g, "");
  const flying = /^F/.test(t);
  const m = t.match(/(\d{1,2})$/);
  if (!m) return undefined;
  const v = Number(`0.${m[1].padStart(2, "0")}`);
  return flying ? -v : v;
}

export function parseKFile(text: string): ParseKResult {
  const warnings: string[] = [];
  const venues: ParsedVenueResults[] = [];
  const debug = process.env.DEBUG_PARSER === "1";

  let currentVenue: ParsedVenueResults | null = null;
  let currentRace: ParsedRaceResult | null = null;
  let currentBet = "";

  const flushRace = () => {
    if (currentRace && currentVenue) {
      const ranked = currentRace.rows.filter((r) => r.rank !== undefined);
      if (ranked.length >= 3) {
        currentVenue.races.push(currentRace);
      } else if (currentRace.rows.length > 0) {
        warnings.push(`JCD${currentVenue.jcd} ${currentRace.raceNo}R: 着順行が${ranked.length}件(3件以上期待)のため除外`);
      }
    }
    currentRace = null;
    currentBet = "";
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = zenToHan(rawLine);

    // 場ブロック開始/終了
    const bgn = line.match(/^\s*(\d{2})KBGN/);
    if (bgn) {
      flushRace();
      currentVenue = { jcd: bgn[1], races: [] };
      continue;
    }
    if (/^\s*\d{2}KEND/.test(line)) {
      flushRace();
      if (currentVenue) venues.push(currentVenue);
      currentVenue = null;
      continue;
    }
    if (!currentVenue) continue;

    // レースヘッダ(「H1800m」を含む行のみ。払戻行等と衝突しないよう距離を必須にする)
    const rh = line.match(RACE_HEADER_RE);
    if (rh && /m/.test(line) && !BET_WORDS.some((w) => line.includes(w))) {
      flushRace();
      const tail = rh[4] ?? "";
      const wind = tail.match(/風\s*([^\s\d]*)\s*(\d+)m/);
      const wave = tail.match(/波\s*(\d+)cm/);
      const weather = tail.trim().split(/\s+/)[0];
      currentRace = {
        raceNo: Number(rh[1]),
        raceName: rh[2].trim().replace(/\s+/g, " ") || "一般戦",
        kimarite: "—",
        weather: weather && !/^風|^波/.test(weather) ? weather : undefined,
        windDir: wind?.[1] || undefined,
        windSpeed: wind ? Number(wind[2]) : undefined,
        wave: wave ? Number(wave[1]) : undefined,
        rows: [],
        payouts: [],
      };
      continue;
    }
    if (!currentRace) continue;

    // 決まり手(列見出し行の末尾に記載される)
    if (/着/.test(line) && /艇/.test(line)) {
      const km = line.match(KIMARITE_RE);
      if (km) currentRace.kimarite = km[1];
      continue;
    }

    // 着順行
    const row = line.match(ROW_RE);
    if (row) {
      const rest = row[4];
      const tail = rest.match(ROW_TAIL_RE);
      const name = (tail ? rest.slice(0, tail.index) : rest.replace(/[\d.\sFLKS]+$/, "")).replace(/\s+/g, "");
      const rankNum = /^0[1-6]$/.test(row[1]) ? Number(row[1]) : undefined;
      currentRace.rows.push({
        rankCode: row[1],
        rank: rankNum,
        lane: Number(row[2]),
        regNo: row[3],
        name,
        course: tail ? Number(tail[4]) : undefined,
        st: tail ? parseSt(tail[5]) : undefined,
        raceTime: tail?.[6],
      });
      continue;
    }

    // レース中止・不成立
    if (/レース不成立|中止/.test(line)) {
      if (debug) console.error("[kparser] 不成立/中止:", line.trim());
      continue;
    }

    // 払戻行(複勝は1行に2艇分並ぶことがあるため個別処理: 「複勝 1 110 2 150」)
    const fk = line.match(/^\s*複勝\s+([1-6])\s+([\d,]+)(?:\s+([1-6])\s+([\d,]+))?\s*$/);
    if (fk) {
      currentBet = "複勝";
      currentRace.payouts.push({ bet: "複勝", combo: fk[1], amount: Number(fk[2].replace(/,/g, "")) });
      if (fk[3] && fk[4]) {
        currentRace.payouts.push({ bet: "複勝", combo: fk[3], amount: Number(fk[4].replace(/,/g, "")) });
      }
      continue;
    }
    const pay = line.match(PAYOUT_RE);
    if (pay) {
      const bet = pay[1] ?? currentBet;
      if (!bet) continue; // 賭け式不明の数値行は無視
      currentBet = bet;
      currentRace.payouts.push({
        bet,
        combo: pay[2],
        amount: Number(pay[3].replace(/,/g, "")),
        popularity: pay[4] ? Number(pay[4]) : undefined,
      });
      continue;
    }

    if (debug && /^\s*(0[1-6]|[FLSK]\d?)\s+[1-6]\s+\d{4}/.test(line)) {
      console.error("[kparser] 着順行らしき未マッチ:", line);
      warnings.push(`着順行らしき未マッチ: ${line.slice(0, 40)}...`);
    }
  }
  flushRace();
  if (currentVenue) venues.push(currentVenue); // KEND欠落への保険

  return { venues, warnings };
}

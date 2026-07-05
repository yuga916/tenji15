/**
 * 公式配布・番組表(Bファイル)パーサ。
 *
 * 入力: LZH解凍後のテキスト(Shift_JISをデコード済みの文字列)
 * 出力: ParsedVenueDay[](場ごとのレース・出走選手の生データ)
 *
 * 実ファイルの構造(概要):
 *   STARTB
 *   <JCD>BBGN            … 場ブロック開始(JCD=場コード2桁)
 *   (節タイトル・日次などのヘッダ行)
 *   <N>Ｒ <レース名> … <距離>ｍ 電話投票締切予定<ＨＨ：ＭＭ>
 *   (列見出し行)
 *   1 <登番><氏名><年齢><支部><体重><級> <全国勝率> <全国2率> <当地勝率> <当地2率> <M番> <M2率> <B番> <B2率> …
 *   … 艇番1〜6の6行 …
 *   <JCD>BEND            … 場ブロック終了
 *   FINISHB
 *
 * 方針: 固定バイト位置に依存しない「寛容なパース」。
 * 行ごとに正規表現でマッチし、崩れた行は警告として収集する(初回実データ投入時の
 * フォーマット調整を容易にするため、DEBUG_PARSER=1 で未マッチ行を出力)。
 */

export interface ParsedRacer {
  lane: number;
  regNo: string;
  name: string;
  age: number;
  branch: string;
  weight: number;
  racerClass: string;   // A1/A2/B1/B2
  natWinRate: number;   // 全国勝率
  natTop2Rate: number;  // 全国2連率
  localWinRate: number; // 当地勝率
  localTop2Rate: number;
  motorNo: number;
  motorRate: number;    // モーター2連率
  boatNo: number;
  boatRate: number;
}

export interface ParsedRace {
  raceNo: number;
  raceName: string;
  distance: number;     // m
  closeTime: string;    // HH:mm (電話投票締切予定)
  racers: ParsedRacer[];
}

export interface ParsedVenueDay {
  jcd: string;          // 場コード "01"〜"24"
  races: ParsedRace[];
}

export interface ParseResult {
  venues: ParsedVenueDay[];
  warnings: string[];
}

/** 全角英数字・記号を半角へ */
export function zenToHan(s: string): string {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":")
    .replace(/　/g, " ");
}

/** レースヘッダ行: 「1R ... 1800m ... 電話投票締切予定 15:16」相当を検出 */
const RACE_HEADER_RE = /^\s*(\d{1,2})R\s+(.*?)\s*(?:H?\s*(\d{3,4})m)?\s*電話投票締切予定\s*(\d{1,2}):(\d{2})/;

/** 選手行: 艇番(1-6)+登番4桁+氏名(非数字)+年齢2桁+支部+体重2桁+級別、続いて数値列 */
const RACER_LINE_RE = /^\s*([1-6])\s*(\d{4})(\D+?)(\d{2})(\D+?)(\d{2})\s*(A1|A2|B1|B2)(.*)$/;

export function parseBFile(text: string): ParseResult {
  const warnings: string[] = [];
  const venues: ParsedVenueDay[] = [];
  const debug = process.env.DEBUG_PARSER === "1";

  let currentVenue: ParsedVenueDay | null = null;
  let currentRace: ParsedRace | null = null;

  const flushRace = () => {
    if (currentRace && currentVenue) {
      if (currentRace.racers.length === 6) {
        currentVenue.races.push(currentRace);
      } else if (currentRace.racers.length > 0) {
        warnings.push(`JCD${currentVenue.jcd} ${currentRace.raceNo}R: 選手行が${currentRace.racers.length}件(6件期待)のため除外`);
      }
    }
    currentRace = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = zenToHan(rawLine);

    // 場ブロック開始/終了
    const bgn = line.match(/^\s*(\d{2})BBGN/);
    if (bgn) {
      flushRace();
      currentVenue = { jcd: bgn[1], races: [] };
      continue;
    }
    if (/^\s*\d{2}BEND/.test(line)) {
      flushRace();
      if (currentVenue) venues.push(currentVenue);
      currentVenue = null;
      continue;
    }
    if (!currentVenue) continue;

    // レースヘッダ
    const rh = line.match(RACE_HEADER_RE);
    if (rh) {
      flushRace();
      currentRace = {
        raceNo: Number(rh[1]),
        raceName: rh[2].trim().replace(/\s+/g, " ") || "一般戦",
        distance: rh[3] ? Number(rh[3]) : 1800,
        closeTime: `${rh[4].padStart(2, "0")}:${rh[5]}`,
        racers: [],
      };
      continue;
    }

    // 選手行
    if (currentRace) {
      const rm = line.match(RACER_LINE_RE);
      if (rm) {
        const rest = rm[8];
        // 残り部分から数値トークンを順に取得:
        // 全国勝率, 全国2率, 当地勝率, 当地2率, M番, M2率, B番, B2率
        const nums = [...rest.matchAll(/\d+\.\d+|\d+/g)].map((m) => m[0]);
        if (nums.length < 8) {
          warnings.push(`選手行の数値不足(${nums.length}/8): ${line.slice(0, 40)}...`);
          if (debug) console.error("[parser] 数値不足:", line);
          continue;
        }
        currentRace.racers.push({
          lane: Number(rm[1]),
          regNo: rm[2],
          name: rm[3].replace(/\s+/g, ""),
          age: Number(rm[4]),
          branch: rm[5].trim(),
          weight: Number(rm[6]),
          racerClass: rm[7],
          natWinRate: Number(nums[0]),
          natTop2Rate: Number(nums[1]),
          localWinRate: Number(nums[2]),
          localTop2Rate: Number(nums[3]),
          motorNo: Number(nums[4]),
          motorRate: Number(nums[5]),
          boatNo: Number(nums[6]),
          boatRate: Number(nums[7]),
        });
        continue;
      }
      if (debug && /^\s*[1-6]\s*\d{4}/.test(line)) {
        console.error("[parser] 選手行らしき未マッチ:", line);
        warnings.push(`選手行らしき未マッチ: ${line.slice(0, 40)}...`);
      }
    }
  }
  flushRace();
  if (currentVenue) venues.push(currentVenue); // BEND欠落への保険

  return { venues, warnings };
}

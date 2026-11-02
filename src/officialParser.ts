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
  seriesTitle?: string; // 節タイトル(例: "SG第36回グランドチャンピオン決定戦競走")
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

/**
 * 選手行の数値部分を [全国勝率, 全国2率, 当地勝率, 当地2率, M番, M2率, B番, B2率] に解釈する。
 * 勝率欄が空欄(新人・当地初出走など)でも、モーター/ボート欄の並び(整数 小数 整数 小数)を手がかりに位置を合わせる。
 */
export function parseRacerNumbers(rest: string): { v: number[]; filled: boolean } | null {
  // 勝率・2連率は小数2桁固定。固定幅の列で番号(3桁)が直後に連結されることがある(例: "23.28170" = 23.28 と 170)ため小数は2桁で区切る
  const toks = [...rest.matchAll(/\d+\.\d{2}|\d+/g)].map((m) => m[0]);
  const isDec = (t?: string) => t !== undefined && t.includes(".");
  const isInt = (t?: string) => t !== undefined && !t.includes(".");
  for (let k = 0; k + 3 < toks.length; k++) {
    if (!(isInt(toks[k]) && isDec(toks[k + 1]) && isInt(toks[k + 2]) && isDec(toks[k + 3]))) continue;
    const head = toks.slice(0, k);
    if (head.some(isInt)) continue; // 勝率欄に整数が混ざる=位置がずれている
    const d = head.map(Number);
    let nat = [0, 0], loc = [0, 0];
    if (d.length >= 4) { nat = [d[0], d[1]]; loc = [d[2], d[3]]; }
    else if (d.length >= 2) { nat = [d[0], d[1]]; }
    else if (d.length !== 0) continue;
    const v = [nat[0], nat[1], loc[0], loc[1], Number(toks[k]), Number(toks[k + 1]), Number(toks[k + 2]), Number(toks[k + 3])];
    return { v, filled: d.length < 4 };
  }
  return null;
}

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

    // 節タイトル(最初のレースヘッダより前の行から検出。SG/G1〜G3/記念等を含む行)
    if (!currentVenue.seriesTitle && currentVenue.races.length === 0 && !currentRace) {
      const t = line.trim().replace(/\s+/g, " ");
      if (
        t.length >= 6 &&
        !/番組表|電話投票|ボートレース場|BGN|BEND/.test(t) &&
        /(SG|PG[1Ⅰ]|G[ⅠⅡⅢ123]|グランプリ|ダービー|クラシック|メモリアル|オールスター|チャンピオン|周年|記念|カップ|杯|女王|クイーン)/.test(t)
      ) {
        currentVenue.seriesTitle = t;
      }
    }

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
        // 残り部分の数値列: 全国勝率, 全国2率, 当地勝率, 当地2率, M番, M2率, B番, B2率
        // 新人・初出走の場など、勝率欄が空欄の選手もいるため「M番(整数) M2率(小数) B番(整数) B2率(小数)」の並びを
        // 基準に位置を決め、手前の小数の数で全国/当地の有無を判断する(空欄は0扱い)
        const nums = parseRacerNumbers(rest);
        if (!nums) {
          warnings.push(`選手行の数値を解釈できず: ${line.slice(0, 60)}...`);
          if (debug) console.error("[parser] 数値不足:", line);
          continue;
        }
        if (nums.filled) warnings.push(`選手行の勝率欄が空欄(0として扱う): ${line.slice(0, 40)}...`);
        currentRace.racers.push({
          lane: Number(rm[1]),
          regNo: rm[2],
          name: rm[3].replace(/\s+/g, ""),
          age: Number(rm[4]),
          branch: rm[5].trim(),
          weight: Number(rm[6]),
          racerClass: rm[7],
          natWinRate: nums.v[0],
          natTop2Rate: nums.v[1],
          localWinRate: nums.v[2],
          localTop2Rate: nums.v[3],
          motorNo: nums.v[4],
          motorRate: nums.v[5],
          boatNo: nums.v[6],
          boatRate: nums.v[7],
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

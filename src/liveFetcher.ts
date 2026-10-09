/**
 * 直前情報の取得+寛容パース(シグナルフェーズ)。
 *
 * 取得元: BOATRACE公式の直前情報ページ・単勝オッズページ(HTML)。
 * - 締切が近いレースのみ・1レースあたり2リクエスト・逐次+間隔つきの低負荷設計
 * - SIGNALS_MODE=official-live のときだけ pipeline から呼ばれる(デフォルトOFF)
 * - DOM構造は変わり得るため、固定構造に依存しない正規表現ベースの寛容パース。
 *   パースできない場合は警告を返し、レースは事前評価のまま(フェイルセーフ)
 * - DEBUG_LIVE=1 で未マッチ時のHTML断片を出力
 */

export interface LiveBeforeInfo {
  exTimes: Map<number, number>;   // 艇番 → 展示タイム
  courses: number[];              // スタート展示の進入順(コース1から艇番を並べる)
  exSts: Map<number, number>;     // 艇番 → 展示ST(Fはマイナス)
  weather?: string;
  windSpeed?: number;             // m
  wave?: number;                  // cm
  /** 艇番 → 当日体重(kg) */
  weights?: Map<number, number>;
  /** 艇番 → チルト角度(未公開なら無し) */
  tilts?: Map<number, number>;
  /** 艇番 → 部品交換の一覧(例: ["リング×1"]) */
  parts?: Map<number, string[]>;
  /** 新プロペラに交換した艇番 */
  newProps?: Set<number>;
  /** 艇番 → 調整重量(kg) */
  adjWeights?: Map<number, number>;
  warnings: string[];
}

export interface LiveWinOdds {
  odds: Map<number, number>;      // 艇番 → 単勝オッズ
  warnings: string[];
}

const BASE = "https://www.boatrace.jp/owpc/pc/race";
const UA = "kyotei-chokuzen/0.1 (pre-race analysis; low-frequency; contact via site)";

export function beforeInfoUrl(jcd: string, raceNo: number, dateISO: string): string {
  return `${BASE}/beforeinfo?rno=${raceNo}&jcd=${jcd}&hd=${dateISO.replace(/-/g, "")}`;
}
export function winOddsUrl(jcd: string, raceNo: number, dateISO: string): string {
  return `${BASE}/oddstf?rno=${raceNo}&jcd=${jcd}&hd=${dateISO.replace(/-/g, "")}`;
}

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`取得失敗 ${res.status}: ${url}`);
  return res.text();
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** 直前情報HTMLのパース */
export function parseBeforeInfo(html: string): LiveBeforeInfo {
  const warnings: string[] = [];
  const debug = process.env.DEBUG_LIVE === "1";
  const exTimes = new Map<number, number>();
  const exSts = new Map<number, number>();
  const courses: number[] = [];

  // 1) 展示タイム: 艇色クラス(is-boatColor{n})を含むブロックごとに 6.xx〜7.xx を探す
  //    体重(xx.xkg)・チルト(-0.5等)と区別するため 5.80〜7.80 の範囲に限定
  const blocks = html.split(/(?=is-boatColor[1-6])/);
  for (const block of blocks) {
    const mLane = block.match(/is-boatColor([1-6])/);
    if (!mLane) continue;
    const lane = Number(mLane[1]);
    if (exTimes.has(lane)) continue;
    const text = stripTags(block.slice(0, 2000));
    const nums = [...text.matchAll(/\b([5-7]\.\d{2})\b/g)].map((m) => Number(m[1]));
    const candidate = nums.find((v) => v >= 5.8 && v <= 7.8);
    if (candidate !== undefined) exTimes.set(lane, candidate);
  }
  if (exTimes.size === 0) {
    warnings.push("展示タイムを検出できませんでした");
    if (debug) console.error("[live] 展示タイム未検出。HTML先頭:", stripTags(html).slice(0, 300));
  }

  // 2) スタート展示: boatImage1Number(進入順の艇番) と boatImage1Time(展示ST)
  const numRe = /boatImage1Number[^>]*>([1-6])</g;
  for (const m of html.matchAll(numRe)) courses.push(Number(m[1]));
  const stRe = /boatImage1Time[^>]*>\s*(F?\s*\.\d{2}|L)\s*</g;
  const sts: (number | undefined)[] = [];
  for (const m of html.matchAll(stRe)) {
    const t = m[1].replace(/\s/g, "");
    if (t === "L") { sts.push(undefined); continue; }
    const v = Number(`0${t.replace("F", "")}`);
    sts.push(t.startsWith("F") ? -v : v);
  }
  if (courses.length === 6) {
    courses.forEach((lane, i) => {
      const st = sts[i];
      if (st !== undefined) exSts.set(lane, st);
    });
  } else if (courses.length > 0) {
    warnings.push(`スタート展示の進入検出が${courses.length}艇(6艇期待)`);
  }

  // 2.5) 体重・チルト・プロペラ・部品交換・調整重量(艇ごとの tbody 単位で寛容パース)
  //  公式の表は「枠 / 写真 / 氏名 / 体重 / 展示タイム / チルト / プロペラ / 部品交換 …」。
  //  列位置の変化に強くするため、展示タイムのセルを基準に「次のセル=チルト、その次=プロペラ」と読む。
  const weights = new Map<number, number>();
  const tilts = new Map<number, number>();
  const parts = new Map<number, string[]>();
  const newProps = new Set<number>();
  const adjWeights = new Map<number, number>();
  const z2h = (t: string) => t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/×/g, "×");
  for (const tb of html.split(/<tbody/i).slice(1)) {
    const body = tb.split(/<\/tbody>/i)[0];
    const mLane = body.match(/is-boatColor([1-6])/);
    if (!mLane) continue;
    const lane = Number(mLane[1]);
    const rows = body.split(/<\/tr>/i);
    const cells = [...(rows[0] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]).replace(/&nbsp;/g, " ").trim());
    const w = cells.map((c) => c.match(/^(\d{2,3}\.\d)\s*kg$/)).find(Boolean);
    if (w) weights.set(lane, Number(w[1]));
    const exIdx = cells.findIndex((c) => /^[5-7]\.\d{2}$/.test(c) && Number(c) >= 5.8 && Number(c) <= 7.8);
    if (exIdx >= 0) {
      const tilt = cells[exIdx + 1];
      if (tilt !== undefined && /^-?\d\.\d$/.test(tilt)) tilts.set(lane, Number(tilt));
      const prop = cells[exIdx + 2];
      if (prop && /新/.test(prop)) newProps.add(lane);
    }
    const ps = [...body.matchAll(/class="label\d[^"]*"[^>]*>([^<]+)</g)].map((m) => z2h(m[1].trim())).filter(Boolean);
    if (ps.length > 0) parts.set(lane, ps);
    // 調整重量: 3行目先頭のセル(数値)
    const r3 = rows[2] ? [...rows[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]).trim()) : [];
    if (r3[0] && /^\d+(\.\d)?$/.test(r3[0])) adjWeights.set(lane, Number(r3[0]));
  }

  // 3) 気象
  const text = stripTags(html);
  const wind = text.match(/風速\s*(\d+)\s*m/) ?? text.match(/\b(\d+)m\b/);
  const wave = text.match(/波高?\s*(\d+)\s*cm/) ?? text.match(/\b(\d+)cm\b/);
  const weather = text.match(/(晴|曇|雨|雪|霧)/);

  return {
    exTimes,
    courses: courses.length === 6 ? courses : [],
    exSts,
    weather: weather?.[1],
    windSpeed: wind ? Number(wind[1]) : undefined,
    wave: wave ? Number(wave[1]) : undefined,
    weights,
    tilts,
    parts,
    newProps,
    adjWeights,
    warnings,
  };
}

/** 単勝オッズHTMLのパース */
export function parseWinOdds(html: string): LiveWinOdds {
  const warnings: string[] = [];
  const odds = new Map<number, number>();

  // 単勝オッズ: 艇色クラスの近傍にある「x.x」(1.0〜99.9)を拾う
  const blocks = html.split(/(?=is-boatColor[1-6])/);
  for (const block of blocks) {
    const mLane = block.match(/is-boatColor([1-6])/);
    if (!mLane) continue;
    const lane = Number(mLane[1]);
    if (odds.has(lane)) continue;
    const text = stripTags(block.slice(0, 1200));
    if (/欠場|取消/.test(text)) continue;
    const m = text.match(/\b(\d{1,2}\.\d)\b/);
    if (m) {
      const v = Number(m[1]);
      if (v >= 1.0 && v <= 99.9) odds.set(lane, v);
    }
  }
  if (odds.size < 4) warnings.push(`単勝オッズの検出が${odds.size}艇のみ(歪み計算をスキップ)`);
  return { odds, warnings };
}

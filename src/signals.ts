/**
 * シグナルエンジン(直前フェーズの本体)。
 * 展示航走・進入・単勝オッズをRaceへ反映し、pre → signal に遷移させる。
 *
 * 反映内容:
 * - 展示タイム → レース内偏差値化(exDev)、AI勝率を補正(aiProb)
 * - スタート展示の進入 → 前づけ検知時はコース基準で全艇再計算(formationシグナル)
 * - 単勝オッズ → 市場勝率を逆算(marketProb)、AIとの乖離=歪み(gapシグナル)
 * - 気象の実測反映、イン逃げ確率・展開確率・結論文の更新
 * 断定表現は使わない(景表法配慮)。
 */
import type { Race, Entry, Signal } from "./types.ts";
import type { LiveBeforeInfo, LiveWinOdds } from "./liveFetcher.ts";

const LANE_BASE: Record<number, number> = { 1: 0.55, 2: 0.14, 3: 0.12, 4: 0.10, 5: 0.06, 6: 0.03 };
const GAP_THRESHOLD = 0.07;   // 歪みシグナル点灯の閾値
const EXDEV_THRESHOLD = 1.3;  // 展示偏差シグナルの閾値(σ)
const EX_COEF = 0.35;         // 展示偏差のAI勝率への影響係数

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function jstNowHHMM(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 直前情報をRaceへ適用。何かしら反映できたらtrue */
export function applyLiveInfo(race: Race, before: LiveBeforeInfo, oddsInfo: LiveWinOdds | null): boolean {
  const time = jstNowHHMM();
  const signals: Signal[] = [];
  let applied = false;

  // ---- 1) 気象 ----
  if (before.windSpeed !== undefined) { race.windSpeed = before.windSpeed; applied = true; }
  if (before.wave !== undefined) race.wave = before.wave;
  if (before.weather) race.windDir = race.windDir === "—" ? before.weather : race.windDir;

  // ---- 2) 展示タイム → 偏差値(レース内z) ----
  const times = [...before.exTimes.values()];
  if (times.length >= 5) {
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const sd = Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length) || 0.01;
    for (const e of race.entries) {
      const t = before.exTimes.get(e.lane);
      if (t === undefined) continue;
      e.exTime = t;
      e.exDev = Math.round(((mean - t) / sd) * 10) / 10; // 速いほどプラス
    }
    applied = true;
  }

  // ---- 3) 進入(前づけ検知) ----
  let courseChanged = false;
  if (before.courses.length === 6) {
    before.courses.forEach((lane, i) => {
      const e = race.entries.find((x) => x.lane === lane);
      if (!e) return;
      const course = i + 1;
      if (e.course !== undefined && e.course !== course) courseChanged = true;
      if (e.lane !== course) courseChanged = true;
      e.course = course;
      const st = before.exSts.get(lane);
      if (st !== undefined) e.exSt = st;
    });
    applied = true;
  }

  // ---- 4) AI勝率の再計算(コース基準 × 展示偏差) ----
  const raw = race.entries.map((e) => {
    const base = LANE_BASE[e.course ?? e.lane] ?? 0.05;
    const pre = Math.max(e.preProb, 0.01);
    const laneBasePre = LANE_BASE[e.lane] ?? 0.05;
    const skill = pre / laneBasePre; // 事前評価が枠基準に対して持つ個人力
    const exBoost = e.exDev !== undefined ? Math.exp(EX_COEF * Math.max(-2.5, Math.min(2.5, e.exDev))) : 1;
    return base * skill * exBoost;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  race.entries.forEach((e, i) => (e.aiProb = round3(raw[i] / sum)));

  // ---- 5) 市場勝率(単勝オッズ逆算)と歪み ----
  if (oddsInfo && oddsInfo.odds.size >= 4) {
    const inv = new Map<number, number>();
    for (const [lane, o] of oddsInfo.odds) inv.set(lane, 1 / o);
    const invSum = [...inv.values()].reduce((a, b) => a + b, 0);
    for (const e of race.entries) {
      const v = inv.get(e.lane);
      e.marketProb = v !== undefined ? round3(v / invSum) : undefined;
    }
    applied = true;
  }

  // ---- 6) シグナル生成 ----
  for (const e of race.entries) {
    if (e.exDev !== undefined && Math.abs(e.exDev) >= EXDEV_THRESHOLD) {
      signals.push({
        time,
        type: "extime",
        impact: e.exDev > 0 ? "up" : "down",
        text: `${e.lane}号艇・${e.name}の展示タイムがレース内偏差${e.exDev > 0 ? "+" : ""}${e.exDev}σ。当日気配が${e.exDev > 0 ? "上向き" : "下向き"}のサイン。`,
      });
    }
  }
  if (courseChanged) {
    const moved = race.entries.filter((e) => e.course !== undefined && e.course !== e.lane);
    const desc = moved.map((e) => `${e.lane}号艇→${e.course}コース`).join("、");
    signals.push({
      time,
      type: "formation",
      impact: "neutral",
      text: `進入が枠なりから変化(${desc})。全艇の勝率をコース基準で再計算しました。`,
    });
  }
  for (const e of race.entries) {
    if (e.marketProb === undefined) continue;
    const gap = e.aiProb - e.marketProb;
    if (gap >= GAP_THRESHOLD) {
      signals.push({
        time,
        type: "gap",
        impact: "up",
        text: `${e.lane}号艇・${e.name}: AI評価${Math.round(e.aiProb * 100)}%に対し市場は${Math.round(e.marketProb * 100)}%。+${Math.round(gap * 100)}ptの歪み(市場が織り込んでいない可能性)。`,
      });
    } else if (gap <= -GAP_THRESHOLD) {
      signals.push({
        time,
        type: "gap",
        impact: "down",
        text: `${e.lane}号艇・${e.name}: 市場${Math.round(e.marketProb * 100)}%に対しAI評価は${Math.round(e.aiProb * 100)}%。過剰人気の可能性。`,
      });
    }
  }

  // ---- 7) イン逃げ確率・展開確率・結論の更新 ----
  const lane1 = race.entries.find((e) => e.lane === 1);
  if (lane1) {
    let inEsc = race.inEscapeProbPre;
    if (lane1.course !== undefined && lane1.course !== 1) {
      inEsc = Math.round(inEsc * 0.45); // インを失った
    } else {
      if (lane1.exDev !== undefined) inEsc += Math.round(lane1.exDev * 4);
      if (courseChanged) inEsc -= 3;
    }
    race.inEscapeProb = Math.min(90, Math.max(15, inEsc));
    const nige = race.inEscapeProb / 100;
    const rest = 1 - nige;
    race.kimarite = {
      nige: Math.round(nige * 100) / 100,
      makuri: Math.round(rest * 0.45 * 100) / 100,
      sashi: Math.round(rest * 0.42 * 100) / 100,
      other: Math.round(rest * 0.13 * 100) / 100,
    };
    race.kimariteNote = courseChanged
      ? "進入変化を反映した展開確率です。"
      : "展示ST・展示タイムを反映した展開確率です。";
    race.inNote = `事前${race.inEscapeProbPre}%から展示反映で${race.inEscapeProb}%に更新。${
      lane1.exDev !== undefined ? `1号艇の展示偏差は${lane1.exDev > 0 ? "+" : ""}${lane1.exDev}σ。` : ""
    }`;
  }

  const best = [...race.entries].sort((a, b) => b.aiProb - a.aiProb)[0];
  const gapTop = race.entries
    .filter((e) => e.marketProb !== undefined)
    .sort((a, b) => (b.aiProb - (b.marketProb ?? 0)) - (a.aiProb - (a.marketProb ?? 0)))[0];
  const gapNote =
    gapTop && gapTop.marketProb !== undefined && gapTop.aiProb - gapTop.marketProb >= GAP_THRESHOLD
      ? `妙味は${gapTop.lane}号艇・${gapTop.name}(歪み+${Math.round((gapTop.aiProb - gapTop.marketProb) * 100)}pt)。`
      : "市場と AI の評価に大きな歪みは検出されていません。";
  race.verdict =
    `直前最終評価: 本命候補は${best.lane}号艇・${best.name}(展示反映後AI勝率${Math.round(best.aiProb * 100)}%)。` +
    gapNote +
    `イン逃げ確率は${race.inEscapeProb}%。オッズは締切まで変動します。`;

  if (applied) {
    race.signals = signals;
    race.status = "signal";
    race.updatedAt = new Date().toISOString();
    race.modelVersion = "v0.3.0-live";
  }
  return applied;
}

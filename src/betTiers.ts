/**
 * 買い目の段階表示(本命/対抗/穴)。
 * - AI勝率(単勝確率)から、Harville式で3連単120通りの推定確率を出し、段階ごとに選ぶ
 *   本命: 推定確率の上位3点 / 対抗: AI評価2位の艇が1着の上位3点 / 穴: AI上位2艇以外が1着の上位2点
 * - 絞り込み: AI本命の勝率が高いレースは本命の上位2点を「絞るなら」として併記
 * - 過去の確定レースに同じ選び方を当てはめた的中率・回収率を集計して正直に併記する
 */
import type { Race } from "./types.ts";

export type Combo = { lanes: [number, number, number]; prob: number };
export type TierKey = "honmei" | "taikou" | "ana" | "shibori";
export interface Tiers { honmei: Combo[]; taikou: Combo[]; ana: Combo[]; shibori: Combo[] | null }
export interface TierStat { n: number; hit: number; ret: number; points: number }
export type TierStats = Record<TierKey, TierStat>;

/** 絞り込み(2点)を出すAI本命勝率のしきい値 */
export const SHIBORI_MIN = 0.7;

/** Harville式: P(i,j,k) = p_i · p_j/(1−p_i) · p_k/(1−p_i−p_j) */
export function trifectaProbs(probs: Map<number, number>): Combo[] {
  const lanes = [...probs.keys()];
  const sum = lanes.reduce((s, l) => s + Math.max(0, probs.get(l) ?? 0), 0) || 1;
  const p = new Map(lanes.map((l) => [l, Math.max(0, probs.get(l) ?? 0) / sum]));
  const out: Combo[] = [];
  for (const i of lanes) for (const j of lanes) for (const k of lanes) {
    if (i === j || j === k || i === k) continue;
    const pi = p.get(i)!, pj = p.get(j)!, pk = p.get(k)!;
    const d1 = 1 - pi, d2 = 1 - pi - pj;
    if (d1 <= 0 || d2 <= 0) continue;
    out.push({ lanes: [i, j, k], prob: pi * (pj / d1) * (pk / d2) });
  }
  return out.sort((a, b) => b.prob - a.prob || a.lanes.join("").localeCompare(b.lanes.join("")));
}

export function buildTiers(r: Race): Tiers | null {
  if (r.entries.length < 3) return null;
  const order = [...r.entries].sort((a, b) => b.aiProb - a.aiProb || a.lane - b.lane);
  const top1 = order[0].lane, top2 = order[1].lane;
  const all = trifectaProbs(new Map(r.entries.map((e) => [e.lane, e.aiProb])));
  const honmei = all.slice(0, 3);
  const used = new Set(honmei.map((c) => c.lanes.join("-")));
  const taikou = all.filter((c) => c.lanes[0] === top2 && !used.has(c.lanes.join("-"))).slice(0, 3);
  const ana = all.filter((c) => c.lanes[0] !== top1 && c.lanes[0] !== top2 && !used.has(c.lanes.join("-"))).slice(0, 2);
  const shibori = order[0].aiProb >= SHIBORI_MIN ? honmei.slice(0, 2) : null;
  return { honmei, taikou, ana, shibori };
}

const emptyStat = (points: number): TierStat => ({ n: 0, hit: 0, ret: 0, points });

/** 確定レースに同じ選び方を当てはめた成績(払戻は100円あたり、ret=払戻合計) */
export function collectTierStats(races: Race[]): TierStats {
  const s: TierStats = { honmei: emptyStat(3), taikou: emptyStat(3), ana: emptyStat(2), shibori: emptyStat(2) };
  for (const r of races) {
    if (r.status !== "verified" || !r.result || r.result.finish.length < 3 || !(r.result.payout3t > 0)) continue;
    const t = buildTiers(r);
    if (!t) continue;
    const win = r.result.finish.slice(0, 3).join("-");
    const add = (k: TierKey, combos: Combo[]) => {
      s[k].n++;
      if (combos.some((c) => c.lanes.join("-") === win)) { s[k].hit++; s[k].ret += r.result!.payout3t; }
    };
    add("honmei", t.honmei);
    if (t.taikou.length === 3) add("taikou", t.taikou);
    if (t.ana.length === 2) add("ana", t.ana);
    if (t.shibori) add("shibori", t.shibori);
  }
  return s;
}

/** 的中率(%)・回収率(%)。データ不足ならnull */
export function rates(st: TierStat): { hit: number; ret: number } | null {
  if (st.n < 30) return null;
  return { hit: (st.hit / st.n) * 100, ret: st.ret / (st.n * st.points) };
}

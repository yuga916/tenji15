/**
 * ベースライン評価モデル(事前評価フェーズ)。
 * 番組表の静的データ(コース・級別・全国勝率・モーター2連率)から
 * 各艇の事前勝率(preProb)とイン逃げ確率を算出する。
 *
 * ここは意図的にシンプルな加重モデル。展示反映(シグナル)フェーズと
 * 過去データでの学習モデルは後続フェーズで差し替える。
 * 係数はコース別の全国的な水準を初期値とし、答え合わせの蓄積で更新予定。
 */
import type { ParsedRace, ParsedRacer } from "./officialParser.ts";
import type { Entry, KimariteProb } from "./types.ts";
import type { VenueInfo } from "./venues.ts";

/** コース別の基準勝率(全国水準の概算・枠なり想定) */
const LANE_BASE: Record<number, number> = { 1: 0.55, 2: 0.14, 3: 0.12, 4: 0.10, 5: 0.06, 6: 0.03 };

/** 級別の強さ係数 */
const CLASS_COEF: Record<string, number> = { A1: 1.25, A2: 1.05, B1: 0.9, B2: 0.7 };

/** 選手個力スコア(0.5〜1.5程度): 全国勝率とモーター2連率の合成 */
function racerScore(r: ParsedRacer): number {
  const win = Math.min(Math.max(r.natWinRate, 2), 8);      // 2.00〜8.00に丸め
  const winNorm = 0.6 + ((win - 2) / 6) * 0.8;             // 0.6〜1.4
  const motor = Math.min(Math.max(r.motorRate, 15), 60);   // 15〜60%に丸め
  const motorNorm = 0.85 + ((motor - 15) / 45) * 0.3;      // 0.85〜1.15
  const cls = CLASS_COEF[r.racerClass] ?? 1.0;
  return winNorm * motorNorm * cls;
}

/** 各艇の事前勝率を算出(合計1に正規化) */
export function computePreProbs(race: ParsedRace): number[] {
  const raw = race.racers.map((r) => (LANE_BASE[r.lane] ?? 0.05) * racerScore(r));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
}

/** イン逃げ確率(%): 場の基準値を1号艇と対抗勢の力関係で補正 */
export function computeInEscape(race: ParsedRace, venue: VenueInfo, probs: number[]): number {
  const lane1 = race.racers.find((r) => r.lane === 1);
  if (!lane1) return venue.inEscapeBase;
  const s1 = racerScore(lane1);
  const rivals = race.racers.filter((r) => r.lane !== 1);
  const sR = rivals.reduce((a, r) => a + racerScore(r), 0) / Math.max(rivals.length, 1);
  const ratio = s1 / sR; // 1.0=互角
  const adjusted = venue.inEscapeBase * (0.6 + 0.4 * ratio) * (0.7 + probs[0] * 0.75);
  return Math.round(Math.min(85, Math.max(20, adjusted)));
}

/** 展開確率(事前): イン逃げ確率から残りを配分 */
export function computeKimarite(inEscape: number): KimariteProb {
  const nige = inEscape / 100;
  const rest = 1 - nige;
  return {
    nige: round2(nige),
    makuri: round2(rest * 0.45),
    sashi: round2(rest * 0.42),
    other: round2(rest * 0.13),
  };
}

/** 事前評価の結論文を生成(断定表現を避ける) */
export function buildPreVerdict(race: ParsedRace, venueName: string, probs: number[], inEscape: number): string {
  const idx = probs.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]);
  const top = race.racers[idx[0][1]];
  const second = race.racers[idx[1][1]];
  return (
    `事前評価: ${venueName}のイン逃げ確率は${inEscape}%想定。` +
    `本命候補は${top.lane}号艇・${top.name}(${top.racerClass}・事前勝率${Math.round(probs[idx[0][1]] * 100)}%)、` +
    `対抗は${second.lane}号艇・${second.name}(同${Math.round(probs[idx[1][1]] * 100)}%)。` +
    `これは展示前の暫定です。締切15分前の展示反映後、歪みが出ればシグナルが点灯します。`
  );
}

/** Entry配列へ変換 */
export function toEntries(race: ParsedRace, probs: number[]): Entry[] {
  return race.racers.map((r, i) => ({
    lane: r.lane,
    name: r.name,
    racerClass: r.racerClass,
    stAvg: 0, // BファイルにSTはないため0(展示フェーズ・選手マスタで補完予定)
    natWinRate: r.natWinRate,
    motorRate: r.motorRate,
    preProb: round3(probs[i]),
    aiProb: round3(probs[i]), // 展示前はpre=ai
  }));
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

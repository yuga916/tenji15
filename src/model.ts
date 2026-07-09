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

/** 級別の強さ(レーティングへの加点) */
const CLASS_BONUS: Record<string, number> = { A1: 0.3, A2: 0.05, B1: -0.05, B2: -0.35 };

/** レーティングの影響係数(大きいほど個力差が枠の差を覆しやすい) */
const RATING_COEF = 0.4;

/** レース内偏差値(z-score)化 */
function zScores(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  if (sd < 1e-6) return values.map(() => 0);
  return values.map((v) => Math.max(-2.2, Math.min(2.2, (v - mean) / sd)));
}

/**
 * 多因子レーティング(レース内相対評価)。
 * 全国勝率を主軸に、当地勝率(水面相性)・全国2連率(安定感)・モーター・ボート・級別を合成。
 */
export function computeRatings(race: ParsedRace): number[] {
  const zNatWin = zScores(race.racers.map((r) => r.natWinRate));
  const zLocal = zScores(race.racers.map((r) => (r.localWinRate > 0 ? r.localWinRate : r.natWinRate)));
  const zTop2 = zScores(race.racers.map((r) => r.natTop2Rate));
  const zMotor = zScores(race.racers.map((r) => r.motorRate));
  const zBoat = zScores(race.racers.map((r) => r.boatRate));
  return race.racers.map(
    (r, i) =>
      1.0 * zNatWin[i] +
      0.45 * zLocal[i] +
      0.35 * zTop2[i] +
      0.4 * zMotor[i] +
      0.15 * zBoat[i] +
      (CLASS_BONUS[r.racerClass] ?? 0)
  );
}

/** 会場補正済みのコース基準値(イン天国/難水面で1コースの前提を変える) */
function venueLaneBase(lane: number, venue?: VenueInfo): number {
  const base = LANE_BASE[lane] ?? 0.05;
  if (!venue) return base;
  const b1 = Math.min(0.68, Math.max(0.4, LANE_BASE[1] * (venue.inEscapeBase / 55)));
  if (lane === 1) return b1;
  return base * ((1 - b1) / (1 - LANE_BASE[1])); // 残りを従来比率で配分
}

/** 各艇の事前勝率を算出(合計1に正規化) */
export function computePreProbs(race: ParsedRace, venue?: VenueInfo): number[] {
  const ratings = computeRatings(race);
  const raw = race.racers.map((r, i) => venueLaneBase(r.lane, venue) * Math.exp(RATING_COEF * ratings[i]));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
}

/** イン逃げ確率(%): 場の基準値を1号艇と対抗勢の力関係で補正 */
export function computeInEscape(race: ParsedRace, venue: VenueInfo, probs: number[]): number {
  const ratings = computeRatings(race);
  const idx1 = race.racers.findIndex((r) => r.lane === 1);
  if (idx1 < 0) return venue.inEscapeBase;
  const rivalMax = Math.max(...ratings.filter((_, i) => i !== idx1));
  const edge = ratings[idx1] - rivalMax; // 1号艇と最強対抗の力差(σ)
  const adjusted = venue.inEscapeBase * (1 + 0.18 * Math.max(-2, Math.min(2, edge))) * (0.75 + probs[idx1] * 0.6);
  return Math.round(Math.min(88, Math.max(18, adjusted)));
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
    regNo: r.regNo,
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

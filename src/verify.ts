/**
 * 結果反映エンジン。
 * Kファイルのパース結果を保存済みRaceにマージし、verified状態へ遷移させる。
 * - 着順・決まり手・払戻・気象を反映
 * - 事前評価(AI本命・イン逃げ確率)が結果とどう噛み合ったかのreview文を生成
 * - 点灯済みシグナルの的中判定(シグナルフェーズ実装後に本稼働)
 */
import type { Race, RaceResult, Entry } from "./types.ts";
import type { ParseKResult, ParsedRaceResult } from "./resultsParser.ts";
import { venueByJcd } from "./venues.ts";

/** Kパース結果を同日のRace配列へマージ。verifiedにできた件数を返す */
export function applyResults(races: Race[], parsed: ParseKResult): { updated: number; warnings: string[] } {
  const warnings = [...parsed.warnings];
  let updated = 0;
  const now = new Date().toISOString();

  for (const vd of parsed.venues) {
    const venue = venueByJcd.get(vd.jcd);
    if (!venue) {
      warnings.push(`不明な場コード: ${vd.jcd}`);
      continue;
    }
    for (const pr of vd.races) {
      const race = races.find((r) => r.venueSlug === venue.slug && r.raceNo === pr.raceNo);
      if (!race) {
        warnings.push(`${venue.name}${pr.raceNo}R: 対応する番組データがありません`);
        continue;
      }
      if (race.status === "verified") continue; // 二重適用防止

      const finish = pr.rows
        .filter((r) => r.rank !== undefined)
        .sort((a, b) => a.rank! - b.rank!)
        .slice(0, 3)
        .map((r) => r.lane);
      if (finish.length < 3) {
        warnings.push(`${venue.name}${pr.raceNo}R: 着順3着まで確定できず`);
        continue;
      }

      const p3t = pr.payouts.find((p) => p.bet === "3連単");
      const pWin = pr.payouts.find((p) => p.bet === "単勝" && Number(p.combo) === finish[0]);
      const result: RaceResult = {
        finish,
        kimarite: pr.kimarite,
        payout3t: p3t?.amount ?? 0,
        popularity: p3t?.popularity ?? 0,
        payoutWin: pWin?.amount,
        review: buildReview(race, pr, finish, p3t?.amount, p3t?.popularity),
      };

      // 気象の実測反映
      if (pr.windDir) race.windDir = pr.windDir;
      if (pr.windSpeed !== undefined) race.windSpeed = pr.windSpeed;
      if (pr.wave !== undefined) race.wave = pr.wave;

      // 実際の進入コース・本番STを出走表に反映
      for (const row of pr.rows) {
        const e = race.entries.find((x: Entry) => x.lane === row.lane);
        if (e && row.course !== undefined) e.course = row.course;
      }

      // シグナルの的中判定(現状シグナルは未点灯=空配列。点灯フェーズ実装後に本稼働)
      for (const s of race.signals) {
        if (s.hit === undefined) s.hit = judgeSignal(s.text, finish);
      }

      race.result = result;
      race.status = "verified";
      race.updatedAt = now;
      updated++;
    }
  }
  return { updated, warnings };
}

/** シグナル文面から対象艇を推定して的中判定(暫定: 「N号艇」の1着/2着以内) */
function judgeSignal(text: string, finish: number[]): boolean | undefined {
  const m = text.match(/([1-6])号艇/);
  if (!m) return undefined;
  const lane = Number(m[1]);
  return finish.slice(0, 2).includes(lane);
}

/** レース結果の振り返り文(中立的な事実記述のみ。予想との照合はしない) */
export function buildReview(
  race: Race,
  pr: ParsedRaceResult,
  finish: number[],
  payout3t?: number,
  popularity?: number
): string {
  const parts: string[] = [];

  // 1. 結果の要約
  const pay =
    payout3t && payout3t > 0
      ? `3連単は¥${payout3t.toLocaleString()}${popularity ? `(${popularity}番人気)` : ""}`
      : "3連単の払戻は取得できず";
  parts.push(`結果は${finish.join("-")}、決まり手は${pr.kimarite}。${pay}。`);

  // 2. 展開の事実記述
  const winner = race.entries.find((e) => e.lane === finish[0]);
  const winnerName = winner ? `・${winner.name}` : "";
  if (finish[0] === 1 && pr.kimarite === "逃げ") {
    parts.push(`1号艇${winnerName}が逃げ切る決着。`);
  } else if (finish[0] === 1) {
    parts.push(`1号艇${winnerName}が${pr.kimarite}で1着。`);
  } else {
    const lane1row = pr.rows.find((r) => r.lane === 1);
    const lane1pos = lane1row?.rank ? `${lane1row.rank}着` : "着外";
    parts.push(`インは${lane1pos}に敗れ、${finish[0]}号艇${winnerName}が${pr.kimarite}で制した。`);
  }

  // 3. 配当帯の記録
  if (popularity) {
    if (popularity <= 3) parts.push("人気サイドの順当な決着。");
    else if (popularity <= 10) parts.push("中穴の決着。");
    else parts.push("波乱の決着となった。");
  }

  return parts.join("");
}

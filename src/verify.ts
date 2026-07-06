/**
 * 答え合わせ(結果検証)エンジン。
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

/** 答え合わせ本文(断定表現を避け、事前評価と結果の照合を淡々と記録する) */
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

  // 2. AI本命の検証
  const top = [...race.entries].sort((a, b) => b.preProb - a.preProb)[0];
  if (top) {
    const pos = finish.indexOf(top.lane);
    if (pos === 0) {
      parts.push(`事前AI本命の${top.lane}号艇・${top.name}(事前勝率${Math.round(top.preProb * 100)}%)が1着で、評価どおりの決着。`);
    } else if (pos > 0) {
      parts.push(`事前AI本命の${top.lane}号艇・${top.name}は${pos + 1}着。頭までは届かなかった。`);
    } else {
      parts.push(`事前AI本命の${top.lane}号艇・${top.name}は3着圏外。事前評価が裏切られた一戦。`);
    }
  }

  // 3. イン逃げ評価の検証
  const inPre = race.inEscapeProbPre;
  if (finish[0] === 1 && pr.kimarite === "逃げ") {
    parts.push(
      inPre >= 55
        ? `イン逃げ確率${inPre}%の高評価どおり、1号艇が押し切った。`
        : `イン逃げ確率は${inPre}%と控えめの見立てだったが、実際はインが逃げ切った。`
    );
  } else if (finish[0] === 1) {
    parts.push(`1号艇が1着も決まり手は${pr.kimarite}。単純なイン逃げではない展開だった。`);
  } else {
    const lane1row = pr.rows.find((r) => r.lane === 1);
    const lane1pos = lane1row?.rank ? `${lane1row.rank}着` : "着外";
    parts.push(
      inPre >= 55
        ? `イン逃げ確率${inPre}%の見立てに反しインは${lane1pos}に沈み、${finish[0]}号艇が制した。`
        : `イン逃げ確率${inPre}%と警戒したとおりインは崩れ(${lane1pos})、${finish[0]}号艇が制した。`
    );
  }

  // 4. 配当帯の記録
  if (popularity) {
    if (popularity <= 3) parts.push("配当面は人気サイドの順当決着。");
    else if (popularity <= 10) parts.push("配当面は中穴の決着。");
    else parts.push("配当面は市場の想定を大きく外れた波乱の決着。");
  }

  // 5. 検証範囲の明示(透明性)
  parts.push(
    race.signals.length > 0
      ? "点灯シグナルの的中判定は各シグナル横に表示。"
      : "本レースは事前評価のみの検証(展示・直前オッズのシグナル検証は準備中)。"
  );

  return parts.join("");
}

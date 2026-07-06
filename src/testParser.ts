/**
 * パーサ+モデルのスモークテスト(フィクスチャ使用)。
 * 実行: npm run test:parser
 * 実ファイルとの形式差異が見つかった場合は fixtures/ に実データの断片を追加して調整する。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBFile } from "./officialParser.ts";
import { venueByJcd } from "./venues.ts";
import { computePreProbs, computeInEscape } from "./model.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

const text = await readFile(path.join(__dirname, "..", "fixtures", "b-sample.txt"), "utf-8");
const { venues, warnings } = parseBFile(text);

assert(venues.length === 2, `場数=2 (実際: ${venues.length})`);
assert(venues[0]?.jcd === "12", `1場目=住之江(12) (実際: ${venues[0]?.jcd})`);
assert(venues[0]?.races.length === 2, `住之江のレース数=2 (実際: ${venues[0]?.races.length})`);
assert(venues[1]?.jcd === "24", `2場目=大村(24) (実際: ${venues[1]?.jcd})`);

const r1 = venues[0]?.races[0];
assert(r1?.raceNo === 1, `1R番号 (実際: ${r1?.raceNo})`);
assert(r1?.closeTime === "15:16", `締切15:16 (実際: ${r1?.closeTime})`);
assert(r1?.distance === 1800, `距離1800m (実際: ${r1?.distance})`);
assert(r1?.racers.length === 6, `選手6名 (実際: ${r1?.racers.length})`);

const lane1 = r1?.racers[0];
assert(lane1?.regNo === "4444", `登番4444 (実際: ${lane1?.regNo})`);
assert(lane1?.name === "山田太郎", `氏名=山田太郎 (実際: ${lane1?.name})`);
assert(lane1?.racerClass === "A1", `級別A1 (実際: ${lane1?.racerClass})`);
assert(lane1?.natWinRate === 6.66, `全国勝率6.66 (実際: ${lane1?.natWinRate})`);
assert(lane1?.motorRate === 44.44, `モーター2率44.44 (実際: ${lane1?.motorRate})`);
assert(lane1?.boatNo === 44, `ボートNo44 (実際: ${lane1?.boatNo})`);

// モデルの健全性
const omura = venues[1]!.races[0]!;
const probs = computePreProbs(omura);
const sum = probs.reduce((a, b) => a + b, 0);
assert(Math.abs(sum - 1) < 1e-9, `勝率合計=1 (実際: ${sum.toFixed(6)})`);
assert(probs[0] > probs[1] && probs[0] > probs[5], `1号艇(A1)が最有力 (1号=${(probs[0] * 100).toFixed(1)}%)`);
const inEsc = computeInEscape(omura, venueByJcd.get("24")!, probs);
assert(inEsc >= 55 && inEsc <= 85, `大村×A1のイン逃げ確率が高水準 (実際: ${inEsc}%)`);

assert(warnings.length === 0, `警告0件 (実際: ${warnings.length}件 ${warnings[0] ?? ""})`);

// 通し変換(番組表テキスト→Race[])
const { convertBText } = await import("./dataSource.ts");
const races = convertBText(text, "2026-07-05");
assert(races.length === 3, `Race変換=3件 (実際: ${races.length})`);
assert(races[0].venueSlug === "suminoe" && races[0].status === "pre", `変換1件目=住之江/pre`);
assert(races[2].venue === "大村" && races[2].closeTime === "18:25", `大村1R 締切18:25 (実際: ${races[2]?.closeTime})`);
assert(races[2].entries.length === 6 && races[2].entries[0].preProb > 0.4, `大村1号艇の事前勝率>40% (実際: ${(races[2].entries[0].preProb * 100).toFixed(1)}%)`);
assert(races[2].verdict.includes("大村") && !races[2].verdict.includes("必勝"), `結論文生成(断定表現なし)`);

/* ---------- Kファイル(競走成績)パーサ ---------- */
const { parseKFile } = await import("./resultsParser.ts");
const { applyResults } = await import("./verify.ts");

const kText = await readFile(path.join(__dirname, "..", "fixtures", "k-sample.txt"), "utf-8");
const k = parseKFile(kText);

assert(k.venues.length === 2, `K: 場数=2 (実際: ${k.venues.length})`);
assert(k.venues[0]?.jcd === "12" && k.venues[0]?.races.length === 2, `K: 住之江(12)のレース数=2 (実際: ${k.venues[0]?.races.length})`);
assert(k.warnings.length === 0, `K: 警告0件 (実際: ${k.warnings.length}件 ${k.warnings[0] ?? ""})`);

const k1 = k.venues[0]!.races[0]!;
assert(k1.kimarite === "逃げ", `K: 1R決まり手=逃げ (実際: ${k1.kimarite})`);
assert(k1.windDir === "北" && k1.windSpeed === 3 && k1.wave === 2, `K: 気象(北3m/波2cm) (実際: ${k1.windDir}${k1.windSpeed}m/${k1.wave}cm)`);
assert(k1.rows.length === 6 && k1.rows[0].lane === 1 && k1.rows[0].rank === 1, `K: 1R着順行6件・1着=1号艇`);
assert(k1.rows[0].course === 1 && k1.rows[0].st === 0.11, `K: 進入1/ST0.11 (実際: ${k1.rows[0].course}/${k1.rows[0].st})`);
const k1p3 = k1.payouts.find((p) => p.bet === "3連単");
assert(k1p3?.combo === "1-2-3" && k1p3?.amount === 1670 && k1p3?.popularity === 4, `K: 3連単1670円4番人気`);
assert(k1.payouts.filter((p) => p.bet === "拡連複").length === 3, `K: 拡連複の継続行を3件取得`);
assert(k1.payouts.filter((p) => p.bet === "複勝").length === 2, `K: 複勝2艇分を取得`);

const k2 = k.venues[0]!.races[1]!;
assert(k2.kimarite === "まくり" && k2.rows[0].lane === 4, `K: 2Rまくり・1着=4号艇`);

const kOmura = k.venues[1]!.races[0]!;
assert(kOmura.rows.some((r) => r.rankCode === "F" && r.lane === 4 && r.rank === undefined), `K: フライング行(F)を着外として許容`);
const kOp3 = kOmura.payouts.find((p) => p.bet === "3連単");
assert(kOp3?.amount === 4560 && kOp3?.popularity === 15, `K: 大村1R 3連単4560円15番人気`);

/* ---------- 答え合わせマージ(B→Race + K→verified の通し) ---------- */
const races2 = convertBText(text, "2026-07-05");
const { updated, warnings: vw } = applyResults(races2, k);
assert(updated === 3, `verify: 3レースをverified化 (実際: ${updated})`);
assert(vw.length === 0, `verify: 警告0件 (実際: ${vw.length}件 ${vw[0] ?? ""})`);

const v1 = races2.find((r) => r.venueSlug === "suminoe" && r.raceNo === 1)!;
assert(v1.status === "verified" && v1.result?.finish.join("-") === "1-2-3", `verify: 住之江1R=1-2-3`);
assert(v1.result!.payout3t === 1670 && v1.result!.popularity === 4, `verify: 払戻・人気を反映`);
assert(v1.windDir === "北" && v1.windSpeed === 3 && v1.wave === 2, `verify: 気象を実測で更新`);
assert(v1.result!.review.includes("1号艇") && !v1.result!.review.includes("必勝"), `verify: review文生成(断定表現なし)`);
assert(v1.entries[0].course === 1, `verify: 実進入コースをentriesへ反映`);

const vOmura = races2.find((r) => r.venueSlug === "omura" && r.raceNo === 1)!;
assert(vOmura.result?.finish.join("-") === "2-3-1" && vOmura.result?.kimarite === "差し", `verify: 大村1R=2-3-1差し`);
assert(vOmura.result!.review.includes("イン"), `verify: イン崩れの検証文を含む`);

// 二重適用防止
const again = applyResults(races2, k);
assert(again.updated === 0, `verify: 再適用しても更新0件 (実際: ${again.updated})`);

console.log(process.exitCode ? "\nテスト失敗があります" : "\n全テスト通過");

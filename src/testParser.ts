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

console.log(process.exitCode ? "\nテスト失敗があります" : "\n全テスト通過");

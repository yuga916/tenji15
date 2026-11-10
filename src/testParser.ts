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
import { trifectaProbs, buildTiers, collectTierStats, exactaTop } from "./betTiers.ts";
import { parseFanFemale, fanFileCandidates } from "./femaleRacers.ts";

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
assert(inEsc >= 55 && inEsc <= 88, `大村×A1のイン逃げ確率が高水準 (実際: ${inEsc}%)`);

// 多因子モデル: 弱い1号艇(B2) vs 強い外枠(A1)では本命が入れ替わる
const flipRace = {
  raceNo: 1, raceName: "テスト", distance: 1800, closeTime: "12:00",
  racers: [
    { lane: 1, regNo: "1", name: "弱1", age: 30, branch: "x", weight: 52, racerClass: "B2", natWinRate: 2.1, natTop2Rate: 14, localWinRate: 2.0, localTop2Rate: 0, motorNo: 1, motorRate: 22, boatNo: 1, boatRate: 28 },
    { lane: 2, regNo: "2", name: "並2", age: 30, branch: "x", weight: 52, racerClass: "B1", natWinRate: 4.5, natTop2Rate: 30, localWinRate: 4.3, localTop2Rate: 0, motorNo: 2, motorRate: 33, boatNo: 2, boatRate: 33 },
    { lane: 3, regNo: "3", name: "並3", age: 30, branch: "x", weight: 52, racerClass: "B1", natWinRate: 4.2, natTop2Rate: 28, localWinRate: 4.0, localTop2Rate: 0, motorNo: 3, motorRate: 31, boatNo: 3, boatRate: 32 },
    { lane: 4, regNo: "4", name: "強4", age: 30, branch: "x", weight: 52, racerClass: "A1", natWinRate: 7.6, natTop2Rate: 55, localWinRate: 7.8, localTop2Rate: 0, motorNo: 4, motorRate: 52, boatNo: 4, boatRate: 40 },
    { lane: 5, regNo: "5", name: "並5", age: 30, branch: "x", weight: 52, racerClass: "B1", natWinRate: 4.0, natTop2Rate: 27, localWinRate: 3.8, localTop2Rate: 0, motorNo: 5, motorRate: 30, boatNo: 5, boatRate: 31 },
    { lane: 6, regNo: "6", name: "並6", age: 30, branch: "x", weight: 52, racerClass: "B1", natWinRate: 3.8, natTop2Rate: 26, localWinRate: 3.6, localTop2Rate: 0, motorNo: 6, motorRate: 29, boatNo: 6, boatRate: 30 },
  ],
} as any;
const flipProbs = computePreProbs(flipRace);
const flipTop = flipProbs.indexOf(Math.max(...flipProbs));
assert(flipTop !== 0, `多因子: 弱1号艇vs強A1外枠で本命が変動 (◎=${flipTop + 1}号艇)`);
assert(flipProbs[0] > 0.1, `多因子: それでも1号艇はコース分の下駄あり (実際: ${(flipProbs[0] * 100).toFixed(1)}%)`);

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

/* ---------- グレード検出・単勝払戻 ---------- */
assert(venues[0]?.seriesTitle?.includes("サンプルカップ") === true, `節タイトル検出(住之江) (実際: ${venues[0]?.seriesTitle})`);
assert(venues[1]?.seriesTitle?.includes("グランドチャンピオン") === true, `節タイトル検出(大村) (実際: ${venues[1]?.seriesTitle})`);
const { gradeOf } = await import("./dataSource.ts");
assert(gradeOf(venues[1]?.seriesTitle) === "SG", `SG判定 (実際: ${gradeOf(venues[1]?.seriesTitle)})`);
assert(gradeOf(venues[0]?.seriesTitle) === undefined, `一般節はグレードなし (実際: ${gradeOf(venues[0]?.seriesTitle)})`);
assert(gradeOf("GⅠ第70回九州地区選手権") === "G1" && gradeOf("GⅢオールレディース") === "G3", `G1/G3判定`);
assert(vOmura.grade === "SG" && vOmura.seriesTitle !== undefined, `RaceへのSG付与 (実際: ${vOmura.grade})`);
assert(v1.result!.payoutWin === 130, `単勝払戻の保存 (実際: ${v1.result!.payoutWin})`);
assert(v1.result!.payout2t === 450, `2連単払戻の保存 (実際: ${v1.result!.payout2t})`);
assert(races2[0].entries[0].regNo === "4444", `Entry.regNo付与`);

/* ---------- 直前情報(シグナルフェーズ) ---------- */
const { parseBeforeInfo, parseWinOdds } = await import("./liveFetcher.ts");
const { applyLiveInfo } = await import("./signals.ts");

const biHtml = await readFile(path.join(__dirname, "..", "fixtures", "beforeinfo-sample.html"), "utf-8");
const bi = parseBeforeInfo(biHtml);
assert(bi.exTimes.size === 6 && bi.exTimes.get(1) === 6.72, `live: 展示タイム6艇(1号艇6.72) (実際: ${bi.exTimes.size}艇/${bi.exTimes.get(1)})`);
assert(bi.courses.join("") === "123546", `live: 進入検出=123546 (実際: ${bi.courses.join("")})`);
assert(bi.exSts.get(4) === -0.02, `live: F展示ST=-0.02 (実際: ${bi.exSts.get(4)})`);
assert(bi.windSpeed === 4 && bi.wave === 3 && bi.weather === "曇", `live: 気象(曇4m/3cm) (実際: ${bi.weather}${bi.windSpeed}m/${bi.wave}cm)`);
assert(bi.warnings.length === 0, `live: 警告0件 (実際: ${bi.warnings.length}件 ${bi.warnings[0] ?? ""})`);

const woHtml = await readFile(path.join(__dirname, "..", "fixtures", "odds-sample.html"), "utf-8");
const wo = parseWinOdds(woHtml);
assert(wo.odds.size === 6 && wo.odds.get(1) === 1.5 && wo.odds.get(6) === 45.0, `live: 単勝オッズ6艇 (実際: ${wo.odds.size}艇)`);

const races4 = convertBText(text, "2026-07-07");
const live = races4[0];
const okLive = applyLiveInfo(live, bi, wo);
assert(okLive && live.status === "signal", `live: signal遷移 (実際: ${live.status})`);
assert(live.entries.every((e) => e.aiProb > 0 && !Number.isNaN(e.aiProb)), `live: aiProb再計算(NaNなし)`);
assert(Math.abs(live.entries.reduce((a, e) => a + e.aiProb, 0) - 1) < 0.01, `live: aiProb合計≒1`);
assert(live.entries[0].marketProb !== undefined && live.entries[0].marketProb! > 0.4, `live: 市場勝率逆算 (実際: ${live.entries[0].marketProb})`);
assert(live.signals.some((s) => s.type === "formation"), `live: 前づけ(進入変化)シグナル点灯`);
assert(live.signals.some((s) => s.type === "extime"), `live: 展示偏差シグナル点灯`);
assert(live.entries.find((e) => e.lane === 4)?.course === 5, `live: 進入コース反映(4号艇→5コース)`);
assert(live.verdict.includes("直前最終評価") && !live.verdict.includes("必勝"), `live: 結論文更新(断定なし)`);
assert(live.windSpeed === 4 && live.wave === 3, `live: 気象をRaceへ反映`);

// ---- 欠場(2026-10-29: 欠場艇にAI勝率が残っていた不具合の回帰テスト) ----
{
  const scr = convertBText(text, "2026-07-07")[0];
  const bi5 = { ...bi, exTimes: new Map([...bi.exTimes].filter(([l]) => l !== 3)), courses: [1, 2, 4, 5, 6], scratched: new Set<number>() };
  const wo5 = { odds: new Map([...wo.odds].filter(([l]) => l !== 3)), scratched: new Set<number>(), warnings: [] };
  applyLiveInfo(scr, bi5 as any, wo5 as any);
  const e3 = scr.entries.find((e) => e.lane === 3)!;
  assert(e3.scratched === true && e3.aiProb === 0, `欠場: 展示・オッズとも無い艇を欠場として勝率0 (実際: ${e3.scratched}/${e3.aiProb})`);
  assert(Math.abs(scr.entries.reduce((a, e) => a + e.aiProb, 0) - 1) < 0.01, `欠場: 残り5艇で合計≒1`);
  assert(scr.signals.some((s) => s.type === "scratch"), `欠場: 欠場シグナル`);
  assert(!scr.signals.some((s) => s.type === "formation"), `欠場: 欠場による繰り上がりを進入変化と誤判定しない`);
  const tiers = buildTiers(scr)!;
  assert([...tiers.honmei, ...tiers.taikou, ...tiers.ana].every((c) => !c.lanes.includes(3)), `欠場: 買い目に欠場艇を含めない`);
  const woTxt = parseWinOdds('<tr><td class="is-boatColor3">3</td><td>西橋</td><td>欠場</td></tr><tr><td class="is-boatColor1">1</td><td>a</td><td>1.5</td></tr>');
  assert(woTxt.scratched?.has(3) === true, `欠場: オッズ表の「欠場」表示を検知`);
}

// ---- 番組表: 番号3桁が率に連結/勝率空欄(2026-11-02: 芦屋・福岡のレースが欠ける不具合の回帰テスト) ----
{
  const { parseRacerNumbers } = await import("./officialParser.ts");
  const a = parseRacerNumbers(" 5.58 31.58 5.88 33.33 59 23.28170 37.12");
  assert(!!a && a.v[6] === 170 && a.v[5] === 23.28 && !a.filled, `番組表: 3桁ボート番号の連結を分離 (実際: ${JSON.stringify(a?.v)})`);
  const b = parseRacerNumbers(" 2.29  2.78              11 39.67119 28.93");
  assert(!!b && b.v[2] === 0 && b.v[4] === 11 && b.v[6] === 119 && b.filled, `番組表: 当地勝率空欄は0扱い (実際: ${JSON.stringify(b?.v)})`);
  const d2 = parseRacerNumbers(" 7.01 55.37 6.50 46.67 62100.00 76  0.00 3 4");
  assert(!!d2 && d2.v[4] === 62 && d2.v[5] === 100 && d2.v[6] === 76 && d2.v[7] === 0, `番組表: 番号と2連率100.00の連結を分離 (実際: ${JSON.stringify(d2?.v)})`);
  const e2 = parseRacerNumbers(" 5.58 31.58 5.88 33.33 59 23.2810037.12");
  assert(!!e2 && e2.v[6] === 100 && e2.v[7] === 37.12, `番組表: 3桁ボート番号+率の連結を分離 (実際: ${JSON.stringify(e2?.v)})`);
  const c = parseRacerNumbers(" 6.12 45.00 6.50 50.00 45 38.20 33 40.10");
  assert(!!c && JSON.stringify(c.v) === JSON.stringify([6.12, 45, 6.5, 50, 45, 38.2, 33, 40.1]), `番組表: 通常行は従来どおり`);
  const { parseCloseTimes } = await import("./liveFetcher.ts");
  const ct = parseCloseTimes('<tr><td colspan="2">締切予定時刻</td><td class=" is-activeColor1">10:49</td><td>11:16</td><td>11:44</td></tr><tr><td>12:00</td></tr>');
  assert(ct.size === 3 && ct.get(1) === "10:49" && ct.get(3) === "11:44", `直前情報: 締切予定時刻の読み取り (実際: ${[...ct].join(",")})`);
}

// パース不能なHTMLでも落ちない(フェイルセーフ)
const biBad = parseBeforeInfo("<html><body>メンテナンス中</body></html>");
assert(biBad.exTimes.size === 0 && biBad.warnings.length > 0, `live: 不正HTMLで警告のみ(クラッシュなし)`);

// ---- 実際の公式ページ構造: 体重・チルト・プロペラ・部品交換・調整重量(2026-10-09追加) ----
{
  const real = await readFile(path.join(__dirname, "..", "fixtures", "beforeinfo-real-sample.html"), "utf-8");
  const bi = parseBeforeInfo(real);
  assert(bi.exTimes.size === 6 && bi.exTimes.get(1) === 6.69, `real: 展示タイム6艇 (実際: ${bi.exTimes.size})`);
  assert(bi.weights?.get(1) === 51.5 && bi.weights?.get(5) === 50.1, `real: 体重 (実際: ${bi.weights?.get(1)}, ${bi.weights?.get(5)})`);
  assert(bi.tilts?.get(4) === 1.0 && bi.tilts?.get(2) === -0.5, `real: チルト (実際: ${bi.tilts?.get(4)}, ${bi.tilts?.get(2)})`);
  assert(bi.newProps?.has(2) === true && bi.newProps?.has(1) === false, `real: 新プロペラ検出`);
  assert(JSON.stringify(bi.parts?.get(3)) === JSON.stringify(["リング×1"]), `real: 部品交換(全角数字→半角) (実際: ${JSON.stringify(bi.parts?.get(3))})`);
  assert((bi.parts?.get(4) ?? []).length === 2 && !bi.parts?.has(1), `real: 複数部品・交換なし`);
  assert(bi.adjWeights?.get(1) === 0.5 && bi.adjWeights?.get(5) === 1.0, `real: 調整重量`);
  assert(bi.courses.length === 6, `real: 進入6艇`);

  const { adjustFactor } = await import("./signals.ts");
  const base = { lane: 4, name: "x", racerClass: "A1", stAvg: 0, natWinRate: 6, motorRate: 40, preProb: 0.2, aiProb: 0.2 };
  const a1 = adjustFactor({ ...base, parts: ["キャブレター"], tilt: 1.0, course: 4 } as any);
  assert(Math.abs(a1.mult - 0.96 * 1.05) < 1e-9 && a1.notes.length === 2, `adjust: 主要部品交換×チルト外 (実際: ${a1.mult})`);
  const a2 = adjustFactor({ ...base, lane: 1, tilt: 1.0, course: 1, weight: 52, exWeight: 50.5 } as any);
  assert(Math.abs(a2.mult - 0.96 * 1.03) < 1e-9, `adjust: チルト高×イン、体重減 (実際: ${a2.mult})`);
  const a3 = adjustFactor({ ...base, tilt: -0.5, weight: 52, exWeight: 52.3 } as any);
  assert(a3.mult === 1 && a3.notes.length === 0, `adjust: 標準チルト・体重変化小は補正なし`);
}

// ---- 番組表の再取得で直前評価(signal)が上書きされないこと(2026-10-08の不具合の回帰テスト) ----
{
  const { mergeDay } = await import("./pipeline.ts");
  const mk = (id: string, status: string, ai: number) => ({ raceId: id, status, entries: [{ lane: 1, aiProb: ai, preProb: 0.5 }] }) as any;
  const existing = [mk("a", "signal", 0.8), mk("b", "pre", 0.5), mk("c", "verified", 0.7), mk("d", "signal", 0.6)];
  const fresh = [mk("a", "pre", 0.5), mk("b", "pre", 0.55), mk("c", "pre", 0.5)];
  const m = mergeDay(existing, fresh);
  const get = (id: string) => m.find((r: any) => r.raceId === id);
  assert(get("a")?.status === "signal" && get("a")?.entries[0].aiProb === 0.8, `merge: 直前評価(signal)を番組表再取得で上書きしない`);
  assert(get("b")?.entries[0].aiProb === 0.55, `merge: 事前評価(pre)は新しい番組表で更新する`);
  assert(get("c")?.status === "verified", `merge: 確定済み(verified)は保持`);
  assert(get("d")?.status === "signal", `merge: 新データに無い直前評価済みレースも保持`);
}

/* ---------- 買い目の段階表示 ---------- */
{
  const c = trifectaProbs(new Map([[1, 0.5], [2, 0.2], [3, 0.1], [4, 0.1], [5, 0.05], [6, 0.05]]));
  assert(c.length === 120, `3連単120通り (実際: ${c.length})`);
  assert(Math.abs(c.reduce((s, x) => s + x.prob, 0) - 1) < 1e-9, "3連単の推定確率の合計=1");
  const mk = (p: number[]) => ({ entries: p.map((v, i) => ({ lane: i + 1, aiProb: v })) }) as any;
  const t = buildTiers(mk([0.72, 0.1, 0.08, 0.05, 0.03, 0.02]))!;
  const key = (x: { lanes: number[] }) => x.lanes.join("-");
  const all = [...t.honmei, ...t.taikou, ...t.ana].map(key);
  assert(new Set(all).size === all.length, "本命・対抗・穴の組み合わせが重複しない");
  assert(t.honmei[0] && key(t.honmei[0]) === "1-2-3", "本命の1点目=AI順の1-2-3");
  assert(t.taikou.every((x) => x.lanes[0] === 2), "対抗=AI評価2位が1着");
  assert(t.ana.every((x) => x.lanes[0] !== 1 && x.lanes[0] !== 2), "穴=AI上位2艇以外が1着");
  assert(!!t.shibori && t.shibori.length === 2, "AI本命70%以上で絞り2点を出す");
  assert(buildTiers(mk([0.5, 0.2, 0.1, 0.1, 0.05, 0.05]))!.shibori === null, "AI本命70%未満は絞り2点なし");
  const race = { ...mk([0.72, 0.1, 0.08, 0.05, 0.03, 0.02]), status: "verified", result: { finish: [1, 2, 3], payout3t: 900 } };
  const st = collectTierStats([race]);
  assert(st.honmei.n === 1 && st.honmei.hit === 1 && st.honmei.ret === 900, "段階別成績: 本命的中を集計");
  assert(st.ana.hit === 0, "段階別成績: 穴は不的中");
  const ex = exactaTop(mk([0.72, 0.1, 0.08, 0.05, 0.03, 0.02]), 3);
  assert(ex.length === 3 && ex[0].lanes.join("-") === "1-2" && ex.every((x) => x.lanes[0] !== x.lanes[1]), "2連単: 上位3点(1点目は1-2)");
  const st2 = collectTierStats([{ ...race, result: { ...race.result, payout2t: 340 } }] as any);
  assert(st2.exacta.n === 1 && st2.exacta.hit === 1 && st2.exacta.nPay === 1 && st2.exacta.ret === 340, "2連単: 的中と払戻の集計");
  const st3 = collectTierStats([race] as any);
  assert(st3.exacta.hit === 1 && st3.exacta.nPay === 0, "2連単: 払戻未記録のレースは的中率のみに算入");
}

/* ---------- 女子選手(期別成績の性別欄) ---------- */
{
  const kana = (k: string) => k.padEnd(15, " ");
  const male = "3415" + "松井　繁　　　　" + kana("ﾏﾂｲ ｼｹﾞﾙ") + "大阪" + "A1" + "S" + "441111" + "1" + "44" + "16850O 075604590370190122050201";
  const fem = "4502" + "遠藤　エミ　　　" + kana("ｴﾝﾄﾞｳ ｴﾐ") + "滋賀" + "A1" + "H" + "040101" + "2" + "33" + "15847A 072005800400200150030101";
  const fem2 = "５０００" + "新人　花子　　　" + kana("ｼﾝｼﾞﾝ ﾊﾅｺ") + "東京" + "B2" + "H" + "150505" + "2" + "20" + "16045B 000000000000000000000000";
  const r = parseFanFemale([male, fem, "ヘッダ行", fem2].join("\r\n"));
  assert(r.total === 3, `期別成績: 選手行を3件読み取る (実際: ${r.total})`);
  assert(r.female.join(",") === "4502,5000", `期別成績: 性別2を女子として抽出 (実際: ${r.female.join(",")})`);
  const c = fanFileCandidates("2026-11-10");
  assert(c[0].endsWith("fan2610.lzh") && c[1].endsWith("fan2604.lzh") && c[2].endsWith("fan2510.lzh"), `期別成績: 新しい順の候補 (実際: ${c.map((u) => u.slice(-11)).join(",")})`);
  assert(fanFileCandidates("2027-02-01")[0].endsWith("fan2610.lzh"), "期別成績: 年またぎ");
}

console.log(process.exitCode ? "\nテスト失敗があります" : "\n全テスト通過");

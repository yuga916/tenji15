/**
 * X(Twitter)自動ポスト。
 * GitHub Actionsのパイプライン後に実行し、状態(data/x-posted.json)で重複を防ぐ。
 *
 * ポストの種類(1日各1回まで):
 * - 答え合わせ(前日分の検証が済んだ朝): 検証数・最高配当・AI本命1着率+結果まとめへのリンク
 * - 明日の注目(翌日番組の先行取得後の夜): AI事前評価の最有力+リンク
 *
 * 必要Secrets: X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
 * 未設定の場合は何もせず正常終了(サイト運用に影響しない)。
 * X_DRY_RUN=1 で実際には投稿せず本文のみ出力。
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDay } from "./store.ts";
import type { Race } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "data", "x-posted.json");
const SITE = (process.env.SITE_URL ?? "https://kyotei-chokuzen.com").replace(/\/$/, "");
const DRY = process.env.X_DRY_RUN === "1";

/* ---------- OAuth 1.0a (依存パッケージなし) ---------- */
const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(url: string, method: string): string | null {
  const key = process.env.X_API_KEY;
  const secret = process.env.X_API_SECRET;
  const token = process.env.X_ACCESS_TOKEN;
  const tokenSecret = process.env.X_ACCESS_SECRET;
  if (!key || !secret || !token || !tokenSecret) return null;

  const params: Record<string, string> = {
    oauth_consumer_key: key,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const baseStr = [method.toUpperCase(), pct(url), pct(paramStr)].join("&");
  const signingKey = `${pct(secret)}&${pct(tokenSecret)}`;
  params.oauth_signature = createHmac("sha1", signingKey).update(baseStr).digest("base64");
  return (
    "OAuth " +
    Object.keys(params)
      .sort()
      .map((k) => `${pct(k)}="${pct(params[k])}"`)
      .join(", ")
  );
}

async function postTweet(text: string): Promise<boolean> {
  if (DRY) {
    console.log(`[x] DRY RUN:\n${text}\n---`);
    return true;
  }
  const url = "https://api.twitter.com/2/tweets";
  const auth = oauthHeader(url, "POST");
  if (!auth) {
    console.log("[x] Secrets未設定のためスキップ");
    return false;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error(`[x] 投稿失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  console.log("[x] 投稿しました");
  return true;
}

/* ---------- 状態管理 ---------- */
async function loadState(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  } catch {
    return [];
  }
}
async function saveState(keys: string[]): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(keys.slice(-60), null, 2), "utf-8");
}

/* ---------- 本文生成 ---------- */
function resultsText(dateISO: string, races: Race[]): string | null {
  const done = races.filter((r) => r.status === "verified" && r.result);
  if (done.length < 10) return null; // 検証が出揃ってから
  const top = [...done].sort((a, b) => b.result!.payout3t - a.result!.payout3t)[0];
  let aiWin = 0;
  for (const r of done) {
    const pick = [...r.entries].sort((a, b) => b.preProb - a.preProb)[0];
    if (r.result!.finish[0] === pick?.lane) aiWin++;
  }
  const rate = Math.round((aiWin / done.length) * 100);
  const [, m, d] = dateISO.split("-").map(Number);
  return (
    `【答え合わせ】${m}/${d}は全国${done.length}レースを自動検証。` +
    `3連単最高は¥${top.result!.payout3t.toLocaleString()}(${top.venue}${top.raceNo}R・${top.result!.kimarite})。` +
    `AI事前本命の1着率は${rate}%でした。外れも含む全検証記録↓\n${SITE}/results/${dateISO}/`
  );
}

function previewText(dateISO: string, races: Race[]): string | null {
  if (races.length === 0) return null;
  const picks = races
    .map((r) => ({ r, pick: [...r.entries].sort((a, b) => b.preProb - a.preProb)[0] }))
    .filter((x) => x.pick)
    .sort((a, b) => b.pick.preProb - a.pick.preProb);
  if (picks.length === 0) return null;
  const best = picks[0];
  const venues = new Set(races.map((r) => r.venueSlug)).size;
  const grade = races.find((r) => r.grade);
  const [, m, d] = dateISO.split("-").map(Number);
  const gradeNote = grade ? `${grade.grade}「${grade.seriesTitle}」開催中の${grade.venue}に注目。` : "";
  return (
    `【明日の注目】${m}/${d}は${venues}場で開催。${gradeNote}` +
    `AI事前評価の最有力は${best.r.venue}${best.r.raceNo}R・${best.pick.lane}号艇${best.pick.name}(想定勝率${Math.round(best.pick.preProb * 100)}%)。` +
    `全レースの事前評価を前夜から公開中↓\n${SITE}/races/${best.r.venueSlug}/${dateISO}/`
  );
}

/* ---------- main ---------- */
function jstNow(): Date {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

async function main() {
  if (!DRY && !process.env.X_API_KEY) {
    console.log("[x] X_API_KEY未設定のためスキップ(正常)");
    return;
  }
  const posted = await loadState();
  const today = jstNow().toISOString().slice(0, 10);
  const hour = jstNow().getUTCHours();

  const addDays = (iso: string, delta: number) => {
    const dt = new Date(`${iso}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  };

  // 1) 前日(または当日夜)の答え合わせポスト
  for (const date of [addDays(today, -1), today]) {
    const key = `results-${date}`;
    if (posted.includes(key)) continue;
    if (date === today && hour < 22) continue; // 当日分は夜のみ
    const races = await loadDay(date);
    if (!races) continue;
    const text = resultsText(date, races);
    if (text && (await postTweet(text))) {
      posted.push(key);
      break; // 1回の実行で1ポストまで
    }
  }

  // 2) 明日の注目ポスト(夜のみ・翌日番組の先行取得後)
  if (hour >= 18) {
    const tomorrow = addDays(today, 1);
    const key = `preview-${tomorrow}`;
    if (!posted.includes(key)) {
      const races = await loadDay(tomorrow);
      if (races && races.length > 0) {
        const text = previewText(tomorrow, races);
        if (text && (await postTweet(text))) posted.push(key);
      }
    }
  }

  if (!DRY) await saveState(posted);
}

main().catch((e) => {
  // ポスト失敗でデプロイを止めない
  console.error("[x] エラー(継続):", (e as Error).message);
});

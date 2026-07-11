/**
 * 静的サイトジェネレータ。
 * data/latest-races.json + テンプレート → dist/ (GitHub Pages 配信物) を生成。
 * リンクはページ深度に応じた相対パス(ローカルで直接開いても表示可能)。
 *
 * レースページは同一URLで 事前(pre) → シグナル(signal) → 結果確定(verified) と進化する。
 *
 * 環境変数:
 * - SITE_URL: 本番URL (canonical / sitemap / JSON-LD 用)
 */
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Race, Entry, Signal, RaceStatus } from "./types.ts";
import { loadAllRaces } from "./store.ts";
import { GUIDE_TERMS } from "./guideTerms.ts";
import { venueBySlug } from "./venues.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const SITE_URL = (process.env.SITE_URL ?? "https://kyotei-chokuzen.com").replace(/\/$/, "");
const GA_ID = process.env.GA_MEASUREMENT_ID ?? "";

/** GA4スニペット(測定ID未設定なら空=タグを出さない) */
function gaSnippet(): string {
  if (!/^G-[A-Z0-9]+$/.test(GA_ID)) return "";
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_ID}');
</script>`;
}

/* ---------- helpers ---------- */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const dateLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};

const racePath = (r: Race) => `races/${r.venueSlug}/${r.dateISO}/${r.raceNo}/`;
const closeIso = (r: Race) => `${r.dateISO}T${r.closeTime}:00+09:00`;
const baseFor = (depth: number) => (depth === 0 ? "./" : "../".repeat(depth));
const pct = (p: number) => `${Math.round(p * 100)}%`;

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

const STATUS_META: Record<RaceStatus, { cls: string; label: string }> = {
  pre: { cls: "status-pre", label: "展示待ち・事前評価" },
  signal: { cls: "status-signal", label: "シグナル点灯中" },
  verified: { cls: "status-verified", label: "結果確定" },
};

function gapOf(e: Entry): number | undefined {
  if (e.marketProb === undefined) return undefined;
  return e.aiProb - e.marketProb;
}

function maxGap(r: Race): number {
  return Math.max(...r.entries.map((e) => Math.abs(gapOf(e) ?? 0)));
}

function topPick(r: Race): Entry {
  return [...r.entries].sort((a, b) => b.aiProb - a.aiProb)[0];
}

/* ---------- fragments ---------- */
function exDevCell(e: Entry): string {
  if (e.exDev === undefined) return `<span class="exdev-none">—</span>`;
  const v = e.exDev;
  const cls = v >= 1 ? "exdev-hot" : v <= -1 ? "exdev-cold" : "exdev-mid";
  const sign = v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
  return `<span class="exdev ${cls}">${sign}σ</span>`;
}

function gapCell(e: Entry): string {
  const g = gapOf(e);
  if (g === undefined) return `<span class="gap gap-flat">—</span>`;
  const cls = g >= 0.05 ? "gap-plus" : g <= -0.05 ? "gap-minus" : "gap-flat";
  const sign = g > 0 ? "+" : "";
  return `<span class="gap ${cls}">${sign}${(g * 100).toFixed(0)}pt</span>`;
}

function entriesRows(r: Race, base: string): string {
  const best = topPick(r);
  return r.entries
    .map((e) => {
      const topClass = e.lane === best.lane ? ` class="top-pick"` : "";
      const nameLink = e.regNo
        ? `<a href="${base}racers/${e.regNo}/" style="color:inherit; border-bottom:1px dotted var(--dim);" title="${esc(e.name)}選手の成績・AI評価">${esc(e.name)}</a>`
        : esc(e.name);
      const nameCell = `<span style="display:flex; align-items:center; gap:8px;">${racerAvatar(e.name, e.racerClass, 26)}${nameLink}</span>`;
      return `<tr${topClass}>
        <td><span class="boat boat-${e.lane}">${e.lane}</span></td>
        <td class="racer-name">${nameCell}</td>
        <td>${esc(e.racerClass)}</td>
        <td>${e.natWinRate.toFixed(2)}</td>
        <td>${e.motorRate.toFixed(1)}%</td>
        <td>${e.exTime !== undefined ? e.exTime.toFixed(2) : "—"}</td>
        <td>${exDevCell(e)}</td>
        <td style="font-weight:700;">${pct(e.aiProb)}</td>
        <td>${e.marketProb !== undefined ? pct(e.marketProb) : "—"}</td>
        <td>${gapCell(e)}</td>
      </tr>`;
    })
    .join("\n");
}

function signalFeed(r: Race): string {
  if (r.signals.length === 0) {
    return `<div class="diff-item"><span class="diff-icon diff-neutral">…</span><span class="diff-text">展示航走の情報待ちです。展示確定後、変化があればここに表示されます。</span></div>`;
  }
  const icon = { up: ["diff-up", "▲"], down: ["diff-down", "▼"], neutral: ["diff-neutral", "="] } as const;
  return r.signals
    .map((s: Signal) => {
      const [cls, mark] = icon[s.impact];
      return `<div class="diff-item">
        <span class="diff-time">${s.time}</span>
        <span class="diff-icon ${cls}">${mark}</span>
        <span class="diff-text">${esc(s.text)}</span>
      </div>`;
    })
    .join("\n");
}

function kimariteBar(r: Race): string {
  const k = r.kimarite;
  const seg = (cls: string, label: string, v: number) =>
    v > 0 ? `<span class="${cls}" style="width:${Math.round(v * 100)}%">${label}${Math.round(v * 100)}%</span>` : "";
  return (
    seg("k-nige", "逃げ", k.nige) +
    seg("k-makuri", "まくり", k.makuri) +
    seg("k-sashi", "差し", k.sashi) +
    seg("k-other", "他", k.other)
  );
}

/** 算出ファクターのチップ表示(予想の透明性・説得力のため) */
function factorChips(status: RaceStatus): string {
  const chip = (label: string, live = false) =>
    `<span style="border:1px solid ${live ? "rgba(255,138,61,.5)" : "rgba(77,216,255,.4)"}; color:${live ? "var(--signal)" : "var(--cyan)"}; border-radius:20px; padding:2px 10px; font-size:11px; white-space:nowrap;">${label}</span>`;
  const base = ["全国勝率", "当地勝率", "2連率", "モーター", "ボート", "級別", "コース×会場イン強度"].map((f) => chip(f)).join("");
  const live =
    status === "signal"
      ? ["展示タイム", "進入", "直前オッズ"].map((f) => chip(`${f}✓反映済`, true)).join("")
      : ["展示タイム", "進入", "直前オッズ"].map((f) => chip(`${f}(展示後に反映)`, true)).join("");
  return `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; align-items:center;">
    <span style="color:var(--dim); font-size:11px;">算出ファクター:</span>${base}${live}
  </div>`;
}

/** AIの結論(買い目候補)。断定表現を避け、評価順+根拠を簡潔に提示する */
function betSuggestion(r: Race): string {
  const sorted = [...r.entries].sort((a, b) => b.aiProb - a.aiProb);
  const [a, b, c, d] = sorted;
  if (!a || !b || !c) return "";

  const line = (lanes: number[]) =>
    lanes.map((l) => `<span class="boat boat-${l}" style="width:26px; height:26px; font-size:13px;">${l}</span>`).join(`<span style="color:var(--dim);">-</span>`);

  // 歪み艇(市場が織り込んでいない妙味)があれば3着候補として提示
  const gapBoat = r.entries
    .filter((e) => e.marketProb !== undefined && e.aiProb - e.marketProb! >= 0.07 && e.lane !== a.lane && e.lane !== b.lane)
    .sort((x, y) => (y.aiProb - (y.marketProb ?? 0)) - (x.aiProb - (x.marketProb ?? 0)))[0];

  const subs: string[] = [];
  if (d) subs.push(`3連単 ${a.lane}-${b.lane}-${d.lane}`);
  subs.push(`3連単 ${a.lane}-${c.lane}-${b.lane}`);
  if (r.inEscapeProb < 50 && b) subs.push(`波乱押さえ ${b.lane}-${a.lane}-${c.lane}`);

  const reasons: string[] = [];
  reasons.push(`◎${a.lane}号艇・${esc(a.name)}のAI勝率${Math.round(a.aiProb * 100)}%(2位${b.lane}号艇と${Math.round((a.aiProb - b.aiProb) * 100)}pt差)`);
  reasons.push(
    r.inEscapeProb >= 65
      ? `イン逃げ確率${r.inEscapeProb}%でイン信頼のレース`
      : r.inEscapeProb >= 50
        ? `イン逃げ確率${r.inEscapeProb}%で本線はイン、対抗の頭も一考`
        : `イン逃げ確率${r.inEscapeProb}%と低く波乱含み`
  );
  const hotEx = r.entries.filter((e) => e.exDev !== undefined && e.exDev >= 1.3).sort((x, y) => (y.exDev ?? 0) - (x.exDev ?? 0))[0];
  if (hotEx) reasons.push(`${hotEx.lane}号艇の展示偏差+${hotEx.exDev}σ(当日気配が上向き)`);
  if (gapBoat) reasons.push(`${gapBoat.lane}号艇に+${Math.round((gapBoat.aiProb - gapBoat.marketProb!) * 100)}ptの歪み(市場が過小評価)→3着候補に`);

  const statusNote =
    r.status === "signal"
      ? `<span class="status status-signal" style="font-size:11px;">展示反映済み</span>`
      : r.status === "pre"
        ? `<span class="status status-pre" style="font-size:11px;">展示前の暫定</span>`
        : `<span class="status status-verified" style="font-size:11px;">締切時点の最終評価</span>`;

  // 結果確定後は買い目セクションを表示しない(結果データページとして中立に保つ)
  if (r.status === "verified") return "";

  return `<section>
    <h2>シンプル結論 — AI評価の高い組み合わせ</h2>
    <div class="card">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
        <span style="color:var(--muted); font-size:12.5px;">本線</span>
        <span style="display:inline-flex; align-items:center; gap:4px; font-size:18px; font-weight:900;">3連単 ${line([a.lane, b.lane, c.lane])}</span>
        ${statusNote}
      </div>
      <p style="color:var(--muted); font-size:12.5px; margin-bottom:10px;">押さえ: ${subs.map(esc).join(" / ")}${gapBoat ? ` / 歪み狙い: ${a.lane}-${b.lane}-${gapBoat.lane}` : ""}</p>
      <p style="font-size:13px; color:#cfdde6; margin-bottom:4px;">根拠:</p>
      <ul style="font-size:13px; color:#cfdde6; padding-left:18px; line-height:1.9;">
        ${reasons.map((x) => `<li>${x}</li>`).join("\n")}
      </ul>
      ${factorChips(r.status)}
      <p style="color:var(--dim); font-size:11.5px; margin-top:10px;">※AI評価の高い順の組み合わせであり、的中を保証するものではありません。オッズは締切まで変動します。算出方法の詳細は<a href="${baseFor(4)}guide/ai-yosou/">競艇のAI予想とは</a>をご覧ください。</p>
    </div>
  </section>`;
}

/** 結果の振り返り文(中立的な事実のみ。保存済みの旧文言は使わずビルド時に生成) */
function neutralRecap(r: Race): string {
  const res = r.result!;
  const parts: string[] = [];
  parts.push(`結果は${res.finish.join("-")}、決まり手は${esc(res.kimarite)}。3連単は¥${res.payout3t.toLocaleString()}(${res.popularity}番人気)。`);
  const winner = r.entries.find((e) => e.lane === res.finish[0]);
  const wName = winner ? `・${esc(winner.name)}` : "";
  if (res.finish[0] === 1 && res.kimarite === "逃げ") {
    parts.push(`1号艇${wName}が逃げ切る決着。`);
  } else if (res.finish[0] === 1) {
    parts.push(`1号艇${wName}が${esc(res.kimarite)}で1着。`);
  } else {
    const lane1pos = res.finish.indexOf(1);
    parts.push(
      `インは${lane1pos >= 0 ? `${lane1pos + 1}着` : "3着以内に入れず"}、${res.finish[0]}号艇${wName}が${esc(res.kimarite)}で制した。`
    );
  }
  if (res.popularity <= 3) parts.push("人気サイドの順当な決着。");
  else if (res.popularity <= 10) parts.push("中穴の決着。");
  else parts.push("波乱の決着となった。");
  return parts.join("");
}

function resultSection(r: Race): string {
  if (r.status !== "verified" || !r.result) return "";
  const res = r.result;
  const order = res.finish
    .map((lane, i) => `<span class="boat boat-${lane}">${lane}</span>${i < res.finish.length - 1 ? `<span class="arrow">→</span>` : ""}`)
    .join("");
  return `<section>
    <h2>レース結果</h2>
    <div class="result-box">
      <h3>RESULT</h3>
      <div class="finish-order">${order}
        <span style="color:var(--muted); font-size:13px; margin-left:8px;">決まり手: ${esc(res.kimarite)}</span>
        <span class="payout" style="margin-left:auto;">3連単 ¥${res.payout3t.toLocaleString()} (${res.popularity}番人気)</span>
      </div>
      <p style="color:#cfdde6; font-size:14.5px;">${neutralRecap(r)}</p>
    </div>
  </section>`;
}

/* ---------- index fragments ---------- */
function statusBadge(r: Race): string {
  const m = STATUS_META[r.status];
  return `<span class="status ${m.cls}">${m.label}</span>`;
}

function raceCardForIndex(r: Race, base: string): string {
  const best = topPick(r);
  const grade = r.grade ? `<span class="grade-badge">${esc(r.grade)}</span> ` : "";
  const foot =
    r.status === "verified" && r.result
      ? `<span style="color:var(--green); font-size:12.5px;">結果・払戻を見る → 3連単 ¥${r.result.payout3t.toLocaleString()}</span>`
      : `<span style="color:var(--signal); font-size:12.5px;">直前分析を見る →</span>`;
  return `<a class="card race-card" href="${base}${racePath(r)}" style="color:var(--text);">
    <div class="head"><span class="venue">${esc(r.venue)} ${r.raceNo}R</span><span class="countdown" data-close="${closeIso(r)}">--:--</span></div>
    <div>${grade}${statusBadge(r)}</div>
    <div class="picks">
      <span style="font-size:12px; color:var(--muted);">◎</span><span class="boat boat-${best.lane}">${best.lane}</span>
      <span style="font-size:13px;">${esc(best.name)}</span>
      <span class="gap ${maxGap(r) >= 0.05 ? "gap-plus" : "gap-flat"}" style="margin-left:auto;">歪み ${(maxGap(r) * 100).toFixed(0)}pt</span>
    </div>
    ${foot}
  </a>`;
}

function nextRacePanel(races: Race[], base: string): string {
  const now = Date.now();
  const candidates = races.filter((r) => r.status !== "verified").sort((a, b) => closeIso(a).localeCompare(closeIso(b)));
  // 締切が未来のレースを優先し、なければ直近のもの
  const next = candidates.find((r) => new Date(closeIso(r)).getTime() > now) ?? candidates[0];
  if (!next) return "";
  const best = topPick(next);
  return `<a class="next-race-panel" href="${base}${racePath(next)}" style="color:var(--text);">
    <div>
      <div class="label">NEXT CLOSE</div>
      <div class="race-name">${esc(next.venue)} ${next.raceNo}R ${esc(next.name)}</div>
      <div style="color:var(--muted); font-size:13px;">締切 ${next.closeTime}・AI本命 ${best.lane}号艇 ${esc(best.name)}・イン逃げ ${next.inEscapeProb}%</div>
    </div>
    <span class="countdown" data-close="${closeIso(next)}">--:--</span>
  </a>`;
}

function signalRaces(races: Race[], base: string): string {
  const lit = races.filter((r) => r.status === "signal").sort((a, b) => maxGap(b) - maxGap(a));
  if (lit.length === 0) return `<p style="color:var(--muted); font-size:13px;">現在シグナル点灯中のレースはありません。展示確定後に更新されます。</p>`;
  return lit.map((r) => raceCardForIndex(r, base)).join("\n");
}

function reviewRaces(races: Race[], base: string): string {
  // 全日付のverifiedから新しい順に(高配当を優先的に上へ)
  const done = races
    .filter((r) => r.status === "verified")
    .sort((a, b) => b.dateISO.localeCompare(a.dateISO) || (b.result?.payout3t ?? 0) - (a.result?.payout3t ?? 0));
  if (done.length === 0)
    return `<p style="color:var(--muted); font-size:13px;">確定した結果はまだありません。レース確定後、結果・払戻が順次ここに蓄積されます。</p>`;
  return done.slice(0, 18).map((r) => raceCardForIndex(r, base)).join("\n");
}

function otherRacesHtml(all: Race[], current: Race, base: string): string {
  const sameDay = all.filter((r) => r.dateISO === current.dateISO);
  if (sameDay.length <= 1) return `<p style="color:var(--muted); font-size:13px;">同日の他レースはありません。</p>`;

  // 同じ場の他レース: レース番号のカードを並べる(現在のレースは強調表示)
  const sameVenue = sameDay
    .filter((r) => r.venueSlug === current.venueSlug)
    .sort((a, b) => a.raceNo - b.raceNo);
  const sameCards = sameVenue
    .map((r) => {
      const isCurrent = r.raceId === current.raceId;
      const label = r.status === "verified" ? "済" : r.closeTime;
      return isCurrent
        ? `<span style="display:inline-block; padding:8px 12px; border-radius:8px; background:var(--cyan); color:#05131c; font-weight:700; font-size:13px;">${r.raceNo}R</span>`
        : `<a href="${base}${racePath(r)}" style="display:inline-block; padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.14); color:var(--text); font-size:13px;">${r.raceNo}R <span style="color:var(--dim); font-size:11px;">${label}</span></a>`;
    })
    .join("\n");

  // 他の開催場: 場単位のリンクカード(全レースを並べない)
  const byVenue = new Map<string, Race[]>();
  for (const r of sameDay) {
    if (r.venueSlug === current.venueSlug) continue;
    const l = byVenue.get(r.venueSlug) ?? [];
    l.push(r);
    byVenue.set(r.venueSlug, l);
  }
  const now = Date.now();
  const venueCards = [...byVenue.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.closeTime.localeCompare(b.closeTime));
      const next = sorted.find((r) => new Date(closeIso(r)).getTime() > now && r.status !== "verified");
      const v = sorted[0];
      const note = next ? `次の締切 ${next.raceNo}R ${next.closeTime}` : "全レース終了・結果公開中";
      return { html: `<a class="card race-card" href="${base}races/${v.venueSlug}/${v.dateISO}/" style="color:var(--text);">
        <div class="head"><span class="venue">${esc(v.venue)}</span></div>
        <div style="color:var(--muted); font-size:12.5px;">${note}</div>
      </a>`, done: !next, key: next ? next.closeTime : "99:99" };
    })
    .sort((a, b) => Number(a.done) - Number(b.done) || a.key.localeCompare(b.key))
    .map((x) => x.html)
    .join("\n");

  return `<h3 style="font-size:14px; margin-bottom:10px;">${esc(current.venue)}の全レース</h3>
<div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:22px;">${sameCards}</div>
<h3 style="font-size:14px; margin-bottom:10px;">他の開催場</h3>
<div class="grid grid-3">${venueCards}</div>`;
}

/* ---------- 会場特性セクション(予想根拠の明示) ---------- */
interface VenueStat { n: number; inWin: number; inNige: number; manshu: number; paySum: number; kimarite: Map<string, number> }

function collectVenueStats(races: Race[]): Map<string, VenueStat> {
  const map = new Map<string, VenueStat>();
  for (const r of races) {
    if (r.status !== "verified" || !r.result) continue;
    let s = map.get(r.venueSlug);
    if (!s) { s = { n: 0, inWin: 0, inNige: 0, manshu: 0, paySum: 0, kimarite: new Map() }; map.set(r.venueSlug, s); }
    s.n++;
    if (r.result.finish[0] === 1) s.inWin++;
    if (r.result.finish[0] === 1 && r.result.kimarite === "逃げ") s.inNige++;
    if (r.result.payout3t >= 10000) s.manshu++;
    s.paySum += r.result.payout3t;
    s.kimarite.set(r.result.kimarite, (s.kimarite.get(r.result.kimarite) ?? 0) + 1);
  }
  return map;
}

function venueSectionHtml(r: Race, stat: VenueStat | undefined, inEscapeBase: number | undefined, base: string): string {
  const character =
    inEscapeBase === undefined ? "" :
    inEscapeBase >= 60 ? `<strong style="color:var(--cyan);">イン天国</strong>(全国有数のイン水面)` :
    inEscapeBase >= 48 ? `<strong>標準的な水面</strong>` :
    `<strong style="color:var(--signal);">難水面</strong>(インが崩れやすく波乱型)`;
  const baseLine =
    inEscapeBase === undefined ? "" :
    `<p style="font-size:13.5px; color:#cfdde6; margin-bottom:10px;">${esc(r.venue)}はイン基準${inEscapeBase}%(全国平均55%)の${character}。この会場特性がAI評価のコース基準補正に反映されています。</p>`;

  let measured = `<p style="color:var(--muted); font-size:12.5px;">実測データは蓄積中です(確定レースが増えると自動表示)。</p>`;
  if (stat && stat.n >= 5) {
    const pct = (a: number) => Math.round((a / stat.n) * 100);
    const topKim = [...stat.kimarite.entries()].sort((a, b) => b[1] - a[1])[0];
    const cell = (v: string, l: string) =>
      `<div style="min-width:110px;"><div style="font-size:19px; font-weight:900;">${v}</div><div style="color:var(--dim); font-size:11px;">${l}</div></div>`;
    measured = `<div style="display:flex; flex-wrap:wrap; gap:18px;">
      ${cell(`${pct(stat.inWin)}%`, "1号艇1着率(実測)")}
      ${cell(`${pct(stat.inNige)}%`, "イン逃げ率(実測)")}
      ${cell(esc(topKim?.[0] ?? "—"), "最多決まり手")}
      ${cell(`${pct(stat.manshu)}%`, "万舟券率")}
      ${cell(`¥${Math.round(stat.paySum / stat.n).toLocaleString()}`, "3連単平均払戻")}
    </div>
    <p style="color:var(--dim); font-size:11.5px; margin-top:8px;">※当サイトが記録した${esc(r.venue)}の確定${stat.n}レースの集計(毎日自動更新)。</p>`;
  }

  return `<section>
    <h2>${esc(r.venue)}の水面特性 — この予想の前提</h2>
    <div class="card">
      ${baseLine}
      ${measured}
      <p style="font-size:12px; margin-top:10px;"><a href="${base}races/${r.venueSlug}/">${esc(r.venue)}の会場データをもっと見る →</a></p>
    </div>
  </section>`;
}

/* ---------- JSON-LD ---------- */
function breadcrumbJsonLd(r: Race): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "ホーム", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: `${r.venue}競艇`, item: `${SITE_URL}/races/${r.venueSlug}/` },
      { "@type": "ListItem", position: 3, name: dateLabel(r.dateISO), item: `${SITE_URL}/races/${r.venueSlug}/${r.dateISO}/` },
      { "@type": "ListItem", position: 4, name: `第${r.raceNo}R`, item: `${SITE_URL}/${racePath(r)}` },
    ],
  });
}

/** 会場→都道府県(構造化データのaddress用) */
const VENUE_PREF: Record<string, string> = {
  桐生: "群馬県", 戸田: "埼玉県", 江戸川: "東京都", 平和島: "東京都", 多摩川: "東京都",
  浜名湖: "静岡県", 蒲郡: "愛知県", 常滑: "愛知県", 津: "三重県", 三国: "福井県",
  びわこ: "滋賀県", 住之江: "大阪府", 尼崎: "兵庫県", 鳴門: "徳島県", 丸亀: "香川県",
  児島: "岡山県", 宮島: "広島県", 徳山: "山口県", 下関: "山口県", 若松: "福岡県",
  芦屋: "福岡県", 福岡: "福岡県", 唐津: "佐賀県", 大村: "長崎県",
};

function sportsEventJsonLd(r: Race): string {
  const start = closeIso(r);
  // レースは締切の約5分後に発走し数分で終了するため、終了は締切+15分とする
  const end = new Date(new Date(start).getTime() + 15 * 60000).toISOString();
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: `${r.venue} 第${r.raceNo}R ${r.name}`,
    description: `${r.venue}競艇(ボートレース${r.venue})第${r.raceNo}R「${r.name}」。締切予定${r.closeTime}。AI直前予想とレース結果・払戻を掲載。`,
    sport: "Motorboat racing",
    startDate: start,
    endDate: end,
    eventStatus: "https://schema.org/EventScheduled",
    image: `${SITE_URL}/assets/og-image.png`,
    location: {
      "@type": "Place",
      name: `ボートレース${r.venue}`,
      address: {
        "@type": "PostalAddress",
        ...(VENUE_PREF[r.venue] ? { addressRegion: VENUE_PREF[r.venue] } : {}),
        addressCountry: "JP",
      },
    },
    organizer: { "@type": "Organization", name: `ボートレース${r.venue}`, url: `${SITE_URL}/races/${r.venueSlug}/` },
    performer: r.entries.map((e) => ({ "@type": "Person", name: e.name })),
  });
}

/* ---------- page builders ---------- */
function verdictTitle(status: RaceStatus): string {
  if (status === "pre") return "事前評価（展示前・確定前の暫定）";
  if (status === "signal") return "直前最終結論（展示反映済み）";
  return "このレースの結論はこうだった";
}

async function buildRacePage(template: string, r: Race, all: Race[], vStats: Map<string, VenueStat>): Promise<void> {
  const base = baseFor(4);
  const m = STATUS_META[r.status];
  const inDelta = r.inEscapeProb - r.inEscapeProbPre;
  const title =
    r.status === "verified"
      ? `${r.venue}競艇 ${r.raceNo}R 結果・払戻 ${dateLabel(r.dateISO)}｜競艇チョクゼン`
      : `${r.venue}競艇 ${r.raceNo}R 直前予想【締切15分前に最終更新】${dateLabel(r.dateISO)}｜競艇チョクゼン`;
  const metaDesc =
    r.status === "verified"
      ? `${r.venue}競艇${r.raceNo}R(${dateLabel(r.dateISO)})のレース結果・払戻。着順・決まり手・3連単配当¥${r.result?.payout3t.toLocaleString() ?? "—"}・人気を掲載。`
      : `${r.venue}競艇${r.raceNo}R(${dateLabel(r.dateISO)} 締切${r.closeTime})の直前予想。展示航走反映のイン逃げ確率${r.inEscapeProb}%、AI勝率とオッズの乖離、スリット予測を無料公開。`;

  const html = fill(template, {
    BASE: base,
    SITE_URL,
    GA_SNIPPET: gaSnippet(),
    TITLE: esc(title),
    META_DESC: esc(metaDesc),
    CANONICAL: `${SITE_URL}/${racePath(r)}`,
    OG_TAGS: ogTags(title, metaDesc, racePath(r)),
    VENUE: esc(r.venue),
    VENUE_SLUG: r.venueSlug,
    DATE_ISO: r.dateISO,
    DATE_LABEL: dateLabel(r.dateISO),
    RACE_NO: String(r.raceNo),
    RACE_NAME: esc(r.name),
    GRADE_BADGE: r.grade ? `<span class="grade-badge">${esc(r.grade)}</span>` : "",
    STATUS_CLASS: m.cls,
    STATUS_LABEL: m.label,
    TIME_LABEL: `締切 ${r.closeTime}`,
    WIND: esc(`${r.windDir}${r.windSpeed}m`),
    WAVE: `${r.wave}cm`,
    CLOSE_ISO: closeIso(r),
    VERDICT_TITLE: verdictTitle(r.status),
    VERDICT_TEXT: esc(r.verdict),
    RESULT_SECTION: resultSection(r),
    IN_ESCAPE: String(r.inEscapeProb),
    IN_DELTA_CLASS: inDelta > 0 ? "up" : inDelta < 0 ? "down" : "",
    IN_DELTA_LABEL:
      inDelta === 0
        ? `事前と同じ (${r.inEscapeProbPre}%)`
        : `事前 ${r.inEscapeProbPre}% → ${inDelta > 0 ? "+" : ""}${inDelta}pt`,
    IN_NOTE: esc(r.inNote),
    SIGNAL_FEED: signalFeed(r),
    BET_SECTION: betSuggestion(r),
    VENUE_SECTION: venueSectionHtml(r, vStats.get(r.venueSlug), venueBySlug.get(r.venueSlug)?.inEscapeBase, base),
    KIMARITE_BAR: kimariteBar(r),
    KIMARITE_NOTE: esc(r.kimariteNote),
    ENTRIES_ROWS: entriesRows(r, base),
    AVATAR_LEGEND: avatarLegend(),
    OTHER_RACES_HTML: otherRacesHtml(all, r, base),
    UPDATED_AT: new Date(r.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
    MODEL_VERSION: esc(r.modelVersion),
    BREADCRUMB_JSONLD: breadcrumbJsonLd(r),
    SPORTSEVENT_JSONLD: sportsEventJsonLd(r),
  });

  const dir = path.join(DIST, racePath(r));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html, "utf-8");
}

/** OGP/Twitterカードのメタタグ */
function ogTags(title: string, desc: string, urlPath: string): string {
  return `<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${SITE_URL}/${urlPath}">
<meta property="og:image" content="${SITE_URL}/assets/og-image.png">
<meta property="og:site_name" content="競艇チョクゼン">
<meta name="twitter:card" content="summary_large_image">`;
}

/** 実コンテンツ用のページシェル(canonical・meta description・パンくず付き) */
function articlePage(opts: {
  title: string;
  metaDesc: string;
  path: string;        // 例 "racers/4444/" (末尾スラッシュ)
  base: string;
  crumbs: [string, string?][]; // [ラベル, href?]
  bodyHtml: string;
  jsonLd?: object[];   // 追加の構造化データ(Article/FAQ等)
}): string {
  const crumbHtml = opts.crumbs
    .map(([label, href]) => (href ? `<a href="${href}">${esc(label)}</a>` : esc(label)))
    .join(`<span class="sep">›</span>`);
  // パンくずの構造化データ(相対hrefを絶対URLへ変換)
  const toAbs = (href?: string) =>
    href === undefined ? `${SITE_URL}/${opts.path}` : `${SITE_URL}/${href.startsWith(opts.base) ? href.slice(opts.base.length) : href}`;
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: opts.crumbs.map(([label, href], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: label,
      item: toAbs(href),
    })),
  };
  const ldScripts = [breadcrumbLd, ...(opts.jsonLd ?? [])]
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`)
    .join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.metaDesc)}">
<link rel="canonical" href="${SITE_URL}/${opts.path}">
${ogTags(opts.title, opts.metaDesc, opts.path)}
${ldScripts}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="icon" href="${opts.base}assets/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="512x512" href="${opts.base}assets/favicon-512.png">
<link rel="apple-touch-icon" href="${opts.base}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${opts.base}assets/styles.css">
${gaSnippet()}</head><body>
<header class="site"><div class="wrap"><a class="logo" href="${opts.base}">競艇<span class="num">チョクゼン</span></a>
<nav class="global"><a href="${opts.base}results/">結果まとめ</a><a href="${opts.base}racers/">選手</a><a href="${opts.base}guide/">ガイド</a></nav></div></header>
<main class="wrap article">
<nav class="breadcrumb" aria-label="パンくずリスト">${crumbHtml}</nav>
${opts.bodyHtml}
<div class="age-note"><strong>20歳未満の方は舟券を購入できません。</strong>分析情報は的中を保証するものではありません。無理のない金額で計画的にお楽しみください。</div>
</main>
<footer class="site"><div class="wrap"><div class="legal"><p>【免責事項】当サイトの分析情報は的中を保証するものではありません。当サイトはBOATRACE公式とは無関係の非公式メディアです。</p><p>© 2026 競艇チョクゼン</p></div></div></footer>
</body></html>`;
}

/* ---------- 選手集計(A1) ---------- */
interface RacerAppearance {
  race: Race;
  entry: Entry;
  pos?: number; // 1-3=確定着(上位3着のみ判明) / undefined=未確定or圏外
  isAiPick: boolean;
}
interface RacerAgg {
  regNo: string;
  name: string;
  racerClass: string;
  natWinRate: number;
  appearances: RacerAppearance[];
  starts: number;   // 結果確定済みの出走数
  wins: number;
  seconds: number;
  thirds: number;
  aiPicks: number;      // AI本命に指名された回数(確定分)
  aiPickTop2: number;   // うち2着以内
}

function collectRacers(races: Race[]): Map<string, RacerAgg> {
  const map = new Map<string, RacerAgg>();
  const sorted = [...races].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  for (const r of sorted) {
    const best = topPick(r);
    for (const e of r.entries) {
      if (!e.regNo) continue;
      let agg = map.get(e.regNo);
      if (!agg) {
        agg = { regNo: e.regNo, name: e.name, racerClass: e.racerClass, natWinRate: e.natWinRate,
          appearances: [], starts: 0, wins: 0, seconds: 0, thirds: 0, aiPicks: 0, aiPickTop2: 0 };
        map.set(e.regNo, agg);
      }
      // プロフィールは最新の出走で更新
      agg.name = e.name;
      agg.racerClass = e.racerClass;
      agg.natWinRate = e.natWinRate;

      const verified = r.status === "verified" && !!r.result;
      const idx = verified ? r.result!.finish.indexOf(e.lane) : -1;
      const pos = verified && idx >= 0 ? idx + 1 : undefined;
      const isAiPick = best.lane === e.lane;
      agg.appearances.push({ race: r, entry: e, pos, isAiPick });
      if (verified) {
        agg.starts++;
        if (pos === 1) agg.wins++;
        if (pos === 2) agg.seconds++;
        if (pos === 3) agg.thirds++;
        if (isAiPick) {
          agg.aiPicks++;
          if (pos === 1 || pos === 2) agg.aiPickTop2++;
        }
      }
    }
  }
  return map;
}

/** 選手アバター(級別カラー+名前の頭文字)。公式写真は著作物のため使わない */
const CLASS_COLOR: Record<string, string> = { A1: "#e8b04b", A2: "#b8c4cf", B1: "#4dd8ff", B2: "#7a8a96" };
function racerAvatar(name: string, racerClass: string, size = 64): string {
  const color = CLASS_COLOR[racerClass] ?? "#4dd8ff";
  const initial = esc(name.slice(0, 1));
  return `<span style="display:inline-flex; align-items:center; justify-content:center; width:${size}px; height:${size}px; border-radius:50%; background:linear-gradient(145deg, ${color}33, ${color}18); border:2px solid ${color}; color:${color}; font-size:${Math.round(size * 0.45)}px; font-weight:900; flex-shrink:0;">${initial}</span>`;
}

/** アイコン色の凡例(控えめな小さい表示) */
function avatarLegend(): string {
  const dot = (c: string, label: string) =>
    `<span style="display:inline-flex; align-items:center; gap:4px; margin-right:10px; white-space:nowrap;"><span style="width:9px; height:9px; border-radius:50%; border:2px solid ${c}; display:inline-block;"></span>${label}</span>`;
  return `<p style="color:var(--dim); font-size:11px; margin-top:6px;">選手アイコンの色=級別: ${dot("#e8b04b", "A1")}${dot("#b8c4cf", "A2")}${dot("#4dd8ff", "B1")}${dot("#7a8a96", "B2")}</p>`;
}

function racerPageHtml(agg: RacerAgg): string {
  const base = baseFor(2);
  const top3Rate = agg.starts > 0 ? Math.round(((agg.wins + agg.seconds + agg.thirds) / agg.starts) * 100) : 0;
  const rows = [...agg.appearances]
    .sort((a, b) => b.race.dateISO.localeCompare(a.race.dateISO) || b.race.raceNo - a.race.raceNo)
    .slice(0, 60)
    .map((a) => {
      const r = a.race;
      const resLabel =
        r.status === "verified" && r.result
          ? a.pos
            ? `${a.pos}着`
            : "4着以下"
          : "予定/未確定";
      return `<tr><td>${dateLabel(r.dateISO)}</td><td>${esc(r.venue)}</td><td>${r.raceNo}R</td>
        <td><span class="boat boat-${a.entry.lane}">${a.entry.lane}</span></td>
        <td>${pct(a.entry.preProb)}${a.isAiPick ? " ◎" : ""}</td>
        <td>${resLabel}</td>
        <td><a href="${base}${racePath(r)}">${r.status === "verified" ? "結果" : "直前分析"}</a></td></tr>`;
    })
    .join("\n");
  const aiNote =
    agg.aiPicks > 0
      ? `当サイトのAIが本命(◎)に指名したのは${agg.aiPicks}回、うち2着以内${agg.aiPickTop2}回。`
      : `当サイトのAI本命への指名はまだありません。`;
  const body = `
<div style="display:flex; align-items:center; gap:18px; margin-bottom:6px;">
  ${racerAvatar(agg.name, agg.racerClass, 72)}
  <div>
    <h1 style="margin:0;">${esc(agg.name)}(登番${agg.regNo})の成績・出走予定・AI評価</h1>
    <p style="color:var(--muted); margin:6px 0 0;">級別 <span style="color:${CLASS_COLOR[agg.racerClass] ?? "var(--cyan)"}; font-weight:700;">${esc(agg.racerClass)}</span>・全国勝率 ${agg.natWinRate.toFixed(2)}。当サイトのアーカイブ(公式配布データ)に基づく記録です。</p>
    ${avatarLegend()}
  </div>
</div>
<section><h2>当サイト集計の成績</h2><div class="card">
<p>結果確定済み ${agg.starts}走: <strong>1着${agg.wins}回・2着${agg.seconds}回・3着${agg.thirds}回</strong>(3連対率${top3Rate}%)。${aiNote}</p>
<p style="color:var(--dim); font-size:12px;">※当サイトが記録を開始した2026年7月以降の出走のみを集計した参考値です。通算成績は公式をご確認ください。</p>
</div></section>
<section><h2>出走履歴と結果</h2><div class="table-scroll"><table class="entries">
<thead><tr><th>日付</th><th>場</th><th>R</th><th>枠</th><th>AI事前勝率</th><th>結果</th><th>分析</th></tr></thead>
<tbody>${rows}</tbody></table></div></section>`;
  return articlePage({
    title: `${agg.name}(登番${agg.regNo})の成績・出走予定・AI評価｜競艇チョクゼン`,
    metaDesc: `ボートレーサー${agg.name}(登番${agg.regNo}・${agg.racerClass})の出走予定・直近成績・AI事前評価と結果記録。1着${agg.wins}回/3連対率${top3Rate}%(当サイト集計)。`,
    path: `racers/${agg.regNo}/`,
    base,
    crumbs: [["ホーム", base], ["選手一覧", `${base}racers/`], [`${agg.name}`]],
    bodyHtml: body,
  });
}

/* ---------- 日次結果まとめ(A2) ---------- */
function dailyPageHtml(dateISO: string, dayRaces: Race[]): string {
  const base = baseFor(2);
  const done = dayRaces.filter((r) => r.status === "verified" && r.result);
  const byPayout = [...done].sort((a, b) => (b.result!.payout3t ?? 0) - (a.result!.payout3t ?? 0));
  const manshu = byPayout.filter((r) => r.result!.payout3t >= 10000);
  const inLose = done.filter((r) => r.result!.finish[0] !== 1);
  const kimarite = new Map<string, number>();
  for (const r of done) kimarite.set(r.result!.kimarite, (kimarite.get(r.result!.kimarite) ?? 0) + 1);

  const rowOf = (r: Race) => `<tr><td>${esc(r.venue)}</td><td>${r.raceNo}R</td>
    <td>${r.result!.finish.join("-")}</td><td>${esc(r.result!.kimarite)}</td>
    <td>¥${r.result!.payout3t.toLocaleString()}</td><td>${r.result!.popularity}番人気</td>
    <td><a href="${base}${racePath(r)}">結果詳細</a></td></tr>`;

  const table = (rs: Race[]) => `<div class="table-scroll"><table class="entries">
<thead><tr><th>場</th><th>R</th><th>3連単</th><th>決まり手</th><th>払戻</th><th>人気</th><th>詳細</th></tr></thead>
<tbody>${rs.map(rowOf).join("\n")}</tbody></table></div>`;

  const kimariteHtml = [...kimarite.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${esc(k)} ${n}回`)
    .join(" / ");

  const body = `
<h1>${dateLabel(dateISO)}の競艇 結果まとめ — 高配当・万舟・イン逃げ崩れ</h1>
<p style="color:var(--muted);">確定${done.length}レースの結果・払戻を自動集計しています。</p>
<section><h2>高配当ランキング TOP5</h2>${table(byPayout.slice(0, 5))}</section>
<section><h2>万舟券(3連単1万円以上) — ${manshu.length}本</h2>${manshu.length ? table(manshu) : `<p style="color:var(--muted);">この日の万舟券はありませんでした。</p>`}</section>
<section><h2>イン逃げ崩れ — ${inLose.length}レース</h2>${inLose.length ? table(inLose.slice(0, 20)) : `<p style="color:var(--muted);">この日はインが崩れたレースはありませんでした。</p>`}</section>
<section><h2>決まり手の内訳</h2><div class="card"><p>${kimariteHtml || "—"}</p></div></section>
<section><h2>全レース結果</h2>${table(done)}</section>`;
  return articlePage({
    title: `${dateLabel(dateISO)}の競艇結果まとめ｜高配当・万舟・イン逃げ崩れ一覧｜競艇チョクゼン`,
    metaDesc: `${dateLabel(dateISO)}の競艇(ボートレース)全場の結果・払戻まとめ。高配当ランキング、万舟券${manshu.length}本、イン逃げ崩れ${inLose.length}レース、決まり手内訳を自動集計。`,
    path: `results/${dateISO}/`,
    base,
    crumbs: [["ホーム", base], ["結果まとめ", `${base}results/`], [dateLabel(dateISO)]],
    bodyHtml: body,
  });
}

/* ---------- 会場実測データ(A3) ---------- */
function venueStatsHtml(venue: string, list: Race[], base: string): string {
  const done = list.filter((r) => r.status === "verified" && r.result);
  if (done.length === 0) {
    return `<div class="card"><p style="color:var(--muted);">実測データは蓄積中です。結果データが増えると、イン逃げ実測率・決まり手分布・平均配当がここに表示されます。</p></div>`;
  }
  const n = done.length;
  const inWin = done.filter((r) => r.result!.finish[0] === 1).length;
  const inNige = done.filter((r) => r.result!.finish[0] === 1 && r.result!.kimarite === "逃げ").length;
  const avgPay = Math.round(done.reduce((a, r) => a + r.result!.payout3t, 0) / n);
  const manshu = done.filter((r) => r.result!.payout3t >= 10000).length;
  const kimarite = new Map<string, number>();
  for (const r of done) kimarite.set(r.result!.kimarite, (kimarite.get(r.result!.kimarite) ?? 0) + 1);
  const kHtml = [...kimarite.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${esc(k)} ${Math.round((c / n) * 100)}%`).join(" / ");
  const caveat = n < 30 ? `<p style="color:var(--dim); font-size:12px;">※まだ${n}レースの集計のため参考値です。蓄積とともに精度が上がります。</p>` : "";
  return `<div class="card">
<p><strong>${esc(venue)}の実測データ(当サイト集計${n}レース)</strong></p>
<p>1号艇1着率 <strong>${Math.round((inWin / n) * 100)}%</strong>(うちイン逃げ ${Math.round((inNige / n) * 100)}%) / 決まり手: ${kHtml}</p>
<p>3連単平均払戻 <strong>¥${avgPay.toLocaleString()}</strong> / 万舟券率 ${Math.round((manshu / n) * 100)}%</p>
${caveat}</div>`;
}

function stubPage(title: string, body: string, base: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - 競艇チョクゼン</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="icon" href="${base}assets/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="512x512" href="${base}assets/favicon-512.png">
<link rel="apple-touch-icon" href="${base}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${base}assets/styles.css">
${gaSnippet()}</head><body>
<header class="site"><div class="wrap"><a class="logo" href="${base}">競艇<span class="num">チョクゼン</span></a></div></header>
<main class="wrap article"><h1>${title}</h1><p style="color:var(--muted);">${body}</p>
<p><a href="${base}">← トップへ戻る</a></p></main>
<footer class="site"><div class="wrap"><div class="legal"><p>© 2026 競艇チョクゼン</p></div></div></footer></body></html>`;
}

/* ---------- グレードレース特設(SG/G1等) ---------- */
interface Feature {
  path: string;        // features/sg-omura-2026-07-10/
  title: string;       // 節タイトル
  grade: string;       // SG/G1/G2/G3
  venue: string;
  venueSlug: string;
  dates: string[];
  races: Race[];
}

function collectFeatures(races: Race[]): Feature[] {
  const map = new Map<string, Feature>();
  for (const r of races) {
    if (!r.grade || !r.seriesTitle) continue;
    const k = `${r.venueSlug}::${r.seriesTitle}`;
    let f = map.get(k);
    if (!f) {
      f = { path: "", title: r.seriesTitle, grade: r.grade, venue: r.venue, venueSlug: r.venueSlug, dates: [], races: [] };
      map.set(k, f);
    }
    f.races.push(r);
  }
  for (const f of map.values()) {
    f.dates = [...new Set(f.races.map((r) => r.dateISO))].sort();
    f.path = `features/${f.grade.toLowerCase()}-${f.venueSlug}-${f.dates[0]}/`;
  }
  return [...map.values()].sort((a, b) => b.dates[b.dates.length - 1].localeCompare(a.dates[a.dates.length - 1]));
}

function featurePageHtml(f: Feature): string {
  const base = baseFor(2);
  const done = f.races.filter((r) => r.status === "verified" && r.result);
  const topPay = [...done].sort((a, b) => b.result!.payout3t - a.result!.payout3t).slice(0, 3);
  const daySections = f.dates
    .map((d, i) => {
      const dayRaces = f.races.filter((r) => r.dateISO === d).sort((a, b) => a.raceNo - b.raceNo);
      return `<section><h2>${i + 1}日目 ${dateLabel(d)}</h2><div class="grid grid-3">${dayRaces
        .map((r) => raceCardForIndex(r, base))
        .join("\n")}</div></section>`;
    })
    .join("\n");
  const topPayHtml =
    topPay.length > 0
      ? `<section><h2>ここまでの高配当</h2><div class="card"><p>${topPay
          .map((r) => `${dateLabel(r.dateISO)} ${r.raceNo}R ¥${r.result!.payout3t.toLocaleString()}(${esc(r.result!.kimarite)})`)
          .join(" / ")}</p></div></section>`
      : "";
  const title = `${f.title}(${f.venue})の直前予想・結果まとめ｜競艇チョクゼン`;
  return articlePage({
    title,
    metaDesc: `${f.grade}「${f.title}」(ボートレース${f.venue})の全レース直前予想と結果・払戻。AI事前評価と展示反映のシグナル、払戻・決まり手を毎日自動更新。`,
    path: f.path,
    base,
    crumbs: [["ホーム", base], ["特設一覧", `${base}features/`], [`${f.grade} ${f.venue}`]],
    bodyHtml: `<h1>${esc(f.title)} — ${esc(f.venue)}競艇の直前予想・結果</h1>
<p style="color:var(--muted);"><span class="grade-badge">${esc(f.grade)}</span> 開催期間: ${dateLabel(f.dates[0])}〜${dateLabel(f.dates[f.dates.length - 1])}。締切15分前の直前更新と結果・払戻を全レース掲載します。</p>
${topPayHtml}
${daySections}`,
  });
}

/** 本日のレースを会場ごとにグルーピングして表示(締切が早い場から) */
function todayRacesGrouped(races: Race[], base: string, features: Feature[] = []): string {
  if (races.length === 0) return `<p style="color:var(--muted); font-size:13px;">本日のレースデータはありません。</p>`;
  const byVenue = new Map<string, Race[]>();
  for (const r of races) {
    const l = byVenue.get(r.venueSlug) ?? [];
    l.push(r);
    byVenue.set(r.venueSlug, l);
  }
  const now = Date.now();
  const isOpen = (r: Race) => new Date(closeIso(r)).getTime() > now && r.status !== "verified";
  const blocks = [...byVenue.values()]
    .map((list) => {
      // 締切前のレースを上に(締切順)、締切済み・検証済みは下に
      const upcoming = list.filter(isOpen).sort((a, b) => a.closeTime.localeCompare(b.closeTime));
      const finished = list.filter((r) => !isOpen(r)).sort((a, b) => a.raceNo - b.raceNo);
      const sorted = [...upcoming, ...finished];
      const next = upcoming[0] ?? finished[finished.length - 1];
      return { sorted, next, allDone: upcoming.length === 0, nextClose: closeIso(next) };
    })
    // 開催中の場を締切が近い順に上へ、全R終了の場は最下部へ
    .sort((a, b) => Number(a.allDone) - Number(b.allDone) || a.nextClose.localeCompare(b.nextClose))
    .map(({ sorted, next, allDone }) => {
      const v = sorted[0];
      const status = allDone
        ? `全${sorted.length}R終了・結果公開中`
        : `次の締切 ${next.raceNo}R ${next.closeTime}`;
      const feature = v.grade ? features.find((f) => f.venueSlug === v.venueSlug && f.title === v.seriesTitle) : undefined;
      const gradeHtml = feature
        ? ` <a href="${base}${feature.path}" class="grade-badge" title="${esc(feature.title)}">${esc(feature.grade)} 特設 →</a>`
        : v.grade
          ? ` <span class="grade-badge">${esc(v.grade)}</span>`
          : "";
      const header = `<h3 style="display:flex; align-items:baseline; gap:12px; margin-bottom:12px; font-size:17px;">
    <a href="${base}races/${v.venueSlug}/${v.dateISO}/" style="color:var(--text);">${esc(v.venue)}</a>${gradeHtml}
    <span style="color:var(--muted); font-size:12.5px; font-weight:400;">${status}</span>
    <a href="${base}races/${v.venueSlug}/" style="margin-left:auto; color:var(--cyan); font-size:12px;">会場データ →</a>
  </h3>`;

      // 締切前のレースだけカード表示。終了分はコンパクトなボタン列に畳む
      const upcoming = sorted.filter(isOpen);
      const finished = sorted
        .filter((r) => !isOpen(r))
        .sort((a, b) => a.raceNo - b.raceNo);
      const chip = (r: Race) =>
        `<a href="${base}${racePath(r)}" style="display:inline-block; padding:6px 11px; border-radius:8px; border:1px solid rgba(255,255,255,.12); color:var(--muted); font-size:12px;">${r.raceNo}R${r.status === "verified" ? ' <span style="color:var(--green);">済</span>' : ""}</a>`;
      const finishedRow =
        finished.length > 0
          ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:${upcoming.length > 0 ? "12px" : "0"}; align-items:center;">
      <span style="color:var(--dim); font-size:11.5px;">${upcoming.length > 0 ? "終了:" : ""}</span>
      ${finished.map(chip).join("\n")}
    </div>`
          : "";
      const cards =
        upcoming.length > 0 ? `<div class="grid grid-3">${upcoming.map((r) => raceCardForIndex(r, base)).join("\n")}</div>` : "";

      return `<div style="margin-bottom:${allDone ? "18px" : "30px"};">
  ${header}
  ${cards}
  ${finishedRow}
</div>`;
    });
  return blocks.join("\n");
}

/* ---------- 精度ダッシュボード(labs/signals) ---------- */
function dashboardHtml(races: Race[]): string {
  const base = baseFor(2);
  const done = races.filter((r) => r.status === "verified" && r.result);
  const n = done.length;

  let win = 0, top2 = 0, top3 = 0, recovSum = 0, recovN = 0, inWin = 0, inPreSum = 0;
  const byVenue = new Map<string, { venue: string; slug: string; n: number; aiWin: number; inWin: number }>();
  for (const r of done) {
    const pick = topPick(r);
    const pos = r.result!.finish.indexOf(pick.lane);
    if (pos === 0) win++;
    if (pos === 0 || pos === 1) top2++;
    if (pos >= 0) top3++;
    if (r.result!.payoutWin !== undefined) {
      recovN++;
      if (pos === 0) recovSum += r.result!.payoutWin;
    }
    inPreSum += r.inEscapeProbPre;
    if (r.result!.finish[0] === 1) inWin++;
    let v = byVenue.get(r.venueSlug);
    if (!v) { v = { venue: r.venue, slug: r.venueSlug, n: 0, aiWin: 0, inWin: 0 }; byVenue.set(r.venueSlug, v); }
    v.n++;
    if (pos === 0) v.aiWin++;
    if (r.result!.finish[0] === 1) v.inWin++;
  }
  const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const recovery = recovN > 0 ? Math.round((recovSum / (recovN * 100)) * 100) : 0;

  const statCards = n === 0
    ? `<div class="card"><p style="color:var(--muted);">検証データを蓄積中です。レース確定後、ここに全件の成績が自動集計されます。</p></div>`
    : `<div class="grid grid-3">
<div class="card"><h3>AI本命の1着率</h3><p style="font-size:28px; font-weight:900;">${pctOf(win, n)}%</p><p style="color:var(--dim); font-size:12px;">2連対率${pctOf(top2, n)}% / 3連対率${pctOf(top3, n)}%(${n}レース)</p></div>
<div class="card"><h3>AI本命の単勝仮想回収率</h3><p style="font-size:28px; font-weight:900;">${recovN > 0 ? `${recovery}%` : "—"}</p><p style="color:var(--dim); font-size:12px;">全対象レースの単勝に100円ずつ賭けた場合(${recovN}レース)</p></div>
<div class="card"><h3>イン評価の実測差</h3><p style="font-size:28px; font-weight:900;">${pctOf(inWin, n)}%</p><p style="color:var(--dim); font-size:12px;">1号艇1着の実測率。事前想定平均は${n > 0 ? Math.round(inPreSum / n) : 0}%</p></div>
</div>`;

  const venueRows = [...byVenue.values()]
    .sort((a, b) => b.n - a.n)
    .map((v) => `<tr><td><a href="${base}races/${v.slug}/">${esc(v.venue)}</a></td><td>${v.n}</td><td>${pctOf(v.aiWin, v.n)}%</td><td>${pctOf(v.inWin, v.n)}%</td></tr>`)
    .join("\n");
  const venueTable = n === 0 ? "" : `<section><h2>会場別の成績</h2><div class="table-scroll"><table class="entries">
<thead><tr><th>会場</th><th>検証R数</th><th>AI本命1着率</th><th>イン1着率</th></tr></thead><tbody>${venueRows}</tbody></table></div></section>`;

  return articlePage({
    title: "AI予想の成績公開(的中率・回収率を全件検証)｜競艇チョクゼン",
    metaDesc: `競艇チョクゼンのAI事前評価の成績を全件公開。AI本命1着率${pctOf(win, n)}%、単勝仮想回収率${recovN > 0 ? recovery + "%" : "集計中"}(検証${n}レース)。外れも含めた全レースの検証記録つき。`,
    path: "labs/signals/",
    base,
    crumbs: [["ホーム", base], ["AI予想の成績"]],
    bodyHtml: `<h1>AI予想の成績 — 的中も外れも、全件公開</h1>
<p style="color:var(--muted);">当サイトの事前評価(AI本命・イン逃げ確率)を確定結果と自動照合した成績です。都合の良いレースだけを切り取らず、全${n}レースを集計対象にしています。毎日自動更新。</p>
<section><h2>全体成績</h2>${statCards}</section>
${venueTable}
<section><h2>算出方法</h2><div class="card"><p style="font-size:13.5px; color:#cfdde6;">
・AI本命 = 各レースの事前AI勝率が最大の艇。レース締切前に公開したものをそのまま照合(後出しなし)。<br>
・単勝仮想回収率 = 全対象レースのAI本命に単勝100円ずつ賭けたと仮定した回収額÷投資額。<br>
・展示反映後のシグナル(乖離・前づけ・展示偏差)の種類別成績は、シグナル点灯フェーズの稼働後にここへ追加されます。<br>
・データソースは公式配布の番組表・競走成績ファイルです。</p></div></section>
<section><h2>検証記録を見る</h2><p><a href="${base}results/">日別の結果まとめ</a> / <a href="${base}racers/">選手別の成績</a></p></section>`,
  });
}

/* ---------- 明日のレース(A4: 前夜先行公開の導線) ---------- */
function addDaysISO(dateISO: string, delta: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function tomorrowSection(races: Race[], currentDate: string, base: string): string {
  const t = addDaysISO(currentDate, 1);
  const list = races.filter((r) => r.dateISO === t);
  if (list.length === 0) return "";
  const byVenue = new Map<string, Race[]>();
  for (const r of list) {
    const l = byVenue.get(r.venueSlug) ?? [];
    l.push(r);
    byVenue.set(r.venueSlug, l);
  }
  const cards = [...byVenue.values()]
    .map((l) => {
      const first = [...l].sort((a, b) => a.raceNo - b.raceNo)[0];
      return `<a class="card" href="${base}races/${first.venueSlug}/${t}/" style="color:var(--text);">
        <h3 style="font-size:15px; margin-bottom:6px;">${esc(first.venue)} 全${l.length}レース</h3>
        <p style="color:var(--muted); font-size:12.5px;">1R締切 ${first.closeTime}・事前評価公開中</p></a>`;
    })
    .join("\n");
  return `<h3 style="margin-top:28px; font-size:16px;">明日(${dateLabel(t)})のレース — 前夜から事前評価を公開中</h3>
  <div class="grid grid-3" style="margin-top:12px;">${cards}</div>`;
}

/* ---------- RSSフィード(ブログ村等の外部サービス連携・更新通知用) ---------- */
function rssXml(races: Race[], resultDates: string[]): string {
  const items: string[] = [];
  const rfc822 = (dateISO: string, hh: number) =>
    new Date(`${dateISO}T${String(hh).padStart(2, "0")}:00:00+09:00`).toUTCString();

  // 日別の結果まとめ(確定した日ごとに1記事)
  for (const d of [...resultDates].sort().reverse().slice(0, 20)) {
    const done = races.filter((r) => r.dateISO === d && r.status === "verified" && r.result);
    const max = Math.max(...done.map((r) => r.result!.payout3t));
    const manshu = done.filter((r) => r.result!.payout3t >= 10000).length;
    items.push(`  <item>
    <title>${esc(`${dateLabel(d)}の競艇結果まとめ — 検証${done.length}レース・最高配当¥${max.toLocaleString()}・万舟${manshu}本`)}</title>
    <link>${SITE_URL}/results/${d}/</link>
    <guid isPermaLink="true">${SITE_URL}/results/${d}/</guid>
    <pubDate>${rfc822(d, 22)}</pubDate>
    <description>${esc(`${dateLabel(d)}の競艇(ボートレース)全場の結果・払戻の自動集計。高配当ランキング、万舟券、イン逃げ崩れ、決まり手内訳。`)}</description>
  </item>`);
  }

  // 本日の予想一覧(毎日1記事)
  const dates = [...new Set(races.map((r) => r.dateISO))].sort().reverse().slice(0, 3);
  for (const d of dates) {
    const dayRaces = races.filter((r) => r.dateISO === d);
    const venues = new Set(dayRaces.map((r) => r.venueSlug)).size;
    const first = dayRaces[0];
    if (!first) continue;
    items.push(`  <item>
    <title>${esc(`${dateLabel(d)}の競艇 直前予想 — 全${venues}場${dayRaces.length}レースのAI事前評価を公開`)}</title>
    <link>${SITE_URL}/races/${first.venueSlug}/${d}/</link>
    <guid isPermaLink="true">${SITE_URL}/races/${first.venueSlug}/${d}/</guid>
    <pubDate>${rfc822(d, 8)}</pubDate>
    <description>${esc(`${dateLabel(d)}開催の全レースについて、AI事前評価とイン逃げ確率を無料公開。締切15分前の直前更新つき。`)}</description>
  </item>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>競艇チョクゼン — 締切15分前の直前予想とレース結果</title>
  <link>${SITE_URL}/</link>
  <description>競艇(ボートレース)全24場の直前予想をAIが自動分析。締切15分前の更新と、全レースの結果・払戻を毎日配信。</description>
  <language>ja</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.join("\n")}
</channel>
</rss>`;
}

/* ---------- sitemap / robots ---------- */
interface SitemapEntry { loc: string; lastmod: string }
function sitemaps(entries: SitemapEntry[]): { xml: string; robots: string } {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod></url>`).join("\n")}
</urlset>`;
  const robots = `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`;
  return { xml, robots };
}

/* ---------- main ---------- */
async function main() {
  const races = await loadAllRaces();
  console.log(`[build] ${races.length}レース分のページを生成します`);

  // 「本日」= JSTの今日。今日のデータが無ければ最新日を代表日とする
  const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const dates = [...new Set(races.map((r) => r.dateISO))].sort();
  const currentDate = dates.includes(jstToday) ? jstToday : dates[dates.length - 1];
  const todayRaces = races.filter((r) => r.dateISO === currentDate);
  const features = collectFeatures(races);

  await mkdir(DIST, { recursive: true });
  const assetsSrc = path.join(ROOT, "site", "assets");
  const assetsDst = path.join(DIST, "assets");
  await mkdir(assetsDst, { recursive: true });
  for (const f of await readdir(assetsSrc)) {
    await writeFile(path.join(assetsDst, f), await readFile(path.join(assetsSrc, f)));
  }

  // トップページ(マーカー置換をfillより先に)
  const indexBase = baseFor(0);
  let indexHtml = await readFile(path.join(ROOT, "site", "index.html"), "utf-8");
  indexHtml = indexHtml
    .replace("<!--{{NEXT_RACE_PANEL}}-->", nextRacePanel(todayRaces, indexBase))
    .replace("<!--{{SIGNAL_RACES}}-->", signalRaces(todayRaces, indexBase))
    .replace("<!--{{TODAY_RACES}}-->", todayRacesGrouped(todayRaces, indexBase, features))
    .replace("<!--{{TOMORROW_RACES}}-->", tomorrowSection(races, currentDate, indexBase))
    .replace("<!--{{REVIEW_RACES}}-->", reviewRaces(races, indexBase));
  indexHtml = fill(indexHtml, { BASE: indexBase, SITE_URL, GA_SNIPPET: gaSnippet() });
  await writeFile(path.join(DIST, "index.html"), indexHtml, "utf-8");

  // レース詳細(1レース=1URL・事前→シグナル→結果を同一URLで)
  const raceTpl = await readFile(path.join(ROOT, "templates", "race-detail.template.html"), "utf-8");
  const vStats = collectVenueStats(races);
  for (const r of races) await buildRacePage(raceTpl, r, races, vStats);

  // スタブページ(深度1)
  const stubs: [string, string, string][] = [
    ["about", "運営者情報", "運営者情報を掲載予定です。公開前に必ず記載してください。"],
    ["privacy", "プライバシーポリシー", "当サイトはアクセス解析のためGoogle Analyticsを使用しています。Google AnalyticsはCookieを使用してトラフィックデータを収集しますが、これは匿名で収集されており個人を特定するものではありません。Cookieの無効化はブラウザ設定から可能です。正式なプライバシーポリシー全文は準備中です。"],
    ["contact", "お問い合わせ", "お問い合わせ窓口を準備中です。"],
  ];
  for (const [slug, title, body] of stubs) {
    const dir = path.join(DIST, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), stubPage(title, body, baseFor(1)), "utf-8");
  }

  // 精度ダッシュボード(labs/signals: 実コンテンツ)
  const sigDir = path.join(DIST, "labs", "signals");
  await mkdir(sigDir, { recursive: true });
  await writeFile(path.join(sigDir, "index.html"), dashboardHtml(races), "utf-8");

  // グレードレース特設(SG/G1等)
  for (const f of features) {
    const dir = path.join(DIST, f.path);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), featurePageHtml(f), "utf-8");
  }
  const featBase = baseFor(1);
  const featLinks = features
    .map((f) => `<li style="margin-bottom:6px;"><a href="${featBase}${f.path}"><span class="grade-badge">${esc(f.grade)}</span> ${esc(f.title)}(${esc(f.venue)})</a> <span style="color:var(--dim); font-size:12px;">${dateLabel(f.dates[0])}〜</span></li>`)
    .join("\n");
  const featIndex = articlePage({
    title: "SG・G1などグレードレース特設一覧｜競艇チョクゼン",
    metaDesc: "競艇のSG・G1・G2・G3グレードレースの特設ページ一覧。開催節ごとに全レースの直前予想・結果を自動集約。",
    path: "features/",
    base: featBase,
    crumbs: [["ホーム", featBase], ["特設一覧"]],
    bodyHtml: `<h1>グレードレース特設一覧</h1>
<p style="color:var(--muted);">SG・G1等の開催節を検出すると、特設ページがここに自動追加されます。</p>
${features.length > 0 ? `<ul style="list-style:none;">${featLinks}</ul>` : `<p style="color:var(--muted);">現在アーカイブ内にグレードレースはありません。開催が始まると自動で追加されます。</p>`}`,
  });
  await mkdir(path.join(DIST, "features"), { recursive: true });
  await writeFile(path.join(DIST, "features", "index.html"), featIndex, "utf-8");

  // ラボ(ストックページ・深度2)
  const labs: [string, string, string][] = [
    ["maezuke", "前づけレースアーカイブ", "進入が動いたレースだけを集めた記録集です。隊形変化の内容・イン逃げ確率の変動・実際の結果を蓄積します。現在蓄積中です。"],
    ["venues", "会場別・展示の信頼度", "展示タイムが結果に直結しやすい会場・条件を、検証済みレースの蓄積から係数化して公開します。現在蓄積中です。"],
  ];
  for (const [slug, title, body] of labs) {
    const dir = path.join(DIST, "labs", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), stubPage(title, body, baseFor(2)), "utf-8");
  }

  // 会場・開催日ハブ
  const byVenue = new Map<string, Race[]>();
  for (const r of races) {
    const list = byVenue.get(r.venueSlug) ?? [];
    list.push(r);
    byVenue.set(r.venueSlug, list);
  }
  for (const [slug, list] of byVenue) {
    const venue = list[0].venue;
    const venueBase = baseFor(2);
    const links = [...list]
      .sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.raceNo - b.raceNo)
      .slice(0, 300)
      .map((r) => `<li style="margin-bottom:8px;"><a href="${venueBase}${racePath(r)}">${dateLabel(r.dateISO)} 第${r.raceNo}R ${esc(r.name)} の直前予想・結果</a></li>`)
      .join("\n");
    const html = articlePage({
      title: `${venue}競艇の予想と特徴データ(イン逃げ実測率・決まり手・平均配当)｜競艇チョクゼン`,
      metaDesc: `${venue}競艇(ボートレース${venue})のイン逃げ実測率・決まり手分布・平均払戻を確定レースの結果から自動集計。全レースの直前予想と結果の一覧つき。`,
      path: `races/${slug}/`,
      base: venueBase,
      crumbs: [["ホーム", venueBase], [`${venue}競艇`]],
      bodyHtml: `<h1>${esc(venue)}競艇場の特徴データと直前予想</h1>
<p style="color:var(--muted);">当サイトの結果アーカイブから、${esc(venue)}の実測傾向を毎日自動更新しています。</p>
<section><h2>実測データ</h2>${venueStatsHtml(venue, list, venueBase)}</section>
<section><h2>直前予想・結果一覧</h2><ul style="list-style:none;">${links}</ul></section>`,
    });
    const dir = path.join(DIST, "races", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), html, "utf-8");

    const byDate = new Map<string, Race[]>();
    for (const r of list) {
      const dl = byDate.get(r.dateISO) ?? [];
      dl.push(r);
      byDate.set(r.dateISO, dl);
    }
    for (const [dateISO, dl] of byDate) {
      const dayBase = baseFor(3);
      const dayLinks = dl
        .map((r) => `<li style="margin-bottom:8px;"><a href="${dayBase}${racePath(r)}">第${r.raceNo}R ${esc(r.name)} 締切${r.closeTime}</a></li>`)
        .join("\n");
      const dayHtml = stubPage(`${venue}競艇 ${dateLabel(dateISO)} 全レースの直前予想・結果`, "", dayBase).replace(
        "<p><a",
        `<ul style="list-style:none;">${dayLinks}</ul><p><a`
      );
      const dayDir = path.join(DIST, "races", slug, dateISO);
      await mkdir(dayDir, { recursive: true });
      await writeFile(path.join(dayDir, "index.html"), dayHtml, "utf-8");
    }
  }

  // 選手ページ(A1): 登番別に自動生成
  const racers = collectRacers(races);
  for (const agg of racers.values()) {
    const dir = path.join(DIST, "racers", agg.regNo);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), racerPageHtml(agg), "utf-8");
  }
  const racersBase = baseFor(1);
  const racerList = [...racers.values()].sort(
    (a, b) => b.appearances.length - a.appearances.length || a.regNo.localeCompare(b.regNo)
  );
  const racerLinks = racerList
    .map((a) => `<li style="margin-bottom:10px; display:flex; align-items:center; gap:10px;">${racerAvatar(a.name, a.racerClass, 32)}<a href="${racersBase}racers/${a.regNo}/">${esc(a.name)}(登番${a.regNo})</a> <span style="color:var(--dim); font-size:12px;">${esc(a.racerClass)}・掲載${a.appearances.length}走</span></li>`)
    .join("\n");
  const racersIndex = articlePage({
    title: "ボートレーサー選手データ一覧(成績・AI評価)｜競艇チョクゼン",
    metaDesc: "ボートレーサーの出走予定・直近成績・AI事前評価・結果記録を登録番号別に自動集計。公式配布データに基づく選手データベース。",
    path: "racers/",
    base: racersBase,
    crumbs: [["ホーム", racersBase], ["選手一覧"]],
    bodyHtml: `<h1>選手データ一覧</h1>
<p style="color:var(--muted);">当サイトのアーカイブに登場した選手のページを自動生成しています(毎日更新・拡大中)。</p>
${racerList.length > 0 ? `<ul style="list-style:none;">${racerLinks}</ul>` : `<p style="color:var(--muted);">蓄積中です。出走データが貯まると選手ページがここに追加されます。</p>`}`,
  });
  await mkdir(path.join(DIST, "racers"), { recursive: true });
  await writeFile(path.join(DIST, "racers", "index.html"), racersIndex, "utf-8");

  // 日次結果まとめ(A2)
  const resultDates = dates.filter((d) => races.some((r) => r.dateISO === d && r.status === "verified" && r.result));
  for (const d of resultDates) {
    const dir = path.join(DIST, "results", d);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), dailyPageHtml(d, races.filter((r) => r.dateISO === d)), "utf-8");
  }
  const resultsBase = baseFor(1);
  const resultsLinks = [...resultDates]
    .sort()
    .reverse()
    .map((d) => {
      const done = races.filter((r) => r.dateISO === d && r.status === "verified" && r.result);
      const max = Math.max(...done.map((r) => r.result!.payout3t));
      return `<li style="margin-bottom:6px;"><a href="${resultsBase}results/${d}/">${dateLabel(d)}の競艇結果まとめ</a> <span style="color:var(--dim); font-size:12px;">${done.length}レース・最高配当¥${max.toLocaleString()}</span></li>`;
    })
    .join("\n");
  const resultsIndex = articlePage({
    title: "今日の競艇結果まとめ｜万舟・高配当・イン逃げ崩れの日別一覧｜競艇チョクゼン",
    metaDesc: "競艇(ボートレース)の日別結果まとめ。高配当ランキング・万舟券・イン逃げ崩れ・決まり手内訳を毎日自動集計。",
    path: "results/",
    base: resultsBase,
    crumbs: [["ホーム", resultsBase], ["結果まとめ"]],
    bodyHtml: `<h1>日別の結果まとめ</h1>
<p style="color:var(--muted);">レース確定後に毎日自動生成。高配当・万舟・イン逃げ崩れを一覧できます。</p>
${resultDates.length > 0 ? `<ul style="list-style:none;">${resultsLinks}</ul>` : `<p style="color:var(--muted);">蓄積中です。本日のレース確定後、最初のまとめが生成されます。</p>`}`,
  });
  await mkdir(path.join(DIST, "results"), { recursive: true });
  await writeFile(path.join(DIST, "results", "index.html"), resultsIndex, "utf-8");

  // 用語・見方ガイド(A5): 実コンテンツ
  const guideBase = baseFor(1);
  const guideHtml = articlePage({
    title: "競艇の直前予想 用語ガイド(展示タイム・偏差・スリット・決まり手・歪み)｜競艇チョクゼン",
    metaDesc: "展示航走・展示タイム・進入(前づけ)・スリット・ST・決まり手6種・イン逃げ確率・オッズの歪みなど、競艇の直前予想に必要な用語と当サイトの指標の見方を解説。",
    path: "guide/",
    base: guideBase,
    crumbs: [["ホーム", guideBase], ["用語・見方ガイド"]],
    bodyHtml: `<h1>用語・見方ガイド — 直前予想に必要な知識と当サイト指標の読み方</h1>
<section><h2>用語別の詳しい解説</h2><div class="grid grid-3">${GUIDE_TERMS.map(
      (t) => `<a class="card" href="${guideBase}guide/${t.slug}/" style="color:var(--text);"><h3 style="font-size:14.5px; margin-bottom:6px;">${esc(t.term)}とは</h3><p style="color:var(--muted); font-size:12px;">${esc(t.metaDesc.slice(0, 55))}…</p></a>`
    ).join("\n")}</div></section>
<section><h2>展示航走とは</h2><p>本番レースの約15分前に行われるリハーサル走行のこと。スタート練習(スタート展示)と、全速の周回(周回展示)の2部構成で、ここで初めて「当日のモーターの実際の出足・伸び」「進入隊形」が可視化されます。番組表(前日確定)には存在しない情報のため、<strong>展示後にしか作れない予想がある</strong>——これが当サイトの出発点です。</p></section>
<section><h2>展示タイムと展示偏差</h2><p>展示タイムは周回展示で計測されるラップ。ただし水面・風・計測条件が場ごとに異なるため、絶対値の比較には意味が薄く、当サイトでは<strong>「当日のその水面の分布の中でどれだけ速いか」を偏差値(σ)化</strong>して表示します。+1σ以上は当日水準で明確に速い、-1σ以下は明確に遅い、が目安です。</p></section>
<section><h2>進入と前づけ</h2><p>競艇は枠なり進入(1号艇がイン)が基本ですが、スタート展示で外の艇が内のコースを取りにいく「前づけ」が起きると、全艇の勝率前提が崩れます。当サイトは進入変化を検知すると全艇の評価を再計算します(フォーメーションシグナル)。</p></section>
<section><h2>スリットとST</h2><p>STはスタートタイミング(0.15など小さいほど速い)。フライング(F)は-0.01秒でも大きなペナルティです。スタートラインを横一線に見た隊形を「スリット」と呼び、どの艇が出ているかで展開(逃げ/まくり/差し)の確率が大きく変わります。</p></section>
<section><h2>決まり手6種</h2><p><strong>逃げ</strong>(1コースがそのまま押し切る)、<strong>差し</strong>(内側を突く)、<strong>まくり</strong>(外から一気に抜く)、<strong>まくり差し</strong>(まくりつつ内へ)、<strong>抜き</strong>(道中逆転)、<strong>恵まれ</strong>(先行艇の事故等)。当サイトでは全レースの決まり手を自動記録し、会場ページで実測分布を公開しています。</p></section>
<section><h2>イン逃げ確率</h2><p>1号艇が逃げ切る確率の当サイト推定値。会場ごとの基準値(例: 大村は高い・戸田は低い)を、1号艇と対抗勢の力関係で補正して算出します。展示反映後には当日の気配で更新されます。</p></section>
<section><h2>歪み(乖離)とは — 当サイトの中核指標</h2><p>展示反映後のAI勝率と、直前オッズから逆算した市場の勝率のズレのこと。プラスに大きい艇は「AIは評価しているが市場(投票)がまだ織り込んでいない」状態で、当サイトはこれをシグナルとして点灯させます。<strong>予想の当たり外れではなく、期待値のズレを探す</strong>のがこの指標の目的です。</p></section>
<section><h2>結果アーカイブの見方</h2><p>レース確定後、同じURLに結果・払戻・決まり手を自動で追記し、日別の高配当・万舟・決まり手の集計とあわせて蓄積しています。<a href="${guideBase}results/">日別の結果まとめ</a>と<a href="${guideBase}labs/signals/">AI予想の通算成績</a>もあわせてご覧ください。</p></section>`,
  });
  const guideDir = path.join(DIST, "guide");
  await mkdir(guideDir, { recursive: true });
  await writeFile(path.join(guideDir, "index.html"), guideHtml, "utf-8");

  // 用語ページのFAQ(リッチリザルト用)。回答は本文の要約
  const GUIDE_FAQ: Record<string, { q: string; a: string }[]> = {
    tenji: [
      { q: "展示航走とは何ですか?", a: "本番レースの約15分前に全6艇が行うリハーサル走行です。スタート展示と周回展示の2部構成で、当日のモーターの仕上がりや進入隊形が分かります。" },
      { q: "展示航走はどこを見ればいいですか?", a: "スタート展示では進入コースと展示ST、周回展示では展示タイム(伸び足)を見ます。番組表にない当日情報が出揃うのが展示後です。" },
    ],
    "tenji-time": [
      { q: "展示タイムとは何ですか?", a: "周回展示で計測される走行タイムで、当日のモーターの伸び足を数値で確認できる直前情報です。" },
      { q: "展示タイムはあてになりますか?", a: "絶対値ではなくレース内6艇の比較で使えば有効です。特に極端に良い・悪い艇の検出に役立ち、会場によって結果への直結度が異なります。" },
    ],
    maezuke: [
      { q: "前づけとは何ですか?", a: "スタート前の進入で外枠の艇が内側のコースを取りにいく行為です。枠なり進入が崩れ、レースの前提が変わります。" },
      { q: "前づけが起きると予想はどう変わりますか?", a: "競艇はコースが勝率に直結するため、イン(1コース)を取った艇の評価が大きく上がり、番組表ベースの事前予想は作り直しになります。" },
    ],
    slit: [
      { q: "競艇のスリットとは何ですか?", a: "スタートライン通過時の6艇を横一線に見た隊形のことです。スリットで前に出た艇が展開の主導権を握ります。" },
      { q: "STとは何ですか?", a: "スタートタイミングの略で、大時計0秒からスタートライン通過までの時間です。小さいほど速く、0秒より早いとフライング(F)になります。" },
    ],
    kimarite: [
      { q: "競艇の決まり手は何種類ありますか?", a: "逃げ・差し・まくり・まくり差し・抜き・恵まれの6種類です。最多は1コースがそのまま押し切る「逃げ」です。" },
      { q: "まくりとまくり差しの違いは?", a: "まくりは外側から全速で先行艇を抑えて抜く技、まくり差しはまくりに行きながら内側へ切り込んで差す複合技です。" },
    ],
    innige: [
      { q: "イン逃げとは何ですか?", a: "1コース(イン)の艇が第1ターンマークを先に回り、そのまま1着でゴールすることです。1コースの1着率は全国平均で約55%です。" },
      { q: "イン逃げしやすい競艇場はどこですか?", a: "大村や徳山は60%を超える「イン天国」、戸田・平和島・江戸川などは40%台の難水面とされます。当サイトでは会場別の実測値を毎日更新しています。" },
    ],
    manshu: [
      { q: "万舟券とは何ですか?", a: "3連単の払戻金が10,000円以上になった高配当のことです。100円の舟券が1万円以上になるケースを指します。" },
      { q: "万舟券はどのくらいの頻度で出ますか?", a: "発生率は15〜17%程度で、全国で1日あたりおおよそ20レース前後発生すると言われます。" },
    ],
    sanrentan: [
      { q: "競艇の3連単とは何ですか?", a: "1着・2着・3着を着順どおりに当てる舟券です。組み合わせは120通りで、競艇の売上の大半を占める主力の券種です。" },
      { q: "3連単の人気とは何ですか?", a: "120通りの組み合わせの中で何番目に票を集めたかを示す指標です。1〜3番人気の決着は順当、10番人気台は中穴、それ以上は波乱と呼ばれます。" },
    ],
    "odds-yugami": [
      { q: "オッズの歪みとは何ですか?", a: "オッズから逆算した市場の想定確率と、データ分析上の実際の確率のズレのことです。過小評価されている艇には期待値のプラスが生まれます。" },
      { q: "なぜ締切直前に歪みが生まれるのですか?", a: "展示航走の情報が投票に反映される速度は人によって違うため、直前はオッズがまだ当日情報を織り込みきれていない時間帯だからです。" },
    ],
    "ai-yosou": [
      { q: "競艇のAI予想とは何ですか?", a: "選手成績・モーター・コース・展示情報などのデータから、機械的に各艇の勝率や買い目を算出する予想手法です。" },
      { q: "AI予想の精度はどう確かめればいいですか?", a: "全レースを対象にしているか、予想を締切前に公開しているか(後出しでないか)、回収率まで公開しているかの3点を確認するのが基本です。" },
    ],
  };
  const GUIDE_PUBLISHED = "2026-07-08";

  // 用語の個別記事ページ(/guide/{slug}/)
  const termBase = baseFor(2);
  for (const t of GUIDE_TERMS) {
    const related = GUIDE_TERMS.filter((x) => x.slug !== t.slug)
      .slice(0, 6)
      .map((x) => `<li style="margin-bottom:6px;"><a href="${termBase}guide/${x.slug}/">${esc(x.term)}とは</a></li>`)
      .join("\n");
    const faq = GUIDE_FAQ[t.slug];
    const jsonLd: object[] = [
      {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: t.title,
        description: t.metaDesc,
        datePublished: GUIDE_PUBLISHED,
        dateModified: GUIDE_PUBLISHED,
        image: `${SITE_URL}/assets/og-image.png`,
        author: { "@type": "Organization", name: "競艇チョクゼン", url: `${SITE_URL}/` },
        publisher: { "@type": "Organization", name: "競艇チョクゼン" },
        mainEntityOfPage: `${SITE_URL}/guide/${t.slug}/`,
      },
      ...(faq
        ? [{
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((x) => ({
              "@type": "Question",
              name: x.q,
              acceptedAnswer: { "@type": "Answer", text: x.a },
            })),
          }]
        : []),
    ];
    const faqHtml = faq
      ? `<section><h2>よくある質問</h2>${faq
          .map((x) => `<div class="card" style="margin-bottom:10px;"><p style="font-weight:700;">Q. ${esc(x.q)}</p><p style="color:#cfdde6; font-size:13.5px;">A. ${esc(x.a)}</p></div>`)
          .join("\n")}</section>`
      : "";
    const html = articlePage({
      title: `${t.title}｜競艇チョクゼン`,
      metaDesc: t.metaDesc,
      path: `guide/${t.slug}/`,
      base: termBase,
      crumbs: [["ホーム", termBase], ["用語・見方ガイド", `${termBase}guide/`], [t.term]],
      jsonLd,
      bodyHtml: `<h1>${esc(t.title)}</h1>
${t.bodyHtml.replaceAll("{{BASE}}", termBase)}
${faqHtml}
<section><h2>あわせて読みたい用語</h2><ul style="list-style:none;">${related}</ul>
<p><a href="${termBase}guide/">用語・見方ガイド一覧へ</a> / <a href="${termBase}">今日の直前予想を見る</a></p></section>`,
    });
    const dir = path.join(guideDir, t.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), html, "utf-8");
  }

  await writeFile(path.join(DIST, "feed.xml"), rssXml(races, resultDates), "utf-8");

  // sitemap: 全ページを登録(lastmodは実際の更新日)
  const dateOf = (iso: string) => iso.slice(0, 10);
  const dayLastmod = new Map<string, string>();
  for (const r of races) {
    const key = `${r.venueSlug}/${r.dateISO}`;
    const d = dateOf(r.updatedAt);
    if ((dayLastmod.get(key) ?? "") < d) dayLastmod.set(key, d);
  }
  // 選手ページ: 掲載3走未満はコンテンツが薄いためsitemapから除外(ページ自体は存在)
  const solidRacers = [...racers.values()].filter((a) => a.appearances.length >= 3);
  const racerLastmod = (a: RacerAgg) =>
    dateOf([...a.appearances].sort((x, y) => y.race.updatedAt.localeCompare(x.race.updatedAt))[0].race.updatedAt);

  const entries: SitemapEntry[] = [
    { loc: `${SITE_URL}/`, lastmod: jstToday },
    ...races.map((r) => ({ loc: `${SITE_URL}/${racePath(r)}`, lastmod: dateOf(r.updatedAt) })),
    ...[...byVenue.keys()].map((s) => ({ loc: `${SITE_URL}/races/${s}/`, lastmod: jstToday })),
    ...[...dayLastmod.entries()].map(([p, d]) => ({ loc: `${SITE_URL}/races/${p}/`, lastmod: d })),
    { loc: `${SITE_URL}/results/`, lastmod: jstToday },
    ...resultDates.map((d) => ({ loc: `${SITE_URL}/results/${d}/`, lastmod: d })),
    { loc: `${SITE_URL}/racers/`, lastmod: jstToday },
    ...solidRacers.map((a) => ({ loc: `${SITE_URL}/racers/${a.regNo}/`, lastmod: racerLastmod(a) })),
    { loc: `${SITE_URL}/guide/`, lastmod: GUIDE_PUBLISHED },
    ...GUIDE_TERMS.map((t) => ({ loc: `${SITE_URL}/guide/${t.slug}/`, lastmod: GUIDE_PUBLISHED })),
    { loc: `${SITE_URL}/features/`, lastmod: jstToday },
    ...features.map((f) => ({
      loc: `${SITE_URL}/${f.path}`,
      lastmod: dateOf([...f.races].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0].updatedAt),
    })),
    { loc: `${SITE_URL}/labs/signals/`, lastmod: jstToday },
    { loc: `${SITE_URL}/labs/maezuke/`, lastmod: GUIDE_PUBLISHED },
    { loc: `${SITE_URL}/labs/venues/`, lastmod: GUIDE_PUBLISHED },
  ];
  const { xml, robots } = sitemaps(entries);
  await writeFile(path.join(DIST, "sitemap.xml"), xml, "utf-8");
  await writeFile(path.join(DIST, "robots.txt"), robots, "utf-8");
  await writeFile(path.join(DIST, "favicon.ico"), await readFile(path.join(ROOT, "site", "assets", "favicon.ico")));
  await writeFile(path.join(DIST, ".nojekyll"), "", "utf-8");

  console.log(`[build] 完了: レース${races.length} / 選手${racers.size} / 結果まとめ${resultDates.length}日分 → ${DIST}`);
}

main().catch((e) => {
  console.error("[build] 失敗:", e);
  process.exit(1);
});

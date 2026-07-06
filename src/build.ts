/**
 * 静的サイトジェネレータ。
 * data/latest-races.json + テンプレート → dist/ (GitHub Pages 配信物) を生成。
 * リンクはページ深度に応じた相対パス(ローカルで直接開いても表示可能)。
 *
 * レースページは同一URLで 事前(pre) → シグナル(signal) → 答え合わせ(verified) と進化する。
 *
 * 環境変数:
 * - SITE_URL: 本番URL (canonical / sitemap / JSON-LD 用)
 */
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Race, Entry, Signal, RaceStatus } from "./types.ts";
import { loadAllRaces } from "./store.ts";

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
  verified: { cls: "status-verified", label: "答え合わせ済み" },
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

function entriesRows(r: Race): string {
  const best = topPick(r);
  return r.entries
    .map((e) => {
      const topClass = e.lane === best.lane ? ` class="top-pick"` : "";
      return `<tr${topClass}>
        <td><span class="boat boat-${e.lane}">${e.lane}</span></td>
        <td class="racer-name">${esc(e.name)}</td>
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
      const hit =
        r.status === "verified" && s.hit !== undefined
          ? `<span class="hit-mark ${s.hit ? "hit-yes" : "hit-no"}">${s.hit ? "的中" : "不発"}</span>`
          : "";
      return `<div class="diff-item">
        <span class="diff-time">${s.time}</span>
        <span class="diff-icon ${cls}">${mark}</span>
        <span class="diff-text">${esc(s.text)}${hit}</span>
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

function resultSection(r: Race): string {
  if (r.status !== "verified" || !r.result) return "";
  const res = r.result;
  const order = res.finish
    .map((lane, i) => `<span class="boat boat-${lane}">${lane}</span>${i < res.finish.length - 1 ? `<span class="arrow">→</span>` : ""}`)
    .join("");
  return `<section>
    <h2>結果と答え合わせ — 直前サインはどう効いたか</h2>
    <div class="result-box">
      <h3>RESULT</h3>
      <div class="finish-order">${order}
        <span style="color:var(--muted); font-size:13px; margin-left:8px;">決まり手: ${esc(res.kimarite)}</span>
        <span class="payout" style="margin-left:auto;">3連単 ¥${res.payout3t.toLocaleString()} (${res.popularity}番人気)</span>
      </div>
      <p style="color:#cfdde6; font-size:14.5px;">${esc(res.review)}</p>
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
      ? `<span style="color:var(--green); font-size:12.5px;">結果検証を読む → 3連単 ¥${r.result.payout3t.toLocaleString()}</span>`
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
    return `<p style="color:var(--muted); font-size:13px;">検証済みレースはまだありません。レース確定後、結果と答え合わせが順次ここに蓄積されます。</p>`;
  return done.slice(0, 18).map((r) => raceCardForIndex(r, base)).join("\n");
}

function otherRacesHtml(all: Race[], current: Race, base: string): string {
  const others = all.filter((r) => r.raceId !== current.raceId && r.dateISO === current.dateISO);
  if (others.length === 0) return `<p style="color:var(--muted); font-size:13px;">同日の他レースはありません。</p>`;
  return others
    .map(
      (r) => `<a class="card race-card" href="${base}${racePath(r)}" style="color:var(--text);">
        <div class="head"><span class="venue">${esc(r.venue)} ${r.raceNo}R</span><span class="countdown" data-close="${closeIso(r)}">--:--</span></div>
        <div>${statusBadge(r)}</div>
      </a>`
    )
    .join("\n");
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

function sportsEventJsonLd(r: Race): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: `${r.venue} 第${r.raceNo}R ${r.name}`,
    sport: "Motorboat racing",
    startDate: closeIso(r),
    location: { "@type": "Place", name: `ボートレース${r.venue}` },
  });
}

/* ---------- page builders ---------- */
function verdictTitle(status: RaceStatus): string {
  if (status === "pre") return "事前評価（展示前・確定前の暫定）";
  if (status === "signal") return "直前最終結論（展示反映済み）";
  return "このレースの結論はこうだった";
}

async function buildRacePage(template: string, r: Race, all: Race[]): Promise<void> {
  const base = baseFor(4);
  const m = STATUS_META[r.status];
  const inDelta = r.inEscapeProb - r.inEscapeProbPre;
  const title =
    r.status === "verified"
      ? `${r.venue}競艇 ${r.raceNo}R 結果・払戻と答え合わせ ${dateLabel(r.dateISO)}｜競艇チョクゼン`
      : `${r.venue}競艇 ${r.raceNo}R 直前予想【締切15分前に最終更新】${dateLabel(r.dateISO)}｜競艇チョクゼン`;
  const metaDesc =
    r.status === "verified"
      ? `${r.venue}競艇${r.raceNo}R(${dateLabel(r.dateISO)})のレース結果・払戻と答え合わせ。展示・オッズの直前サインがどう効いたかを検証。3連単¥${r.result?.payout3t.toLocaleString() ?? "—"}。`
      : `${r.venue}競艇${r.raceNo}R(${dateLabel(r.dateISO)} 締切${r.closeTime})の直前予想。展示航走反映のイン逃げ確率${r.inEscapeProb}%、AI勝率とオッズの乖離、スリット予測を無料公開。`;

  const html = fill(template, {
    BASE: base,
    SITE_URL,
    GA_SNIPPET: gaSnippet(),
    TITLE: esc(title),
    META_DESC: esc(metaDesc),
    CANONICAL: `${SITE_URL}/${racePath(r)}`,
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
    KIMARITE_BAR: kimariteBar(r),
    KIMARITE_NOTE: esc(r.kimariteNote),
    ENTRIES_ROWS: entriesRows(r),
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

/** 実コンテンツ用のページシェル(canonical・meta description・パンくず付き) */
function articlePage(opts: {
  title: string;
  metaDesc: string;
  path: string;        // 例 "racers/4444/" (末尾スラッシュ)
  base: string;
  crumbs: [string, string?][]; // [ラベル, href?]
  bodyHtml: string;
}): string {
  const crumbHtml = opts.crumbs
    .map(([label, href]) => (href ? `<a href="${href}">${esc(label)}</a>` : esc(label)))
    .join(`<span class="sep">›</span>`);
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.metaDesc)}">
<link rel="canonical" href="${SITE_URL}/${opts.path}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
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
        <td><a href="${base}${racePath(r)}">${r.status === "verified" ? "答え合わせ" : "直前分析"}</a></td></tr>`;
    })
    .join("\n");
  const aiNote =
    agg.aiPicks > 0
      ? `当サイトのAIが本命(◎)に指名したのは${agg.aiPicks}回、うち2着以内${agg.aiPickTop2}回。`
      : `当サイトのAI本命への指名はまだありません。`;
  const body = `
<h1>${esc(agg.name)}(登番${agg.regNo})の成績・出走予定・AI評価</h1>
<p style="color:var(--muted);">級別 ${esc(agg.racerClass)}・全国勝率 ${agg.natWinRate.toFixed(2)}。当サイトのアーカイブ(公式配布データ)に基づく記録です。</p>
<section><h2>当サイト集計の成績</h2><div class="card">
<p>結果確定済み ${agg.starts}走: <strong>1着${agg.wins}回・2着${agg.seconds}回・3着${agg.thirds}回</strong>(3連対率${top3Rate}%)。${aiNote}</p>
<p style="color:var(--dim); font-size:12px;">※当サイトが答え合わせを開始した2026年7月以降の出走のみを集計した参考値です。通算成績は公式をご確認ください。</p>
</div></section>
<section><h2>出走履歴と答え合わせ</h2><div class="table-scroll"><table class="entries">
<thead><tr><th>日付</th><th>場</th><th>R</th><th>枠</th><th>AI事前勝率</th><th>結果</th><th>分析</th></tr></thead>
<tbody>${rows}</tbody></table></div></section>`;
  return articlePage({
    title: `${agg.name}(登番${agg.regNo})の成績・出走予定・AI評価｜競艇チョクゼン`,
    metaDesc: `ボートレーサー${agg.name}(登番${agg.regNo}・${agg.racerClass})の出走予定・直近成績・AI事前評価と答え合わせ記録。1着${agg.wins}回/3連対率${top3Rate}%(当サイト集計)。`,
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
    <td><a href="${base}${racePath(r)}">答え合わせ</a></td></tr>`;

  const table = (rs: Race[]) => `<div class="table-scroll"><table class="entries">
<thead><tr><th>場</th><th>R</th><th>3連単</th><th>決まり手</th><th>払戻</th><th>人気</th><th>詳細</th></tr></thead>
<tbody>${rs.map(rowOf).join("\n")}</tbody></table></div>`;

  const kimariteHtml = [...kimarite.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${esc(k)} ${n}回`)
    .join(" / ");

  const body = `
<h1>${dateLabel(dateISO)}の競艇 結果まとめ — 高配当・万舟・イン逃げ崩れ</h1>
<p style="color:var(--muted);">確定${done.length}レースの結果・払戻を自動集計。各レースの「答え合わせ」では直前サインの検証を公開しています。</p>
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
    return `<div class="card"><p style="color:var(--muted);">実測データは蓄積中です。答え合わせ済みレースが増えると、イン逃げ実測率・決まり手分布・平均配当がここに表示されます。</p></div>`;
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
<p><strong>${esc(venue)}の実測データ(当サイト答え合わせ${n}レース集計)</strong></p>
<p>1号艇1着率 <strong>${Math.round((inWin / n) * 100)}%</strong>(うちイン逃げ ${Math.round((inNige / n) * 100)}%) / 決まり手: ${kHtml}</p>
<p>3連単平均払戻 <strong>¥${avgPay.toLocaleString()}</strong> / 万舟券率 ${Math.round((manshu / n) * 100)}%</p>
${caveat}</div>`;
}

function stubPage(title: string, body: string, base: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - 競艇チョクゼン</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${base}assets/styles.css">
${gaSnippet()}</head><body>
<header class="site"><div class="wrap"><a class="logo" href="${base}">競艇<span class="num">チョクゼン</span></a></div></header>
<main class="wrap article"><h1>${title}</h1><p style="color:var(--muted);">${body}</p>
<p><a href="${base}">← トップへ戻る</a></p></main>
<footer class="site"><div class="wrap"><div class="legal"><p>© 2026 競艇チョクゼン</p></div></div></footer></body></html>`;
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

/* ---------- sitemap / robots ---------- */
function sitemaps(urls: string[]): { xml: string; robots: string } {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>`).join("\n")}
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
    .replace("<!--{{TODAY_RACES}}-->", todayRaces.map((r) => raceCardForIndex(r, indexBase)).join("\n"))
    .replace("<!--{{TOMORROW_RACES}}-->", tomorrowSection(races, currentDate, indexBase))
    .replace("<!--{{REVIEW_RACES}}-->", reviewRaces(races, indexBase));
  indexHtml = fill(indexHtml, { BASE: indexBase, SITE_URL, GA_SNIPPET: gaSnippet() });
  await writeFile(path.join(DIST, "index.html"), indexHtml, "utf-8");

  // レース詳細(1レース=1URL・事前→シグナル→答え合わせを同一URLで)
  const raceTpl = await readFile(path.join(ROOT, "templates", "race-detail.template.html"), "utf-8");
  for (const r of races) await buildRacePage(raceTpl, r, races);

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

  // ラボ(ストックページ・深度2)
  const labs: [string, string, string][] = [
    ["signals", "シグナル種類別の成績", "乖離・前づけ・展示偏差の各シグナルの的中率・回収率を、検証済みレースの蓄積から算出して公開します。現在蓄積中です。算出方法: 全シグナルをレース締切前に記録し、確定結果と自動照合。"],
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
      .map((r) => `<li style="margin-bottom:8px;"><a href="${venueBase}${racePath(r)}">${dateLabel(r.dateISO)} 第${r.raceNo}R ${esc(r.name)} の直前分析・答え合わせ</a></li>`)
      .join("\n");
    const html = articlePage({
      title: `${venue}競艇場の特徴データと直前予想・結果一覧｜競艇チョクゼン`,
      metaDesc: `${venue}競艇(ボートレース${venue})のイン逃げ実測率・決まり手分布・平均払戻を答え合わせ済みレースから自動集計。全レースの直前予想と結果検証の一覧つき。`,
      path: `races/${slug}/`,
      base: venueBase,
      crumbs: [["ホーム", venueBase], [`${venue}競艇`]],
      bodyHtml: `<h1>${esc(venue)}競艇場の特徴データと直前予想</h1>
<p style="color:var(--muted);">当サイトの答え合わせ(結果検証)アーカイブから、${esc(venue)}の実測傾向を毎日自動更新しています。</p>
<section><h2>実測データ</h2>${venueStatsHtml(venue, list, venueBase)}</section>
<section><h2>直前予想・答え合わせ一覧</h2><ul style="list-style:none;">${links}</ul></section>`,
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
    .map((a) => `<li style="margin-bottom:6px;"><a href="${racersBase}racers/${a.regNo}/">${esc(a.name)}(登番${a.regNo})</a> <span style="color:var(--dim); font-size:12px;">${esc(a.racerClass)}・掲載${a.appearances.length}走</span></li>`)
    .join("\n");
  const racersIndex = articlePage({
    title: "ボートレーサー選手データ一覧(成績・AI評価)｜競艇チョクゼン",
    metaDesc: "ボートレーサーの出走予定・直近成績・AI事前評価・答え合わせ記録を登録番号別に自動集計。公式配布データに基づく選手データベース。",
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
    title: "競艇の結果まとめ一覧(日別の高配当・万舟・イン逃げ崩れ)｜競艇チョクゼン",
    metaDesc: "競艇(ボートレース)の日別結果まとめ。高配当ランキング・万舟券・イン逃げ崩れ・決まり手内訳を毎日自動集計し、各レースの答え合わせにリンク。",
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
<section><h2>展示航走とは</h2><p>本番レースの約15分前に行われるリハーサル走行のこと。スタート練習(スタート展示)と、全速の周回(周回展示)の2部構成で、ここで初めて「当日のモーターの実際の出足・伸び」「進入隊形」が可視化されます。番組表(前日確定)には存在しない情報のため、<strong>展示後にしか作れない予想がある</strong>——これが当サイトの出発点です。</p></section>
<section><h2>展示タイムと展示偏差</h2><p>展示タイムは周回展示で計測されるラップ。ただし水面・風・計測条件が場ごとに異なるため、絶対値の比較には意味が薄く、当サイトでは<strong>「当日のその水面の分布の中でどれだけ速いか」を偏差値(σ)化</strong>して表示します。+1σ以上は当日水準で明確に速い、-1σ以下は明確に遅い、が目安です。</p></section>
<section><h2>進入と前づけ</h2><p>競艇は枠なり進入(1号艇がイン)が基本ですが、スタート展示で外の艇が内のコースを取りにいく「前づけ」が起きると、全艇の勝率前提が崩れます。当サイトは進入変化を検知すると全艇の評価を再計算します(フォーメーションシグナル)。</p></section>
<section><h2>スリットとST</h2><p>STはスタートタイミング(0.15など小さいほど速い)。フライング(F)は-0.01秒でも大きなペナルティです。スタートラインを横一線に見た隊形を「スリット」と呼び、どの艇が出ているかで展開(逃げ/まくり/差し)の確率が大きく変わります。</p></section>
<section><h2>決まり手6種</h2><p><strong>逃げ</strong>(1コースがそのまま押し切る)、<strong>差し</strong>(内側を突く)、<strong>まくり</strong>(外から一気に抜く)、<strong>まくり差し</strong>(まくりつつ内へ)、<strong>抜き</strong>(道中逆転)、<strong>恵まれ</strong>(先行艇の事故等)。当サイトの答え合わせページでは全レースの決まり手を記録し、会場ページで実測分布を公開しています。</p></section>
<section><h2>イン逃げ確率</h2><p>1号艇が逃げ切る確率の当サイト推定値。会場ごとの基準値(例: 大村は高い・戸田は低い)を、1号艇と対抗勢の力関係で補正して算出します。展示反映後には当日の気配で更新されます。</p></section>
<section><h2>歪み(乖離)とは — 当サイトの中核指標</h2><p>展示反映後のAI勝率と、直前オッズから逆算した市場の勝率のズレのこと。プラスに大きい艇は「AIは評価しているが市場(投票)がまだ織り込んでいない」状態で、当サイトはこれをシグナルとして点灯させます。<strong>予想の当たり外れではなく、期待値のズレを探す</strong>のがこの指標の目的です。</p></section>
<section><h2>答え合わせ(検証)の読み方</h2><p>レース確定後、同じURLに結果・払戻・決まり手と「事前評価がどう当たり、どう外れたか」を追記します。的中だけを誇示せず外れも同じ形式で記録することが、当サイトの信頼性の根拠です。<a href="${guideBase}results/">日別の結果まとめ</a>と<a href="${guideBase}labs/signals/">シグナル成績</a>もあわせてご覧ください。</p></section>`,
  });
  const guideDir = path.join(DIST, "guide");
  await mkdir(guideDir, { recursive: true });
  await writeFile(path.join(guideDir, "index.html"), guideHtml, "utf-8");

  // sitemap: 全ページを登録
  const urls = [
    `${SITE_URL}/`,
    ...races.map((r) => `${SITE_URL}/${racePath(r)}`),
    ...[...byVenue.keys()].map((s) => `${SITE_URL}/races/${s}/`),
    ...[...new Set(races.map((r) => `races/${r.venueSlug}/${r.dateISO}/`))].map((p) => `${SITE_URL}/${p}`),
    `${SITE_URL}/results/`,
    ...resultDates.map((d) => `${SITE_URL}/results/${d}/`),
    `${SITE_URL}/racers/`,
    ...[...racers.keys()].map((reg) => `${SITE_URL}/racers/${reg}/`),
    `${SITE_URL}/guide/`,
    `${SITE_URL}/labs/signals/`,
    `${SITE_URL}/labs/maezuke/`,
    `${SITE_URL}/labs/venues/`,
  ];
  const { xml, robots } = sitemaps(urls);
  await writeFile(path.join(DIST, "sitemap.xml"), xml, "utf-8");
  await writeFile(path.join(DIST, "robots.txt"), robots, "utf-8");
  await writeFile(path.join(DIST, ".nojekyll"), "", "utf-8");

  console.log(`[build] 完了: レース${races.length} / 選手${racers.size} / 結果まとめ${resultDates.length}日分 → ${DIST}`);
}

main().catch((e) => {
  console.error("[build] 失敗:", e);
  process.exit(1);
});

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
import { loadRaces } from "./store.ts";

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
  const done = races.filter((r) => r.status === "verified");
  if (done.length === 0) return `<p style="color:var(--muted); font-size:13px;">本日の検証済みレースはまだありません。</p>`;
  return done.map((r) => raceCardForIndex(r, base)).join("\n");
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

/* ---------- sitemap / robots ---------- */
function sitemaps(races: Race[]): { xml: string; robots: string } {
  const urls = [`${SITE_URL}/`, ...races.map((r) => `${SITE_URL}/${racePath(r)}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>`).join("\n")}
</urlset>`;
  const robots = `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`;
  return { xml, robots };
}

/* ---------- main ---------- */
async function main() {
  const races = await loadRaces();
  console.log(`[build] ${races.length}レース分のページを生成します`);

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
    .replace("<!--{{NEXT_RACE_PANEL}}-->", nextRacePanel(races, indexBase))
    .replace("<!--{{SIGNAL_RACES}}-->", signalRaces(races, indexBase))
    .replace("<!--{{TODAY_RACES}}-->", races.map((r) => raceCardForIndex(r, indexBase)).join("\n"))
    .replace("<!--{{REVIEW_RACES}}-->", reviewRaces(races, indexBase));
  indexHtml = fill(indexHtml, { BASE: indexBase, SITE_URL, GA_SNIPPET: gaSnippet() });
  await writeFile(path.join(DIST, "index.html"), indexHtml, "utf-8");

  // レース詳細(1レース=1URL・事前→シグナル→答え合わせを同一URLで)
  const raceTpl = await readFile(path.join(ROOT, "templates", "race-detail.template.html"), "utf-8");
  for (const r of races) await buildRacePage(raceTpl, r, races);

  // スタブページ(深度1)
  const stubs: [string, string, string][] = [
    ["guide", "用語・見方ガイド", "展示偏差・乖離スコア・スリット予測の見方を解説するコンテンツを準備中です。"],
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
    const links = list
      .map((r) => `<li style="margin-bottom:8px;"><a href="${venueBase}${racePath(r)}">${dateLabel(r.dateISO)} 第${r.raceNo}R ${esc(r.name)} の直前分析・答え合わせ</a></li>`)
      .join("\n");
    const html = stubPage(`${venue}競艇の直前予想・結果一覧`, "", venueBase).replace(
      "<p><a",
      `<ul style="list-style:none;">${links}</ul><p><a`
    );
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

  const { xml, robots } = sitemaps(races);
  await writeFile(path.join(DIST, "sitemap.xml"), xml, "utf-8");
  await writeFile(path.join(DIST, "robots.txt"), robots, "utf-8");
  await writeFile(path.join(DIST, ".nojekyll"), "", "utf-8");

  console.log(`[build] 完了: ${DIST}`);
}

main().catch((e) => {
  console.error("[build] 失敗:", e);
  process.exit(1);
});

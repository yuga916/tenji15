/**
 * レースページのライブ処理
 * ① 締切前: 裏で live/now.json を確認し、展示タイムが反映されたら自動で最新ページに切り替える
 *    (スマホのブラウザが古いページを表示し続ける問題への対策。HTMLは最大10分キャッシュされるため)
 * ② 締切後・過去日のページ: 「この場の次のレース」「今いちばん締切が近いレース」へ案内する帯を出す
 */
(function () {
  var m = document.getElementById("live-meta");
  if (!m) return;
  var D = m.dataset;
  var RID = D.race, UPD = D.upd || "", ST = D.status, EX = D.ex === "1";
  var CLOSE = new Date(D.close).getTime();
  var BASE = D.base || "/";
  var URL = BASE + "live/now.json";
  var KEY = "kc_live_reload";

  function ga(name, params) { if (typeof window.gtag === "function") window.gtag("event", name, params || {}); }
  function hm(iso) { var d = new Date(new Date(iso).getTime() + 9 * 3600000); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function jstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
  function dateLabel(iso) { var p = iso.split("-"); return Number(p[1]) + "月" + Number(p[2]) + "日"; }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }

  var bar = document.getElementById("live-bar");
  function showBar(html, tone) {
    if (!bar) return;
    var c = tone === "ok" ? "61,220,151" : tone === "warn" ? "255,138,61" : "77,216,255";
    bar.innerHTML = '<div style="margin:10px 0; padding:10px 14px; border-radius:10px; font-size:13px; line-height:1.6; border:1px solid rgba(' + c + ',.55); background:rgba(' + c + ',.10);">' + html + "</div>";
  }

  // 自動切替の直後: 何が反映されたかを表示
  var done = ss(KEY);
  if (done) {
    ss(KEY, null);
    try {
      var info = JSON.parse(done);
      if (info.u && info.u <= UPD) {
        showBar("<strong>" + (info.why === "ex" ? "展示タイムを反映しました" : "最新の予想に更新しました") + "</strong>(" + hm(UPD) + "更新)。下の買い目・展示前→展示後の比較も最新です。", "ok");
        ga("live_auto_reload", { reason: info.why });
      }
    } catch (e) {}
  }

  function load() {
    return fetch(URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function reload(why, u) {
    // 同じ更新に対しては1回だけ自動で切り替える(ループ防止)
    var tried = ss("kc_live_tried");
    if (tried === RID + "|" + u) { manual(why); return; }
    ss("kc_live_tried", RID + "|" + u);
    ss(KEY, JSON.stringify({ why: why, u: u }));
    fetch(location.pathname, { cache: "reload" }).catch(function () {}).then(function () { location.reload(); });
  }
  function manual(why) {
    showBar((why === "ex" ? "<strong>展示タイムが反映されました。</strong>" : "<strong>新しいデータがあります。</strong>") +
      ' <a href="' + location.pathname + "?r=" + Date.now() + '" style="font-weight:700;">最新に更新する →</a>', why === "ex" ? "warn" : "");
  }

  function checkSelf(d) {
    if (ST === "verified" || !d || !d.r) return;
    var me = null;
    for (var i = 0; i < d.r.length; i++) if (d.r[i].i === RID) { me = d.r[i]; break; }
    if (!me || !(me.u > UPD)) return;
    if (me.x && !EX) return reload("ex", me.u);
    if (me.s !== ST) return reload("status", me.u);
    var diff = CLOSE - Date.now();
    if (diff > 0 && diff <= 35 * 60000) manual("data");
  }

  /* ---------- ② 締切後の「次のレース」案内 ---------- */
  function nextBar(d) {
    var el = document.getElementById("next-race-bar");
    if (!el) return;
    var now = Date.now();
    var isPast = D.date < jstToday();
    if (!isPast && now < CLOSE) { el.innerHTML = ""; return; }
    var open = [];
    if (d && d.r && d.d === jstToday()) {
      for (var i = 0; i < d.r.length; i++) {
        var x = d.r[i];
        if (x.s !== "verified" && new Date(x.c).getTime() > now) open.push(x);
      }
    }
    var sameV = null, soon = open[0] || null;
    for (var j = 0; j < open.length; j++) if (open[j].v === D.venue) { sameV = open[j]; break; }
    var mins = function (x) { return Math.max(0, Math.round((new Date(x.c).getTime() - now) / 60000)); };
    var link = function (x, kind, label) {
      return '<a href="' + BASE + x.p + '" data-next="' + kind + '" style="display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:999px; background:var(--cyan,#4dd8ff); color:#0b1220; font-weight:700; font-size:13px; white-space:nowrap;">' + label + "</a>";
    };
    var head, btns = [];
    var vn = D.venueName;
    if (isPast) head = "これは" + dateLabel(D.date) + "のレースです。";
    else head = "このレースは締切済みです(結果は確定後にこのページへ反映)。";
    if (sameV) btns.push(link(sameV, "same_venue", (isPast ? "今日の" + vn + " " : vn + "の次 ") + sameV.n + "R(締切 " + hm(sameV.c) + "・あと" + mins(sameV) + "分)→"));
    if (soon && (!sameV || soon.i !== sameV.i)) btns.push(link(soon, "soonest", "締切が近い " + soon.vn + soon.n + "R(" + hm(soon.c) + ")→"));
    if (btns.length === 0) {
      if (!isPast && open.length === 0 && d && d.d === jstToday()) head += "本日の締切はすべて終了しました。";
      btns.push('<a href="' + BASE + '" data-next="top" style="display:inline-flex; padding:8px 14px; border-radius:999px; border:1px solid rgba(77,216,255,.6); color:var(--text,#e6eef5); font-weight:700; font-size:13px;">' + (isPast ? "今日のレース一覧へ →" : "結果まとめ・明日の予想へ →") + "</a>");
    }
    el.innerHTML = '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:10px 0; padding:12px 14px; border-radius:12px; border:1px solid rgba(77,216,255,.45); background:linear-gradient(135deg, rgba(77,216,255,.10), rgba(255,138,61,.05));">' +
      '<span style="font-size:13px; flex:1 1 220px;">' + head + "</span>" + btns.join("") + "</div>";
    if (!el.getAttribute("data-shown")) { el.setAttribute("data-shown", "1"); ga("view_next_race_bar", { kind: sameV ? "same_venue" : soon ? "soonest" : "none", past: isPast ? 1 : 0 }); }
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-next]");
    if (a) ga("click_next_race", { kind: a.getAttribute("data-next") });
  });

  var last = null;
  function run() {
    load().then(function (d) {
      if (d) last = d;
      checkSelf(d);
      nextBar(last);
    });
  }
  run();

  // 締切35分前〜締切までは45秒ごとに確認(それ以外は5分ごと、タブに戻った時も確認)
  function interval() {
    var diff = CLOSE - Date.now();
    return ST !== "verified" && diff > 0 && diff <= 35 * 60000 ? 45000 : 300000;
  }
  (function loop() { setTimeout(function () { if (!document.hidden) run(); loop(); }, interval()); })();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) run(); });
  // 締切の瞬間に「次のレース」帯へ切り替える
  if (CLOSE > Date.now() && CLOSE - Date.now() < 6 * 3600000) setTimeout(function () { nextBar(last); }, CLOSE - Date.now() + 1000);
})();

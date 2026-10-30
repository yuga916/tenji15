/**
 * 会場のお気に入り(この端末のブラウザに保存。登録・ログイン不要)
 * - ☆ボタン: トップのジャンプグリッド各行 / 会場ページ / 開催日ページ / レースページ
 * - トップ: お気に入り会場の「次のレース」を一番上に表示し、ジャンプグリッドでもお気に入り会場を先頭へ
 */
(function () {
  var KEY = "kc_fav_venues";
  var VENUE_NAMES = {kiryu:"桐生",toda:"戸田",edogawa:"江戸川",heiwajima:"平和島",tamagawa:"多摩川",hamanako:"浜名湖",gamagori:"蒲郡",tokoname:"常滑",tsu:"津",mikuni:"三国",biwako:"びわこ",suminoe:"住之江",amagasaki:"尼崎",naruto:"鳴門",marugame:"丸亀",kojima:"児島",miyajima:"宮島",tokuyama:"徳山",shimonoseki:"下関",wakamatsu:"若松",ashiya:"芦屋",fukuoka:"福岡",karatsu:"唐津",omura:"大村"};
  function ga(name, params) { if (typeof window.gtag === "function") window.gtag("event", name, params || {}); }
  function load() { try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 24))); } catch (e) {} }
  function has(slug) { return load().indexOf(slug) >= 0; }
  function toggle(slug) {
    var list = load(), i = list.indexOf(slug);
    if (i >= 0) { list.splice(i, 1); ga("fav_remove", { venue: slug }); }
    else { list.push(slug); ga("fav_add", { venue: slug, count: list.length }); }
    save(list);
    return i < 0;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function hm(iso) { var d = new Date(new Date(iso).getTime() + 9 * 3600000); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function jstToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

  /* ---------- ☆ボタン ---------- */
  function paintStar(btn) {
    var on = has(btn.getAttribute("data-fav"));
    btn.textContent = on ? "★" : "☆";
    btn.style.color = on ? "#ffc94d" : "var(--dim,#6b7c89)";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", (btn.getAttribute("data-fav-name") || "") + (on ? "をお気に入りから外す" : "をお気に入りに追加"));
  }
  function paintToggle(el) {
    var on = has(el.getAttribute("data-fav")), name = el.getAttribute("data-fav-name") || "この会場";
    el.innerHTML = '<button type="button" class="fav-btn" data-fav="' + esc(el.getAttribute("data-fav")) + '" data-fav-name="' + esc(name) + '" style="display:inline-flex; align-items:center; gap:6px; margin:4px 0 8px; padding:6px 12px; border-radius:999px; font-size:12.5px; font-weight:700; cursor:pointer; font-family:inherit;' +
      (on ? 'background:rgba(255,201,77,.14); color:#ffc94d; border:1px solid rgba(255,201,77,.6);">★ ' + esc(name) + "をお気に入り登録中" : 'background:none; color:var(--text,#e6eef5); border:1px solid rgba(255,255,255,.25);">☆ ' + esc(name) + "をお気に入りに追加") +
      "</button>" + (on ? ' <a href="/" style="font-size:12px; margin-left:6px;">トップで次のレースを見る →</a>' : "");
  }
  function paintAll() {
    document.querySelectorAll(".fav-toggle[data-fav]").forEach(paintToggle);
    document.querySelectorAll(".jg-row .fav-btn[data-fav]").forEach(paintStar);
    reorderGrid();
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".fav-btn[data-fav]");
    if (!b) return;
    e.preventDefault();
    var on = toggle(b.getAttribute("data-fav"));
    paintAll();
    if (live) renderPanel(); else fetchLive();
    if (on) flash(b.getAttribute("data-fav-name"));
  });
  function flash(name) {
    var t = document.createElement("div");
    t.setAttribute("style", "position:fixed; left:50%; bottom:calc(80px + env(safe-area-inset-bottom)); transform:translateX(-50%); z-index:960; background:#0f1a24; color:var(--text,#e6eef5); border:1px solid rgba(255,201,77,.6); border-radius:999px; padding:8px 16px; font-size:12.5px; box-shadow:0 8px 24px rgba(0,0,0,.45);");
    t.textContent = "★ " + (name || "会場") + "をお気に入りに追加しました(トップの一番上に表示されます)";
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  /* ---------- トップ: ジャンプグリッドの並べ替え ---------- */
  function reorderGrid() {
    var wrap = document.getElementById("jg-rows");
    if (!wrap) return;
    var favs = load();
    var rows = Array.prototype.slice.call(wrap.querySelectorAll(".jg-row"));
    if (!wrap.getAttribute("data-orig")) rows.forEach(function (r, i) { r.setAttribute("data-i", i); }), wrap.setAttribute("data-orig", "1");
    rows.sort(function (a, b) {
      var fa = favs.indexOf(a.getAttribute("data-venue")) >= 0 ? 0 : 1, fb = favs.indexOf(b.getAttribute("data-venue")) >= 0 ? 0 : 1;
      return fa - fb || Number(a.getAttribute("data-i")) - Number(b.getAttribute("data-i"));
    });
    rows.forEach(function (r) {
      var on = favs.indexOf(r.getAttribute("data-venue")) >= 0;
      r.style.background = on ? "rgba(255,201,77,.06)" : "";
      r.style.borderLeft = on ? "2px solid rgba(255,201,77,.7)" : "";
      r.style.paddingLeft = on ? "6px" : "";
      wrap.appendChild(r);
    });
  }

  /* ---------- トップ: お気に入り会場の次のレース ---------- */
  var panel = document.getElementById("fav-panel");
  var live = null;
  function renderPanel() {
    if (!panel) return;
    var favs = load();
    if (favs.length === 0) { panel.innerHTML = ""; return; }
    var base = panel.getAttribute("data-base") || "/";
    var now = Date.now();
    var today = live && live.d === jstToday() ? live.r : [];
    var names = {};
    document.querySelectorAll(".fav-btn[data-fav]").forEach(function (b) { names[b.getAttribute("data-fav")] = b.getAttribute("data-fav-name"); });
    if (!live) {
      panel.innerHTML = '<div class="card" style="margin-bottom:14px; padding:12px 16px; border:1px solid rgba(255,201,77,.45); color:var(--muted,#9fb3c1); font-size:12.5px;">★ お気に入り会場の次のレースを読み込み中…</div>';
      return;
    }
    var items = favs.map(function (slug) {
      var list = today.filter(function (x) { return x.v === slug; });
      var name = (list[0] && list[0].vn) || names[slug] || VENUE_NAMES[slug] || slug;
      if (list.length === 0) return { order: 3, html: '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 0; border-top:1px solid rgba(255,255,255,.06);"><strong>' + esc(name) + '</strong><span style="color:var(--dim); font-size:12.5px;">本日は開催なし</span><a href="' + base + "races/" + slug + '/" style="font-size:12.5px; margin-left:auto;">会場ページ →</a></div>' };
      var next = list.filter(function (x) { return x.s !== "verified" && new Date(x.c).getTime() > now; }).sort(function (a, b) { return a.c < b.c ? -1 : 1; })[0];
      if (!next) return { order: 2, html: '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 0; border-top:1px solid rgba(255,255,255,.06);"><strong>' + esc(name) + '</strong><span style="color:var(--dim); font-size:12.5px;">本日の全レース終了</span><a href="' + base + "races/" + slug + "/" + live.d + '/" style="font-size:12.5px; margin-left:auto;">結果を見る →</a></div>' };
      var mins = Math.max(0, Math.round((new Date(next.c).getTime() - now) / 60000));
      var state = next.x ? '<span style="color:#3ddc97; font-size:11.5px;">展示反映済み</span>' : '<span style="color:var(--dim); font-size:11.5px;">展示前</span>';
      return { order: 1, key: next.c, html: '<a href="' + base + next.p + '" data-fav-race="' + esc(slug) + '" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:9px 0; border-top:1px solid rgba(255,255,255,.06); color:var(--text,#e6eef5);">' +
        '<strong style="min-width:56px;">' + esc(name) + "</strong>" +
        '<span style="font-weight:900;">' + next.n + "R</span>" +
        '<span style="font-size:12.5px;">締切 ' + hm(next.c) + ' <span style="color:' + (mins <= 15 ? "var(--signal,#ff8a3d)" : "var(--muted,#9fb3c1)") + ';">(あと' + mins + "分)</span></span>" +
        (next.k ? '<span style="font-size:12.5px;">AI本命 <span class="boat boat-' + next.k + '" style="width:20px; height:20px; font-size:11px;">' + next.k + "</span> " + esc(next.kn || "") + (next.kp ? " " + next.kp + "%" : "") + "</span>" : "") +
        state + '<span style="margin-left:auto; color:var(--cyan,#4dd8ff); font-size:12.5px;">予想を見る →</span></a>' };
    }).sort(function (a, b) { return a.order - b.order || String(a.key || "").localeCompare(String(b.key || "")); });
    panel.innerHTML = '<div class="card" style="margin-bottom:14px; padding:12px 16px; border:1px solid rgba(255,201,77,.45);">' +
      '<div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; flex-wrap:wrap;"><h2 style="font-size:15px; margin:0;">★ お気に入り会場の次のレース</h2><span style="color:var(--dim); font-size:11.5px;">' + (live ? hm(live.b) + "時点" : "読み込み中") + "・☆で追加/解除</span></div>" +
      items.map(function (x) { return x.html; }).join("") + "</div>";
    if (!panel.getAttribute("data-viewed")) { panel.setAttribute("data-viewed", "1"); ga("view_fav_panel", { count: favs.length }); }
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-fav-race]");
    if (a) ga("click_fav_race", { venue: a.getAttribute("data-fav-race") });
  });

  function fetchLive() {
    if (!panel || load().length === 0) return;
    var base = panel.getAttribute("data-base") || "/";
    fetch(base + "live/now.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { live = d || live || { d: "", r: [], b: new Date().toISOString() }; renderPanel(); })
      .catch(function () { if (!live) live = { d: "", r: [], b: new Date().toISOString() }; renderPanel(); });
  }

  paintAll();
  renderPanel();
  fetchLive();
  if (panel) {
    setInterval(function () { if (!document.hidden) fetchLive(); }, 60000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) fetchLive(); });
  }
})();

/**
 * 「あなたが見たレースのその後」(リテンション機能)
 * - レースページ: 閲覧をlocalStorageに記録(最新20件・端末内のみ・外部送信なし)
 * - トップページ: 過去に見たレースの確定結果を軽量JSONから引いて表示
 */
(function () {
  var KEY = "kc_viewed_v1";
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-20))); } catch (e) {}
  }

  var m = location.pathname.match(/races\/([a-z]+)\/(\d{4}-\d{2}-\d{2})\/(\d{1,2})\/?$/);
  if (m) {
    // 記録モード(レース詳細ページ)
    var h1 = document.querySelector("h1");
    var venue = ((h1 && h1.textContent.match(/^([^\s\d]+?)競艇/)) || [])[1] || m[1];
    var pickEl = document.querySelector("tr.top-pick .boat");
    var pick = pickEl ? Number(pickEl.textContent) : null;
    var no = Number(m[3]);
    var list = read().filter(function (x) { return !(x.s === m[1] && x.d === m[2] && x.n === no); });
    list.push({ s: m[1], d: m[2], n: no, v: venue, p: pick, t: Date.now() });
    write(list);
    return;
  }

  // 表示モード(トップページの#recap-slotがある場合のみ)
  var slot = document.getElementById("recap-slot");
  if (!slot) return;
  var base = slot.getAttribute("data-base") || "./";
  var today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  var seen = read().filter(function (x) { return x.d < today; });
  if (seen.length === 0) return;
  seen = seen.slice(-8).reverse();
  var dates = [];
  seen.forEach(function (x) { if (dates.indexOf(x.d) < 0) dates.push(x.d); });
  dates = dates.slice(0, 4);

  Promise.all(dates.map(function (d) {
    return fetch(base + "data/results-" + d + ".json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  })).then(function (objs) {
    var res = {};
    objs.forEach(function (o) { if (o) { for (var k in o) res[k] = o[k]; } });
    var items = [];
    seen.forEach(function (x) {
      if (items.length >= 4) return;
      var r = res[x.s + "_" + x.d + "_" + x.n];
      if (!r || !r.f || r.f.length < 3) return;
      var hit = x.p && r.f[0] === x.p;
      var md = x.d.slice(5).replace("-", "/");
      items.push(
        '<a href="' + base + "races/" + x.s + "/" + x.d + "/" + x.n + '/" style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:9px 12px; border:1px solid rgba(255,255,255,.12); border-radius:10px; color:var(--text); font-size:13px;">' +
        '<span>' + x.v + " " + x.n + 'R <span style="color:var(--dim); font-size:11.5px;">' + md + "</span></span>" +
        '<span style="display:flex; align-items:center; gap:10px;"><span style="font-weight:700;">' + r.f.join("-") + "</span>" +
        '<span style="color:var(--muted);">3連単 ¥' + Number(r.p3 || 0).toLocaleString() + "</span>" +
        (hit ? '<span style="color:#4dd8ff; font-size:11.5px; border:1px solid rgba(77,216,255,.5); border-radius:20px; padding:1px 8px;">AI本命1着</span>' : "") +
        "</span></a>"
      );
    });
    if (items.length === 0) return;
    slot.innerHTML =
      '<div class="card" style="margin-bottom:18px;">' +
      '<h2 style="font-size:15px; margin-bottom:4px;">前回見たレースのその後</h2>' +
      '<p style="color:var(--dim); font-size:11.5px; margin-bottom:10px;">この端末で閲覧したレースの確定結果です(履歴は端末内にのみ保存されます)。</p>' +
      '<div style="display:flex; flex-direction:column; gap:8px;">' + items.join("") + "</div></div>";
    if (typeof window.gtag === "function") window.gtag("event", "view_recap", { count: items.length });
  });
})();

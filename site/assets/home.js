/**
 * 「ホーム画面に追加/ブックマーク」の控えめな案内
 * - 2日以上来てくれた人だけに、1日1回まで表示(閉じたら30日出さない・追加済みなら出さない)
 * - 検索で見つけにくくなっても、ホーム画面やブックマークから直接戻って来られるようにするのが目的
 * - ホーム画面から開かれた回数も計測(launch_standalone)
 */
(function () {
  function ga(name, params) { if (typeof window.gtag === "function") window.gtag("event", name, params || {}); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var DAY = 86400000;
  var today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  if (standalone) {
    try { if (!sessionStorage.getItem("kc_sa")) { sessionStorage.setItem("kc_sa", "1"); ga("launch_standalone"); } } catch (e) {}
    ls("kc_home_added", String(Date.now()));
    return;
  }

  // 来訪日の記録(直近10日分)
  var days = [];
  try { days = JSON.parse(ls("kc_days") || "[]"); } catch (e) { days = []; }
  if (days[days.length - 1] !== today) { days.push(today); days = days.slice(-10); ls("kc_days", JSON.stringify(days)); }

  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener("appinstalled", function () { ls("kc_home_added", String(Date.now())); ga("app_installed"); hide(); });

  if (days.length < 2) return;
  if (ls("kc_home_added")) return;
  if (Date.now() - Number(ls("kc_home_off") || 0) < 30 * DAY) return;
  if (ls("kc_home_last") === today) return;
  if (/^\/feedback\//.test(location.pathname)) return;

  var ua = navigator.userAgent;
  var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var android = /Android/.test(ua);
  var mobile = ios || android || window.innerWidth < 768;

  var box = null;
  function hide() { if (box) { box.remove(); box = null; } }

  function show() {
    var kind = deferred ? "install" : ios ? "ios" : android ? "android" : "desktop";
    var text =
      kind === "install" ? "ホーム画面に追加すると、次回はアプリのようにワンタップで開けます。" :
      kind === "ios" ? "ホーム画面に追加すると、次回はワンタップで開けます。共有ボタン(□↑)→「ホーム画面に追加」" :
      kind === "android" ? "ホーム画面に追加すると、次回はワンタップで開けます。メニュー(⋮)→「ホーム画面に追加」" :
      "ブックマーク(" + (/Mac/.test(navigator.platform) ? "⌘" : "Ctrl") + "+D)しておくと、次回すぐ開けます。";
    box = document.createElement("div");
    box.className = "home-prompt";
    box.setAttribute("role", "dialog");
    box.setAttribute("style",
      "position:fixed; left:12px; right:12px; bottom:calc(68px + env(safe-area-inset-bottom)); z-index:950; margin:0 auto; max-width:420px;" +
      "display:flex; align-items:center; gap:10px; padding:11px 12px 11px 14px; border-radius:12px;" +
      "background:#0f1a24; color:var(--text,#e6eef5); border:1px solid rgba(77,216,255,.45); box-shadow:0 10px 30px rgba(0,0,0,.5); font-size:12.5px; line-height:1.6;");
    box.innerHTML =
      '<img src="/assets/icon-192.png" alt="" width="34" height="34" style="border-radius:8px; flex:none;">' +
      '<span style="flex:1;"><strong style="display:block; font-size:13px;">いつも見てくれてありがとうございます</strong>' + text + "</span>" +
      (kind === "install" ? '<button type="button" class="home-add" style="flex:none; background:#4dd8ff; color:#0b1220; border:0; border-radius:999px; padding:7px 12px; font-weight:700; font-size:12.5px; cursor:pointer;">追加</button>' : "") +
      '<button type="button" class="home-close" aria-label="閉じる" style="flex:none; background:none; border:0; color:var(--muted,#9fb3c1); font-size:18px; cursor:pointer; padding:2px 4px; line-height:1;">×</button>';
    document.body.appendChild(box);
    ls("kc_home_last", today);
    ga("view_home_prompt", { kind: kind, visit_days: days.length });
    box.querySelector(".home-close").addEventListener("click", function () { ls("kc_home_off", String(Date.now())); ga("close_home_prompt", { kind: kind }); hide(); });
    var add = box.querySelector(".home-add");
    if (add) add.addEventListener("click", function () {
      ga("click_home_prompt", { kind: kind });
      deferred.prompt();
      deferred.userChoice.then(function (c) { ga("home_prompt_choice", { outcome: c && c.outcome }); deferred = null; hide(); });
    });
  }

  // 読み始めを邪魔しないよう少し待ってから表示(Androidのインストール可否の判定待ちも兼ねる)
  setTimeout(function () { if (!document.hidden) show(); }, mobile ? 8000 : 12000);
})();

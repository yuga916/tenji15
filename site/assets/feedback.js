/**
 * ご意見箱(サイト内フォーム)
 * - 表側はサイトのデザインで表示し、送信は裏でGoogleフォームへPOST(回答はフォームの「回答」タブに蓄積)
 * - 匿名。送信内容はテキスト+閲覧中のページパスのみ(個人情報は送らない)
 * - [data-feedback-open] を持つリンクをクリックするとモーダルで開く。#feedback-slot があればそこにインライン表示
 * - JSが無効な環境では通常リンクとして /feedback/ ページへ遷移
 */
(function () {
  var FORM = "https://docs.google.com/forms/d/e/1FAIpQLSfMY46L7RjktI-R9kf9Y950HT8-jA6-C0OydswF3xTqRYDs5w";
  var ENTRY = "entry.1372798732";
  var MAX = 2000;

  function ga(name, params) { if (typeof window.gtag === "function") window.gtag("event", name, params || {}); }

  function formHtml(inline) {
    return '' +
      '<div class="fb-box" style="' + (inline ? '' : 'max-width:520px; width:calc(100% - 32px); ') + 'background:#0f1a24; border:1px solid rgba(77,216,255,.35); border-radius:14px; padding:18px 18px 14px; color:var(--text,#e6eef5); box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
      '<div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">' +
      '<h2 style="font-size:16px; margin:0;">欲しい機能・改善案を教えてください</h2>' +
      (inline ? '' : '<button type="button" class="fb-close" aria-label="閉じる" style="background:none; border:0; color:var(--muted,#9fb3c1); font-size:20px; cursor:pointer; line-height:1;">×</button>') +
      '</div>' +
      '<p style="color:var(--muted,#9fb3c1); font-size:12.5px; margin:6px 0 10px;">匿名・所要30秒。「この機能が欲しい」「ここが使いにくい」「表示がおかしい」など何でもどうぞ。返信はできませんが、全件読んで次の改善に反映します。</p>' +
      '<form class="fb-form">' +
      '<textarea name="text" required maxlength="' + MAX + '" rows="5" placeholder="例: 会場ごとにお気に入り登録したい / 展示タイムの見方が分かりにくい" style="width:100%; box-sizing:border-box; background:#0b1220; color:var(--text,#e6eef5); border:1px solid rgba(255,255,255,.18); border-radius:10px; padding:10px 12px; font-size:14px; line-height:1.6; resize:vertical; font-family:inherit;"></textarea>' +
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:10px; flex-wrap:wrap;">' +
      '<span class="fb-count" style="color:var(--dim,#6b7c89); font-size:11.5px;">0 / ' + MAX + '</span>' +
      '<button type="submit" style="background:var(--cyan,#4dd8ff); color:#0b1220; border:0; border-radius:10px; padding:9px 18px; font-weight:700; font-size:14px; cursor:pointer;">送信する</button>' +
      '</div>' +
      '<p class="fb-msg" style="font-size:12.5px; margin:10px 0 0; min-height:1.2em;"></p>' +
      '</form>' +
      '<p style="color:var(--dim,#6b7c89); font-size:11px; margin:8px 0 0;">送信内容と閲覧中のページ名のみを記録します。うまく送れない場合は<a href="' + FORM + '/viewform" target="_blank" rel="nofollow noopener" style="color:var(--muted,#9fb3c1);">フォーム版</a>からどうぞ。</p>' +
      '</div>';
  }

  function wire(root, place) {
    var form = root.querySelector(".fb-form");
    var ta = root.querySelector("textarea");
    var count = root.querySelector(".fb-count");
    var msg = root.querySelector(".fb-msg");
    ta.addEventListener("input", function () { count.textContent = ta.value.length + " / " + MAX; });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      if (!text) return;
      var btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "送信中…";
      var body = new URLSearchParams();
      body.set(ENTRY, text + "\n---\nページ: " + location.pathname + " / 表示: " + (window.innerWidth < 768 ? "mobile" : "desktop"));
      body.set("fvv", "1");
      body.set("pageHistory", "0");
      fetch(FORM + "/formResponse", { method: "POST", mode: "no-cors", body: body })
        .then(function () {
          form.innerHTML = '<p style="color:var(--cyan,#4dd8ff); font-weight:700; margin:8px 0 4px;">送信しました。ありがとうございます!</p><p style="color:var(--muted,#9fb3c1); font-size:12.5px; margin:0;">いただいた内容は次の改善に反映します。引き続きご利用ください。</p>';
          ga("submit_feedback", { place: place, length: text.length });
        })
        .catch(function () {
          btn.disabled = false; btn.textContent = "送信する";
          msg.style.color = "var(--signal,#ff8a3d)";
          msg.textContent = "送信できませんでした。通信環境をご確認いただくか、下の「フォーム版」からお願いします。";
        });
    });
    var close = root.querySelector(".fb-close");
    if (close) close.addEventListener("click", function () { root.remove(); });
    setTimeout(function () { ta.focus(); }, 50);
  }

  function openModal(place) {
    if (document.querySelector(".fb-overlay")) return;
    var ov = document.createElement("div");
    ov.className = "fb-overlay";
    ov.setAttribute("style", "position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:1000; padding:16px;");
    ov.innerHTML = formHtml(false);
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    wire(ov, place);
    ga("open_feedback", { place: place });
  }

  // インライン表示(/feedback/ ページ)
  var slot = document.getElementById("feedback-slot");
  if (slot) {
    slot.innerHTML = formHtml(true);
    wire(slot, "page");
  }

  // [data-feedback-open] リンクはモーダルで開く(JS無効時は通常遷移)
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-feedback-open]");
    if (!a) return;
    e.preventDefault();
    openModal(a.getAttribute("data-feedback-open") || "link");
  });
})();

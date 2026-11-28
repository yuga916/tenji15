/* トップ「レースへジャンプ」の締切表示を見やすく(意見箱の要望・2026-11-28)
 * - 各会場の「次 nR HH:MM」に残り時間を付け、10分前は黄・5分前は赤で強調
 * - 横幅の広い画面(1600px以上・本文の右の余白)では右側に大きな時計(現在時刻と、全場で一番近い締切)を表示 */
(function () {
  var els = document.querySelectorAll(".jg-next[data-close]");
  if (!els.length) return;
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var clock = null;
  if (window.matchMedia && window.matchMedia("(min-width: 1600px)").matches) {
    clock = document.createElement("div");
    clock.id = "big-clock";
    clock.setAttribute("aria-live", "off");
    clock.style.cssText = "position:fixed; right:24px; top:96px; width:190px; padding:14px 16px; border:1px solid rgba(255,255,255,.12); border-radius:14px; background:rgba(5,11,18,.85); backdrop-filter:blur(8px); z-index:40; text-align:center;";
    document.body.appendChild(clock);
  }
  function tick() {
    var now = Date.now();
    var best = null;
    els.forEach(function (el) {
      var close = new Date(el.getAttribute("data-close")).getTime();
      var diff = close - now;
      var base = "次 " + el.getAttribute("data-race") + "R " + el.getAttribute("data-close").slice(11, 16);
      if (diff <= 0) { el.textContent = base + "(締切)"; el.style.color = "var(--dim)"; return; }
      var m = Math.floor(diff / 60000);
      el.textContent = base + (m < 60 ? "(あと" + m + "分)" : "");
      el.style.color = diff <= 5 * 60000 ? "#ff5a5a" : diff <= 10 * 60000 ? "#ffd84d" : "var(--text)";
      if (!best || diff < best.diff) best = { diff: diff, el: el };
    });
    if (clock) {
      var j = new Date(now + 9 * 3600000);
      var t = pad(j.getUTCHours()) + ":" + pad(j.getUTCMinutes()) + ":" + pad(j.getUTCSeconds());
      var nx = "";
      if (best) {
        var s = Math.floor(best.diff / 1000);
        var col = best.diff <= 5 * 60000 ? "#ff5a5a" : best.diff <= 10 * 60000 ? "#ffd84d" : "var(--cyan)";
        nx = '<div style="margin-top:10px; font-size:12px; color:var(--muted);">次の締切</div><div style="font-size:14px; font-weight:700;">' + best.el.getAttribute("data-venue") + " " + best.el.getAttribute("data-race") + 'R</div><div style="font-family:var(--font-display); font-size:22px; font-weight:700; color:' + col + ';">あと ' + Math.floor(s / 60) + ":" + pad(s % 60) + "</div>";
      }
      clock.innerHTML = '<div style="font-size:11px; color:var(--dim);">現在時刻</div><div style="font-family:var(--font-display); font-size:34px; font-weight:700; letter-spacing:.04em;">' + t + "</div>" + nx;
    }
  }
  tick();
  setInterval(tick, 1000);
})();

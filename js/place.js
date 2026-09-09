/* Atlas of the Curious — behaviour for the generated per-place share pages.
   Kept as a small external (same-origin) script so the strict CSP on these
   pages (script-src 'self', style-src 'self') is satisfied — no inline
   scripts or inline style attributes are used in the generated HTML. */
(function () {
  "use strict";

  // Per-category accent color, carried in a data attribute and applied via
  // CSSOM (which the CSP does not restrict).
  document.querySelectorAll("[data-accent]").forEach(function (el) {
    var a = el.getAttribute("data-accent");
    if (a) el.style.setProperty("--accent", a);
  });

  // "Copy link" button.
  var btn = document.getElementById("share");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var url = location.href;
    var original = "Copy link";
    var done = function () {
      btn.textContent = "Link copied \u2713";
      setTimeout(function () { btn.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { prompt("Copy this link:", url); });
    } else {
      prompt("Copy this link:", url);
    }
  });
})();

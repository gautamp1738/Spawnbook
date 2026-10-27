/* Spawnbook: shared behaviour for the landing, valuation and subscribe pages.
   (The board page carries its own copy of these inside its larger script.) */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var MAIL = "gautamuprasanna@gmail.com";

  // Reveal on scroll (once). Content rests visible; entering the screen only adds arrival.
  var io = ("IntersectionObserver" in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
  }, { rootMargin: "0px 0px 12% 0px", threshold: 0 }) : null;
  document.querySelectorAll("[data-reveal]").forEach(function (n) { if (io) io.observe(n); else n.classList.add("is-in"); });

  // Copy to clipboard, with a fallback that selects the text.
  function copyText(text, statusEl, area, okMsg) {
    function fallback() {
      if (area) { area.focus(); area.select(); statusEl.textContent = "Selected. Press Ctrl+C or Cmd+C to copy."; }
      else statusEl.textContent = "Copy didn't work here. Select the address and copy it.";
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { statusEl.textContent = okMsg || (area ? "Copied. Now paste it into your message to us." : "Copied."); }, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }
  window.SB = { copyText: copyText, MAIL: MAIL, $: $ };
  if ($("foot-copy")) $("foot-copy").addEventListener("click", function () { copyText(MAIL, $("foot-status")); });
  if ($("mail-copy")) $("mail-copy").addEventListener("click", function () { copyText(MAIL, $("mail-status")); });

  // Show or hide a password field.
  document.querySelectorAll("[data-show-pw]").forEach(function (btn) {
    var input = $(btn.getAttribute("data-show-pw"));
    if (!input) return;
    btn.setAttribute("aria-label", "Show password");
    btn.addEventListener("click", function () {
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-pressed", showing ? "false" : "true");
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
  });

  // Top bar: hides while you read down, comes back on any scroll up.
  var bar = document.querySelector(".bar");
  if (bar) {
    var barY = window.scrollY, barHold = 0, queued = false;
    var setBar = function (hidden) { bar.classList.toggle("is-hidden", hidden); };
    var onScroll = function () {
      queued = false;
      var y = Math.max(0, window.scrollY), dy = y - barY;
      bar.classList.toggle("is-away", y > 4);
      if (y <= bar.offsetHeight) { setBar(false); barY = y; return; }
      if (performance.now() < barHold) { setBar(true); barY = y; return; }
      if (dy > 8) { setBar(true); barY = y; }
      else if (dy < -4) { setBar(false); barY = y; }
    };
    window.addEventListener("scroll", function () { if (!queued) { queued = true; requestAnimationFrame(onScroll); } }, { passive: true });
    bar.addEventListener("focusin", function () { barHold = 0; setBar(false); });
    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
      var href = a && a.getAttribute("href");
      if (href && href.length > 1 && href !== "#top") barHold = performance.now() + 600;
    });
    onScroll();
  }

  // Fit the name to the measure on wide screens.
  var nameEl = document.querySelector(".hero-name");
  if (nameEl) {
    var fitName = function () {
      nameEl.style.fontSize = "";
      if (window.innerWidth < 768) return;
      var avail = nameEl.clientWidth, used = 0;
      Array.prototype.forEach.call(nameEl.children, function (c) { used += c.getBoundingClientRect().width; });
      var gap = parseFloat(getComputedStyle(nameEl).columnGap) || 0;
      used += gap * (nameEl.children.length - 1);
      if (!used) return;
      var size = parseFloat(getComputedStyle(nameEl).fontSize);
      nameEl.style.fontSize = Math.min(size * (avail * 0.97) / used, window.innerHeight * 0.42) + "px";
    };
    fitName();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitName);
    window.addEventListener("resize", fitName);
  }
})();

/* Spawnbook: the top menu on every page.
   - On narrow screens the links fold behind a Menu button.
   - On long pages with an "On this page" bar, the bar marks the section you're reading and sits
     just under the top menu while that's showing. */
(function () {
  var bar = document.querySelector(".bar");
  if (!bar) return;
  var btn = bar.querySelector(".menu-btn"), list = bar.querySelector(".navlinks");

  // ---------- the Menu button ----------
  if (btn && list) {
    var setOpen = function (open) {
      bar.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.textContent = open ? "Close" : "Menu";
    };
    btn.addEventListener("click", function () { setOpen(!bar.classList.contains("is-open")); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && bar.classList.contains("is-open")) { setOpen(false); btn.focus(); }
    });
    // Tapping a link that stays on this page (#find) closes the menu.
    list.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a) setOpen(false);
    });
    window.addEventListener("resize", function () { if (window.innerWidth >= 960 && bar.classList.contains("is-open")) setOpen(false); });
  }

  // ---------- the top menu's height, so the "On this page" bar can sit under it ----------
  var root = document.documentElement;
  var setH = function () { root.style.setProperty("--bar-h", bar.offsetHeight + "px"); };
  setH();
  window.addEventListener("resize", setH);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(setH);

  // ---------- "On this page": mark the section in view ----------
  var sub = document.querySelector(".subnav");
  if (!sub || !("IntersectionObserver" in window)) return;
  var links = Array.prototype.slice.call(sub.querySelectorAll('a[href^="#"]'));
  var byId = {};
  var targets = links.map(function (a) { var t = document.getElementById(a.getAttribute("href").slice(1)); if (t) byId[t.id] = a; return t; }).filter(Boolean);
  var current = null;
  var mark = function (id) {
    if (id === current) return;
    current = id;
    links.forEach(function (a) { if (a === byId[id]) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
    var a = byId[id];
    // Keep the marked link in view when the bar scrolls sideways on a phone.
    if (a && sub.scrollWidth > sub.clientWidth) {
      var box = sub.querySelector(".subnav-links") || sub;
      var left = a.offsetLeft - 16;
      if (left < box.scrollLeft || a.offsetLeft + a.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollTo({ left: left, behavior: "smooth" });
    }
  };
  var seen = {};
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { seen[e.target.id] = e.isIntersecting; });
    // The first section, in page order, that's in the reading band.
    for (var i = 0; i < targets.length; i++) { if (seen[targets[i].id]) { mark(targets[i].id); return; } }
  }, { rootMargin: "-30% 0px -60% 0px", threshold: 0 });
  targets.forEach(function (t) { io.observe(t); });
})();

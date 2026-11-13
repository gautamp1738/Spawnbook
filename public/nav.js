/* Spawnbook: the top menu on every page.
   - The Menu button (three lines) opens every part of the site, grouped by what you're doing, with
     a line on what each one is for. On narrow screens it's the only menu.
   - On long pages with an "On this page" bar, the bar marks the section you're reading and sits
     just under the top menu while that's showing. */
(function () {
  var bar = document.querySelector(".bar");
  if (!bar) return;
  var btn = bar.querySelector(".menu-btn");

  // ---------- everything on the site, grouped ----------
  var MAIL = "gautamuprasanna@gmail.com";
  var GROUPS = [
    ["Find games", [
      ["board", "Today's board", "Every young Roblox game growing fast, scored out of 100 and priced."],
      ["board#find", "Game finder", "Answer three questions. Get matches and a first message to each owner."],
      ["lookup", "Look up a game", "Paste any Roblox game for its numbers and an estimated price."],
      ["g", "Public game pages", "A free page for every game in our daily record."]
    ]],
    ["Follow the market", [
      ["watchlist", "Watchlist", "Games you're following, with what changed since you last looked."],
      ["market", "Market", "Which genres are growing and what launched recently."],
      ["report", "Weekly report", "Every Monday: the week's top games and how last week's picks did."],
      ["trends", "What's working", "What this year's Roblox hits have in common."],
      ["track", "Track record", "How every Monday's picks did, good or bad."]
    ]],
    ["Make a deal", [
      ["leads", "Verified leads", "Owners who said they'd sell, with numbers we've checked."],
      ["leads#box-h", "What you buy", "Your buy box. It picks your leads and the games we email you."],
      ["value#sale", "How a sale works", "Contracts, escrow and Roblox's ownership transfer, in order."]
    ]],
    ["For game owners", [
      ["value", "Value your game", "A price range from what your game earned last month."],
      ["connect", "Prove your numbers", "A free link with your real players and Robux, read from Roblox."],
      ["sell", "Sell your game", "Tell us about it and show it's yours. Free, and no cut of the sale."]
    ]],
    ["Your account", [
      ["account", "Account", "Password, the daily top 5 by email or Discord, and referrals."],
      ["subscribe", "Pricing", "What a subscription costs and how to pay."],
      ["signin", "Sign in", "On a new device, or after signing out."]
    ]]
  ];
  var here = location.pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  var isHere = function (href) { return href.indexOf("#") < 0 && ("/" + href) === here; };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  var panel = null;
  if (btn) {
    panel = el("nav", "allnav");
    panel.id = "allnav";
    panel.setAttribute("aria-label", "All of Spawnbook");
    panel.hidden = true;
    var grid = el("div", "allnav-in");
    GROUPS.forEach(function (g, gi) {
      var box = el("div", "an-group");
      var h = el("p", "an-h", g[0]); h.id = "an-h" + gi;
      var ul = el("ul"); ul.setAttribute("aria-labelledby", h.id);
      g[1].forEach(function (it) {
        var li = el("li"), a = el("a");
        a.href = it[0];
        if (isHere(it[0])) a.setAttribute("aria-current", "page");
        a.appendChild(el("span", "an-l", it[1]));
        a.appendChild(el("span", "an-d", it[2]));
        li.appendChild(a); ul.appendChild(li);
      });
      box.appendChild(h); box.appendChild(ul); grid.appendChild(box);
    });
    panel.appendChild(grid);
    var foot = el("div", "an-foot");
    var mail = el("a", null, "Email us: " + MAIL); mail.href = "mailto:" + MAIL; foot.appendChild(mail);
    [["privacy.html", "Privacy"], ["terms.html", "Terms"], ["cookies.html", "Cookies"], ["refunds.html", "Refunds"]].forEach(function (x) { var a = el("a", null, x[1]); a.href = x[0]; foot.appendChild(a); });
    panel.appendChild(foot);
    bar.appendChild(panel);

    // The button: three lines, and an X while it's open. Drawn, so it matches the type.
    // Both icons stay in the button and CSS shows one, so a click's target is never swapped out.
    btn.innerHTML = '<svg class="mb-ico mb-open" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>' +
      '<svg class="mb-ico mb-close" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>' +
      '<span class="mb-t">Menu</span>';
    var label = btn.querySelector(".mb-t");
    btn.setAttribute("aria-controls", "allnav");
    var setOpen = function (open) {
      bar.classList.toggle("is-open", open);
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      label.textContent = open ? "Close" : "Menu";
    };
    setOpen(false);
    btn.addEventListener("click", function () { setOpen(panel.hidden); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) { setOpen(false); btn.focus(); }
    });
    // A click outside the menu, or on a link in it, closes it.
    document.addEventListener("click", function (e) {
      if (panel.hidden) return;
      if (e.target.closest && e.target.closest("#allnav a")) { setOpen(false); return; }
      if (!bar.contains(e.target)) setOpen(false);
    });
  }

  // ---------- the top menu's height, so the "On this page" bar can sit under it ----------
  var root = document.documentElement;
  var setH = function () { if (!bar.classList.contains("is-open")) root.style.setProperty("--bar-h", bar.offsetHeight + "px"); };
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

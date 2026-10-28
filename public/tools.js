/* Spawnbook research tools: shared helpers for the game, watchlist and market pages.
   Reads window.HX (history.js), and talks to /api/watch and /api/live. */
(function () {
  var T = {};
  T.$ = function (id) { return document.getElementById(id); };
  T.el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  T.commas = function (n) { return n == null || !isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US"); };
  function trim(v) { var s = v >= 100 ? v.toFixed(0) : v.toFixed(1); return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
  T.short = function (n) {
    if (n == null || !isFinite(n)) return "–";
    var a = Math.abs(n), sign = n < 0 ? "−" : "";
    if (a >= 999.5e6) return sign + trim(a / 1e9) + "B";
    if (a >= 999.5e3) return sign + trim(a / 1e6) + "M";
    if (a >= 1e4) return sign + Math.round(a / 1e3) + "K";
    if (a >= 1e3) return sign + trim(a / 1e3) + "K";
    return sign + String(Math.round(a));
  };
  T.money = function (x) { return !isFinite(x) || x <= 0 ? "$0" : "$" + T.short(x); };
  T.signed = function (v) { return v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)) + "%"; };
  T.pctChange = function (now, then) { return now != null && then > 0 ? (now / then - 1) * 100 : null; };
  T.clean = function (name) {
    var s = String(name || "");
    try { s = s.replace(/\p{Extended_Pictographic}|️|‍|⃣/gu, ""); } catch (e) {}
    s = s.replace(/\[\s*\]|\(\s*\)/g, "").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]").replace(/\s{2,}/g, " ").trim();
    return s || String(name || "");
  };
  T.dayLabel = function (d) {
    var q = String(d || "").split("-");
    if (q.length !== 3) return String(d || "");
    return new Date(Date.UTC(+q[0], +q[1] - 1, +q[2], 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  T.robloxUrl = function (pid) { return "https://www.roblox.com/games/" + pid; };
  T.creatorUrl = function (ct, ci) { return ct === "Group" ? "https://www.roblox.com/communities/" + ci : "https://www.roblox.com/users/" + ci + "/profile"; };
  T.gamePage = function (pid) { return "game?pid=" + pid; };
  T.extLink = function (text, href, cls) {
    var a = T.el("a", cls || "link", text); a.href = href; a.target = "_blank"; a.rel = "noopener";
    a.appendChild(T.el("span", "sr-only", " (opens in a new tab)"));
    return a;
  };
  T.STATUS = { watching: "Watching", contacted: "Contacted", talking: "In talks", passed: "Passed", bought: "Bought" };
  T.STATUS_ORDER = ["watching", "contacted", "talking", "passed", "bought"];

  // ---------- history ----------
  // HX.games[uid] = [name, pid, genre, genre2, creator, creatorType, creatorId, created, readings]
  // readings: [dayIndex, players, visits, upVotes, downVotes]
  var HX = window.HX || null;
  T.HX = HX;
  T.game = function (uid) {
    var g = HX && HX.games[uid];
    if (!g) return null;
    return { uid: Number(uid), name: g[0], pid: g[1], genre: g[2], genre2: g[3], creator: g[4], ctype: g[5], cid: g[6], created: g[7], r: g[8] };
  };
  T.uidByPid = {};
  if (HX) Object.keys(HX.games).forEach(function (u) { T.uidByPid[HX.games[u][1]] = Number(u); });
  T.ageOn = function (g, d) {
    if (!g.created) return null;
    return Math.round((Date.parse(d + "T12:00:00Z") - Date.parse(g.created + "T00:00:00Z")) / 864e5);
  };
  // Players at each daily reading, by date index (null where we have no reading).
  T.playersByDay = function (g) {
    var out = HX.dates.map(function () { return null; });
    g.r.forEach(function (x) { out[x[0]] = x[1]; });
    return out;
  };
  // Visits a day between consecutive readings, placed on the later reading.
  T.visitsByDay = function (g) {
    var out = HX.dates.map(function () { return null; });
    for (var i = 1; i < g.r.length; i++) {
      var a = g.r[i - 1], b = g.r[i];
      var days = (Date.parse(HX.times[b[0]]) - Date.parse(HX.times[a[0]])) / 864e5;
      if (days > 0.3 && b[2] >= a[2]) out[b[0]] = Math.round((b[2] - a[2]) / days);
    }
    return out;
  };
  T.ratingByDay = function (g) {
    var out = HX.dates.map(function () { return null; });
    g.r.forEach(function (x) { if (x[3] + x[4] > 0) out[x[0]] = Math.round(x[3] / (x[3] + x[4]) * 1000) / 10; });
    return out;
  };
  // The reading on a date index, or the closest earlier one within `slack` days.
  T.readingAt = function (g, di, slack) {
    for (var i = g.r.length - 1; i >= 0; i--) { if (g.r[i][0] <= di && di - g.r[i][0] <= (slack || 0)) return g.r[i]; if (g.r[i][0] < di - (slack || 0)) break; }
    return null;
  };
  // Index of the reading closest to `days` days before the last date (at least `min` days back).
  T.dayBack = function (days, min) {
    if (!HX || !HX.times.length) return null;
    var last = Date.parse(HX.times[HX.times.length - 1]), best = null, bd = null;
    HX.times.forEach(function (t, i) { var d = (last - Date.parse(t)) / 864e5; if (d >= (min || 0.5) && (bd == null || Math.abs(d - days) < Math.abs(bd - days))) { best = i; bd = d; } });
    return best == null ? null : { i: best, days: Math.round(bd) };
  };
  T.boardRank = function (uid, di) {
    var b = HX.boards[di];
    if (!b) return null;
    var at = b.indexOf(Number(uid));
    return at >= 0 ? at + 1 : 0;
  };

  // ---------- server ----------
  T.watchList = function () {
    return fetch("/api/watch", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : { rows: [] }; }).then(function (j) { return j.rows || []; });
  };
  T.watchSave = function (body) {
    return fetch("/api/watch", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || "save"); return j; }); });
  };
  T.live = function (uids) {
    uids = uids.filter(Boolean).slice(0, 100);
    if (!uids.length) return Promise.resolve({ games: {} });
    return fetch("/api/live?u=" + uids.join(","), { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : { games: {} }; }).catch(function () { return { games: {} }; });
  };

  // ---------- line chart ----------
  // opts: { labels: [x labels], series: [{ name, values: [v|null], key: "s1" }], fmt: fn, label: "for screen readers" }
  // One axis. 2px lines, end dots with a surface ring, hairline grid, a crosshair tooltip that lists
  // every series, a legend for two or more series, and a direct label at each line's end when the
  // ends don't crowd each other.
  var SVGNS = "http://www.w3.org/2000/svg";
  function S(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function niceStep(span, n) {
    var raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  T.lineChart = function (host, opts) {
    function draw() {
      host.textContent = "";
      var series = opts.series.filter(function (s) { return s.values.some(function (v) { return v != null; }); });
      if (opts.series.length > 1) {
        var leg = T.el("ul", "chart-legend");
        opts.series.forEach(function (s) {
          var li = T.el("li"); li.appendChild(T.el("span", "key " + s.key)); li.appendChild(document.createTextNode(s.name)); leg.appendChild(li);
        });
        host.appendChild(leg);
      }
      if (!series.length) { host.appendChild(T.el("p", "small muted", opts.empty || "No readings yet.")); return; }
      var W = Math.max(280, host.clientWidth || 600), H = opts.height || 240;
      var multi = opts.series.length > 1;
      var m = { l: 48, r: multi ? 24 : 76, t: 14, b: 28 };
      var n = opts.labels.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
      var all = [];
      series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) all.push(v); }); });
      var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
      if (opts.zero || lo < hi * 0.35) lo = 0;
      // A minimum span keeps small wobbles (a rating moving 0.4 points) from looking like cliffs.
      if (opts.minSpan && hi - lo < opts.minSpan) { var mid = (hi + lo) / 2; lo = mid - opts.minSpan / 2; hi = mid + opts.minSpan / 2; if (opts.max != null && hi > opts.max) { lo -= hi - opts.max; hi = opts.max; } }
      if (hi === lo) { hi = hi * 1.1 + 1; lo = Math.max(0, lo * 0.9 - 1); }
      var step = niceStep(hi - lo, 4);
      lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
      var x = function (i) { return m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); };
      var y = function (v) { return m.t + ih - ((v - lo) / (hi - lo)) * ih; };
      var svg = S("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": opts.label || "Chart" });
      svg.setAttribute("class", "chart-svg");
      for (var t = lo; t <= hi + step / 2; t += step) {
        svg.appendChild(S("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === lo ? "axis" : "grid" }));
        var tl = S("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" }); tl.textContent = (opts.tick || T.short)(t); svg.appendChild(tl);
      }
      var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
      opts.labels.forEach(function (lab, i) {
        if (i % every && i !== n - 1) return;
        if (i !== n - 1 && n - 1 - i <= every / 2) return;
        var xl = S("text", { x: x(i), y: H - 8, "text-anchor": i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle", class: "tick" }); xl.textContent = lab; svg.appendChild(xl);
      });
      var ends = [];
      series.forEach(function (s) {
        var d = "", pen = false, last = null;
        s.values.forEach(function (v, i) {
          if (v == null) { pen = false; return; }
          d += (pen ? " L" : " M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true; last = i;
        });
        svg.appendChild(S("path", { d: d.trim(), class: "line " + s.key }));
        s.values.forEach(function (v, i) {
          if (v == null) return;
          var lone = (i === 0 || s.values[i - 1] == null) && (i === n - 1 || s.values[i + 1] == null);
          if (lone && i !== last) svg.appendChild(S("circle", { cx: x(i), cy: y(v), r: 3, class: "dot " + s.key }));
        });
        if (last != null) { svg.appendChild(S("circle", { cx: x(last), cy: y(s.values[last]), r: 4, class: "dot end " + s.key })); ends.push({ s: s, i: last, y: y(s.values[last]) }); }
      });
      // Direct end labels only when they don't crowd; the legend and tooltip carry the rest.
      ends.sort(function (a, b) { return a.y - b.y; });
      var roomy = ends.every(function (e, k) { return k === 0 || e.y - ends[k - 1].y >= 16; });
      if (!multi && roomy) ends.forEach(function (e) {
        var tx = S("text", { x: x(e.i) + 9, y: e.y + 4, class: "endlab" }); tx.textContent = (opts.fmt || T.commas)(e.s.values[e.i]); svg.appendChild(tx);
      });
      var cross = S("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, class: "cross" }); cross.style.display = "none"; svg.appendChild(cross);
      var hit = S("rect", { x: m.l - 10, y: 0, width: iw + 20, height: H, fill: "transparent", tabindex: "0" });
      hit.setAttribute("aria-label", "Move along the chart with the arrow keys to read each day's numbers");
      svg.appendChild(hit);
      host.appendChild(svg);
      var tip = T.el("div", "chart-tip"); tip.hidden = true; tip.setAttribute("aria-live", "polite"); host.appendChild(tip);
      var at = null;
      function show(i) {
        at = Math.max(0, Math.min(n - 1, i));
        cross.setAttribute("x1", x(at)); cross.setAttribute("x2", x(at)); cross.style.display = "";
        tip.textContent = "";
        tip.appendChild(T.el("div", "tip-h", opts.labels[at]));
        opts.series.forEach(function (s) {
          var row = T.el("div", "tip-row"); row.appendChild(T.el("span", "key " + s.key));
          row.appendChild(T.el("strong", null, s.values[at] == null ? "No reading" : (opts.fmt || T.commas)(s.values[at])));
          if (multi) row.appendChild(T.el("span", "tip-n", s.name));
          tip.appendChild(row);
        });
        tip.hidden = false;
        var px = x(at) / W * host.clientWidth;
        tip.style.left = Math.min(Math.max(0, px + 12), host.clientWidth - tip.offsetWidth - 4) + "px";
        tip.style.top = (opts.series.length > 1 ? 34 : 4) + "px";
      }
      function hide() { cross.style.display = "none"; tip.hidden = true; }
      hit.addEventListener("pointermove", function (e) {
        var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
        show(n === 1 ? 0 : Math.round((px - m.l) / iw * (n - 1)));
      });
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("blur", hide);
      hit.addEventListener("focus", function () { show(at == null ? n - 1 : at); });
      hit.addEventListener("keydown", function (e) {
        if (e.key === "ArrowLeft") { e.preventDefault(); show((at == null ? n : at) - 1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); show((at == null ? -1 : at) + 1); }
        else if (e.key === "Escape") hide();
      });
    }
    draw();
    var wAt = host.clientWidth;
    window.addEventListener("resize", function () { if (Math.abs(host.clientWidth - wAt) > 4) { wAt = host.clientWidth; draw(); } });
  };

  // A plain table of the same numbers, for reading without the chart.
  T.chartTable = function (caption, labels, cols) {
    var t = T.el("table", "num-table");
    t.appendChild(T.el("caption", "sr-only", caption));
    var hr = T.el("tr");
    [""].concat(cols.map(function (c) { return c.name; })).forEach(function (h, k) { var th = T.el("th", null, h || "Date"); th.scope = "col"; hr.appendChild(th); });
    var th = T.el("thead"); th.appendChild(hr); t.appendChild(th);
    var tb = T.el("tbody");
    labels.forEach(function (lab, i) {
      if (cols.every(function (c) { return c.values[i] == null; })) return;
      var tr = T.el("tr"); var h = T.el("th", null, lab); h.scope = "row"; tr.appendChild(h);
      cols.forEach(function (c) { tr.appendChild(T.el("td", null, c.values[i] == null ? "–" : c.fmt(c.values[i]))); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  };

  window.SBT = T;
})();

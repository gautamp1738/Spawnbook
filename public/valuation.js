/* Spawnbook price model. One copy, used everywhere a price shows up: the board, game pages, the
   value calculator and the weekly report load it as a script; the Worker imports it for lookups,
   public game pages and the daily top 5; the daily collector loads it to build today's earnings
   curve. It sets window.SBV (globalThis.SBV in the Worker and in Node).

   Price = revenue a month × months of revenue.

   Revenue comes from Roblox's Top Earning chart, the one public ranking of what games earn. Every
   day the collector reads the whole chart (about 400 games) and the live player count of each game
   on it. From that we get a curve: how many players the typical game at each rank has. A game at
   rank r earns about what the typical game there earns, so its revenue is

     players typical of rank r × 720 hours a month × RATE

   RATE is developer revenue per player-hour at our afternoon reading. $0.02 keeps the typical
   board game at the price level the old visits-based model gave, and puts the whole chart at
   roughly two-thirds of what Roblox pays developers (DevEx was $1.5 billion in 2025), which fits
   how concentrated earnings are. It's a scale, not a measurement, and it's the same for every game,
   so it never changes the order of two games' prices.

   Games not on Top Earning earn less than the last game on the chart, so that's their ceiling.

   Months of revenue: measured decline when we've tracked a game 4 weeks, otherwise the genre's
   typical range (1–2 months for fast-rise games, 3–6 for slow builders), placed lower when the game
   is falling. Upside isn't priced in: buyers pay for it with a stake or revenue share instead.

   The range is a likely range, not best case to worst case. The two uncertainties (revenue, months)
   are combined the way independent errors are, rather than multiplying both worst cases together. */
(function (root) {
  var RATE = 0.02;          // dollars of developer revenue per player-hour at our daily reading
  var HOURS = 720;          // hours in a 30-day month
  var DEVEX = 0.0038;       // dollars per earned Robux (Roblox's DevEx rate since Sept 2025)
  var PER_VISIT = 0.008;    // rough rule, only for the calculator when someone types visits
  var PER_PLAYER_MAX = 3;   // a small game ranked high still gets at most 3× typical earnings per player
  var MONTHS = { rocket: [1, 1.5, 2], staircase: [3, 4.5, 6] };
  // How far each revenue estimate could reasonably be off, as a factor either way.
  var K_REV = { seller: 1, rank: 1.3, capped: 1.6, visits: 2, offchart: 2, unknown: 2.5 };
  var K_MONTHS = { measured: 1.2, genre: 1.25, fixed: 1 };

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function median(xs) {
    var s = xs.filter(function (x) { return x != null && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Closest curve that never rises as rank gets worse (pool adjacent violators).
  function decreasing(ys) {
    var blocks = [];
    ys.forEach(function (y) {
      blocks.push({ sum: y, n: 1 });
      while (blocks.length > 1) {
        var b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.sum / a.n >= b.sum / b.n) break;
        a.sum += b.sum; a.n += b.n; blocks.pop();
      }
    });
    var out = [];
    blocks.forEach(function (b) { for (var i = 0; i < b.n; i++) out.push(b.sum / b.n); });
    return out;
  }

  // list: [[Top Earning rank, players now], ...] from one reading. Returns players typical of each
  // rank (index 0 is rank 1): the median of the games ranked near it, smoothed so it never rises.
  // Null when the chart came back too short to trust.
  function curveFrom(list) {
    var by = [], n = 0;
    (list || []).forEach(function (x) { if (x[0] > 0 && x[1] > 0) { by[x[0] - 1] = x[1]; n = Math.max(n, x[0]); } });
    if (n < 50 || by.filter(Boolean).length < 40) return null;
    var raw = [];
    for (var r = 1; r <= n; r++) {
      var w = Math.max(3, Math.round(r * 0.15)), vals = [];
      for (var i = Math.max(1, r - w); i <= Math.min(n, r + w); i++) if (by[i - 1] > 0) vals.push(by[i - 1]);
      raw.push(median(vals) || (raw.length ? raw[raw.length - 1] : 0));
    }
    return decreasing(raw).map(function (x) { return Math.round(x); });
  }
  function peersAt(earn, rank) { return earn.curve[clamp(Math.round(rank), 1, earn.curve.length) - 1]; }
  function hasCurve(earn) { return !!(earn && earn.curve && earn.curve.length); }
  // Stand-in for a day when the collector couldn't build the curve: the chart's shape on Nov 1, 2026
  // (players ≈ 538,000 × rank^-0.91, 464 games deep).
  var FALLBACK = { curve: [], fallback: true };
  for (var fr = 1; fr <= 464; fr++) FALLBACK.curve.push(Math.round(538000 * Math.pow(fr, -0.91)));

  // o: { rank: Top Earning rank, 0 when we know it's off the chart, null when we don't know;
  //      players; seller: dollars a month the owner reported; visitsMonth: for the calculator }.
  // earn: META.earn from data.js.
  function revenue(o, earn) {
    o = o || {};
    if (o.seller > 0) return { mid: o.seller, k: K_REV.seller, basis: "seller" };
    if (o.visitsMonth > 0) return { mid: o.visitsMonth * PER_VISIT, k: K_REV.visits, basis: "visits" };
    var players = o.players > 0 ? o.players : 0;
    if (!hasCurve(earn)) earn = FALLBACK;
    if (o.rank != null) {
      var depth = earn.curve.length, floor = RATE * HOURS * earn.curve[depth - 1];
      if (o.rank > 0) {
        var rank = Math.min(Math.round(o.rank), depth), peers = peersAt(earn, rank), mid = RATE * HOURS * peers, basis = "rank";
        var cap = players ? PER_PLAYER_MAX * RATE * HOURS * players : Infinity;
        if (mid > cap) { mid = cap; basis = "capped"; }
        return { mid: mid, k: K_REV[basis], basis: basis, rank: rank, peers: peers, players: players, depth: depth, fallback: !!earn.fallback };
      }
      // Off the chart: it earns less than the last game on it. Half that, or half the typical
      // earnings for its players, whichever is lower.
      return { mid: Math.min(0.5 * RATE * HOURS * players, 0.5 * floor), k: K_REV.offchart, basis: "offchart", ceiling: floor, players: players, depth: depth };
    }
    return { mid: 0.5 * RATE * HOURS * players, k: K_REV.unknown, basis: "unknown", players: players };
  }

  // o: { shape: "rocket" | "staircase", decay: share of players lost a month when measured (0.15),
  //      week: players change over about a week (-0.25), peak: latest players ÷ most seen (0.55),
  //      months: a fixed number, for the calculator's measured decline }
  function months(o) {
    o = o || {};
    if (o.decay > 0) return { mid: clamp(1 / o.decay, 1, 12), k: K_MONTHS.measured, basis: "measured", decay: o.decay };
    var band = MONTHS[o.shape] || MONTHS.rocket, f = 1, why = null;
    if (o.week != null && o.week <= -0.2) { f = 0.75; why = "falling"; }
    else if (o.peak != null && o.peak < 0.6) { f = 0.85; why = "offpeak"; }
    return { mid: clamp(band[1] * f, band[0], band[2]), k: K_MONTHS.genre, basis: "genre", band: band, shape: o.shape === "staircase" ? "staircase" : "rocket", why: why };
  }

  function value(o, earn) {
    var r = revenue(o, earn), m = months(o);
    var k = Math.exp(Math.sqrt(Math.pow(Math.log(r.k), 2) + Math.pow(Math.log(m.k), 2)));
    var mid = r.mid * m.mid, lo = mid / k, hi = mid * k;
    if (r.basis === "offchart") hi = Math.max(mid, Math.min(hi, r.ceiling * m.mid * m.k));
    var conf = r.basis === "seller" ? "high" : r.basis === "rank" ? "medium" : "low";
    return { rev: r, months: m, mid: mid, lo: lo, hi: hi, k: k, year: r.mid * 12, conf: conf };
  }

  // The Top Earning rank we price a game on: META.earn.ranks, which for young games is the middle of
  // their last three daily readings, so one odd day doesn't swing the price. 0 when it's off the
  // chart, null when today's chart didn't load.
  function rankOf(earn, uid) { return earn && earn.ranks ? earn.ranks[uid] || 0 : null; }

  // A board row from data.js (BR.BOARD) as model input.
  function boardInput(row, earn) {
    var x = row[26] || {}, t = x.trend || {}, s = t.series || [];
    var last = s.length ? s[s.length - 1][1] : null;
    return {
      rank: earn && earn.ranks ? rankOf(earn, x.uid) : row[18] || 0, // the collector reads the whole chart
      players: row[7],
      shape: row[21],
      decay: row[25] && x.decay != null ? x.decay / 100 : null,
      week: t.d7 && t.d7.players != null ? t.d7.players / 100 : null,
      peak: t.peak && last != null && s.length >= 4 ? last / t.peak : null,
    };
  }

  // ---------- words, so every page explains a price the same way ----------
  function trim(v) { var s = v >= 100 ? v.toFixed(0) : v.toFixed(1); return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
  function money(x) {
    if (!isFinite(x) || x <= 0) return "$0";
    if (x >= 999.5e6) return "$" + trim(x / 1e9) + "B";
    if (x >= 999.5e3) return "$" + trim(x / 1e6) + "M";
    if (x >= 1e3) return "$" + Math.round(x / 1e3) + "K";
    return "$" + Math.round(x);
  }
  function commas(n) { return Math.round(n).toLocaleString("en-US"); }
  function times(x) { return (x >= 10 ? Math.round(x) : trim(x)) + "×"; }

  var CONF = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
  function confLabel(v) { return CONF[v.conf]; }
  function rangeText(v) { return money(v.lo) + " to " + money(v.hi); }

  // Where the revenue number comes from, in a sentence or two.
  function revenueWhy(v) {
    var r = v.rev;
    if (r.basis === "seller") return "From the revenue you entered.";
    if (r.basis === "visits") return "From visits at about $0.008 each, a rough rule. Robux earned gives a much tighter number.";
    if (r.basis === "unknown") return "From its players alone, because today's Top Earning chart didn't load. Treat it as rough.";
    if (r.basis === "offchart") return "It isn't on Roblox's Top Earning chart today, which runs down to games earning about " + money(r.ceiling) + " a month, so it most likely earns less than that.";
    var near = "games ranked near it have about " + commas(r.peers) + " players at our daily reading" + (r.fallback ? " (from an earlier reading, since today's didn't load)" : "");
    if (r.basis === "capped") return "#" + r.rank + " on Roblox's Top Earning chart today, where " + near + " and earn about " + money(RATE * HOURS * r.peers) + " a month. With only " + commas(r.players) + " players, we count it at no more than " + PER_PLAYER_MAX + "× typical earnings per player.";
    var s = "#" + r.rank + " on Roblox's Top Earning chart today. The " + near + ", and it earns about what they do.";
    if (r.players) {
      var ratio = r.players / r.peers;
      if (ratio >= 1.6) s += " It has " + times(ratio) + " their players, so it earns less per player than they do.";
      else if (ratio <= 0.6) s += " It has fewer players than they do, so it earns more per player.";
    }
    return s;
  }
  function monthsWhy(v) {
    var m = v.months;
    if (m.basis === "measured") return "It's losing about " + Math.round(m.decay * 100) + "% of its players a month, so we price it at about " + trim(m.mid) + " months of revenue.";
    var s = (m.shape === "staircase" ? "Slow-build genre, usually " + m.band[0] + " to " + m.band[2] : "Fast-rise genre, usually " + m.band[0] + " to " + m.band[2]) + " months of revenue";
    if (m.why === "falling") return s + ". Players fell over 20% this week, so we use " + trim(m.mid) + ".";
    if (m.why === "offpeak") return s + ". It's well below its peak, so we use " + trim(m.mid) + ".";
    return s + "; we use " + trim(m.mid) + ".";
  }

  root.SBV = {
    RATE: RATE, HOURS: HOURS, DEVEX: DEVEX, PER_VISIT: PER_VISIT, MONTHS: MONTHS,
    curveFrom: curveFrom, revenue: revenue, months: months, value: value, boardInput: boardInput, rankOf: rankOf, median: median,
    money: money, confLabel: confLabel, rangeText: rangeText, revenueWhy: revenueWhy, monthsWhy: monthsWhy,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

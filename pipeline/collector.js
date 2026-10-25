/* Spawnbook collector, v1.
   Run inside the Claude desktop app's built-in browser on a https://www.roblox.com page.
   It reads Roblox's public chart lists and game stats, keeps a daily history in this
   browser's localStorage (key "br.hist.v1"), scores young games and builds the report's data file.

   Daily:   await BRC.run()                     -> saves today's snapshot, returns a summary
   Weekly:  await BRC.run({ weekly: true })     -> also logs this week's picks and returns dataJs
   Extras:  BRC.exportHistory() / BRC.importHistory(json) for backups.
*/
window.BRC = (function () {
  var KEY = "br.hist.v1", PICKS = "br.picks.v1";
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var C = function (x, a, b) { return Math.max(a, Math.min(b, x)); };

  // Roblox rate-limits unauthenticated calls, so requests go out one at a time, about 1.2 s apart,
  // and a "too many requests" answer waits 4, 8, 16, 32, 64 then 128 seconds before trying again.
  var lastCall = 0;
  async function getJSON(url, tries) {
    tries = tries || 7;
    for (var i = 0; i < tries; i++) {
      var wait = Math.max(0, lastCall + 1200 - Date.now());
      if (wait) await sleep(wait);
      lastCall = Date.now();
      try {
        var r = await fetch(url, { credentials: "omit" });
        if (r.status === 429 || r.status >= 500) { await sleep(4000 * Math.pow(2, i)); continue; }
        if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
        return await r.json();
      } catch (e) { if (i === tries - 1) throw e; await sleep(2000 * (i + 1)); }
    }
    throw new Error("Roblox kept refusing requests (rate limit) for " + url);
  }
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function saveJSON(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function pDate(d) { return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
  function pLabel(d) { return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }); }
  function pTime(d) { return d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }); }

  var STAIR = { "RPG": 1, "Shooter": 1, "Action": 1, "Sports & Racing": 1, "Strategy": 1, "Roleplay & Avatar Sim": 1, "Adventure": 1, "Puzzle": 1, "Party & Casual": 1, "Survival": 1, "Obby & Platformer": 1 };
  var WAVE = /steal|grow a|\+1|egg|brainrot|hatcher|rng|anomaly|lucky block|evolution|roll a/i;
  var IP = [[/free fire/i, "Free Fire"], [/blue lock/i, "Blue Lock"], [/deltarune|undertale/i, "DELTARUNE or Undertale"], [/hulk|ultron|marvel|spider-?man|avengers/i, "Marvel characters"], [/\bipad\b|\biphone\b|\bapple\b/i, "Apple"], [/chiikawa/i, "Chiikawa"], [/adventure time/i, "Adventure Time"], [/fnaf|freddy/i, "Five Nights at Freddy's"], [/oregon trail/i, "The Oregon Trail"], [/mothra|godzilla|kaiju/i, "Toho's kaiju"], [/krusty|spongebob/i, "SpongeBob"], [/morioh|jojo/i, "JoJo's Bizarre Adventure"], [/kukirin/i, "Kukirin, a scooter brand"], [/mafuba|dragon ball/i, "Dragon Ball"], [/naruto/i, "Naruto"], [/one piece/i, "One Piece"], [/pok[eé]mon/i, "Pokémon"], [/minecraft/i, "Minecraft"], [/disney|pixar/i, "Disney"], [/skibidi|cameraman/i, "Skibidi Toilet"], [/\bsonic\b/i, "Sonic"], [/\bmario\b/i, "Mario"]];
  var AFK = /afk|donate|pls |ugc/i;
  var CUE = /upd|update|world ?2|ch ?2|v3|new|🎃|season|halloween|release|event/i;
  function ipOf(name) { for (var i = 0; i < IP.length; i++) if (IP[i][0].test(name)) return IP[i][1]; return null; }

  async function collect(now) {
    var sid = crypto.randomUUID(), sorts = {}, tok = "", lists = 0;
    for (var p = 0; p < 12; p++) {
      var j = await getJSON("https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=" + sid + "&device=computer&country=all" + (tok ? "&sortsPageToken=" + encodeURIComponent(tok) : ""));
      for (var s of (j.sorts || [])) {
        if (s.contentType !== "Games" || !s.games || !s.games.length) continue;
        lists++;
        var games = s.games.slice(), next = s.nextPageToken, extra = 0;
        while (next && extra < 2) {
          try {
            var k = await getJSON("https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=" + sid + "&sortId=" + encodeURIComponent(s.sortId) + "&pageToken=" + encodeURIComponent(next) + "&device=computer&country=all");
            games = games.concat(k.games || []); next = k.nextPageToken;
          } catch (e) { next = null; }
          extra++;
        }
        games.forEach(function (g, i) { var m = (sorts[g.universeId] = sorts[g.universeId] || {}); if (!m[s.sortId]) m[s.sortId] = i + 1; });
      }
      tok = j.nextSortsPageToken; if (!tok) break;
    }
    var uids = Object.keys(sorts).map(Number), G = {}, V = {};
    for (var i = 0; i < uids.length; i += 50) {
      var gj = await getJSON("https://games.roblox.com/v1/games?universeIds=" + uids.slice(i, i + 50).join(","));
      (gj.data || []).forEach(function (g) { G[g.id] = g; });
      await sleep(150);
    }
    for (var i2 = 0; i2 < uids.length; i2 += 50) {
      try {
        var vj = await getJSON("https://games.roblox.com/v1/games/votes?universeIds=" + uids.slice(i2, i2 + 50).join(","));
        (vj.data || []).forEach(function (v) { V[v.id] = v; });
      } catch (e) {}
      await sleep(150);
    }
    return { sorts: sorts, G: G, V: V, lists: lists, uids: uids };
  }

  async function enrich(list) {
    // list: [{uid, cid, ctype}] -> {uid: {passes, pmin, pmax, discord, members}}
    var out = {};
    for (var x of list) {
      var e = { passes: null, pmin: null, pmax: null, members: null };
      try {
        var gp = await getJSON("https://apis.roblox.com/game-passes/v1/universes/" + x.uid + "/game-passes?passView=Full&pageSize=100");
        var prices = (gp.gamePasses || []).filter(function (q) { return q.isForSale && q.price; }).map(function (q) { return q.price; });
        e.passes = prices.length; e.pmin = prices.length ? Math.min.apply(null, prices) : null; e.pmax = prices.length ? Math.max.apply(null, prices) : null;
      } catch (err) {}
      if (x.ctype === "Group") {
        try { var gr = await getJSON("https://groups.roblox.com/v1/groups/" + x.cid); e.members = gr.memberCount || null; } catch (err) {}
      }
      out[x.uid] = e;
      await sleep(250);
    }
    return out;
  }

  function pct(vals) {
    var n = vals.length;
    return vals.map(function (v) { var b = 0, e = 0; vals.forEach(function (w) { if (w < v) b++; else if (w === v) e++; }); return n > 1 ? (b + 0.5 * (e - 1)) / (n - 1) : 0.5; });
  }

  async function run(opts) {
    opts = opts || {};
    var now = new Date();
    var data = await collect(now);
    var G = data.G, V = data.V, sorts = data.sorts;
    var isRoblox = function (g) { return /^roblox$/i.test((g.creator && g.creator.name) || "") || /roblox presents/i.test(g.name); };
    var young = data.uids.map(function (u) { return G[u]; }).filter(function (g) { return g && !isRoblox(g) && (now - new Date(g.created)) / 864e5 <= 183; });

    // Save today's snapshot
    var hist = loadJSON(KEY, { v: 1, snaps: [] });
    var snap = { t: now.toISOString(), d: pDate(now), g: {} };
    young.forEach(function (g) { var v = V[g.id] || {}; snap.g[g.id] = [g.visits, g.playing, g.favoritedCount, v.upVotes || 0, v.downVotes || 0]; });
    hist.snaps = hist.snaps.filter(function (s) { return s.d !== snap.d; });
    hist.snaps.push(snap);
    hist.snaps.sort(function (a, b) { return a.t < b.t ? -1 : 1; });
    if (hist.snaps.length > 120) hist.snaps = hist.snaps.slice(-120);
    try { saveJSON(KEY, hist); } catch (e) { hist.snaps = hist.snaps.slice(-60); saveJSON(KEY, hist); }

    var prior = hist.snaps.filter(function (s) { return s.t < snap.t; });
    var daysAgo = function (s) { return (now - new Date(s.t)) / 864e5; };
    var pick = function (minD, target) { var best = null; prior.forEach(function (s) { var d = daysAgo(s); if (d >= minD && (!best || Math.abs(d - target) < Math.abs(daysAgo(best) - target))) best = s; }); return best; };
    var p1 = pick(0.75, 1), p7 = pick(5, 7), p28 = pick(21, 28);

    // Metrics
    var rows = young.map(function (g) {
      var age = (now - new Date(g.created)) / 864e5;
      var life = g.visits / Math.max(age, 0.5);
      var at = function (s) { return s && s.g[g.id]; };
      var a1 = at(p1), a7 = at(p7), a28 = at(p28);
      var paceDay = a1 && g.visits > a1[0] ? (g.visits - a1[0]) / daysAgo(p1) : null;
      var paceWeek = a7 && g.visits > a7[0] ? (g.visits - a7[0]) / daysAgo(p7) : null;
      var pace = paceWeek || paceDay || life;
      var fresh = paceWeek ? 7 : paceDay ? 1 : 0;
      var accel = fresh ? (paceWeek || paceDay) / life : null;
      var pgrowth7 = a7 && a7[1] > 0 ? g.playing / a7[1] : null;
      var mult = null, decay = null;
      if (a28 && a28[1] > 0) {
        var monthly = Math.pow(g.playing / a28[1], 30 / daysAgo(p28)) - 1;
        if (monthly < -0.02) { decay = -monthly; var m = function (x) { return +C(x, 1, 12).toFixed(1); }; mult = [m(1 / (decay * 4 / 3)), m(1 / decay), m(1 / (decay * 2 / 3))]; }
      }
      var v = V[g.id] || {}, up = v.upVotes || 0, down = v.downVotes || 0;
      var like = up + down ? up / (up + down) : 0;
      var s = sorts[g.id] || {};
      var gk = Object.keys(s).find(function (k) { return k.indexOf("trending-in-") === 0; });
      var hrs = (now - new Date(g.updated)) / 3.6e6;
      var wave = WAVE.test(g.name);
      var shape = ((STAIR[g.genre_l1] && !wave) || /fish/i.test(g.name)) ? "staircase" : "rocket";
      return {
        g: g, uid: g.id, pid: g.rootPlaceId, name: g.name, creator: (g.creator && g.creator.name) || "", cid: g.creator && g.creator.id, ctype: g.creator && g.creator.type,
        ver: g.creator && g.creator.hasVerifiedBadge, genre: g.genre_l1 || "", genre2: g.genre_l2 || "", age: age, playing: g.playing, visits: g.visits,
        life: life, pace: pace, fresh: fresh, accel: accel, pgrowth7: pgrowth7, mult: mult, decay: decay,
        sess: g.playing * 1440 / pace, like: like, favk: g.favoritedCount / Math.max(g.visits, 1) * 1000, vk: (up + down) / Math.max(g.visits, 1) * 1000,
        hrs: hrs, U: s["up-and-coming"] || 0, T: s["top-trending"] || 0, E: s["top-earning"] || 0, R: s["top-revisited"] || 0, Gk: gk ? s[gk] : 0,
        sorts: s, wave: wave, shape: shape, ip: ipOf(g.name)
      };
    });

    var pool = rows.filter(function (r) { return r.playing >= 500 && r.playing <= 15000 && r.age <= 120 && r.like >= 0.85 && r.pace > 0; });
    function rawParts(r, members) {
      var mom = (r.accel != null ? C((Math.min(r.accel, 6) - 1) / 5, 0, 1) * 12 : 4) + (r.U ? (1 - (r.U - 1) / 100) * 8 : 0) + (r.T ? (1 - (r.T - 1) / 100) * 5 : 0) + (r.Gk && r.Gk <= 20 ? 2 : 0) + (r.pgrowth7 != null ? C(r.pgrowth7 - 1, 0, 1) * 6 : 0);
      var st = C(Math.log(Math.max(r.sess, 1) / 3) / Math.log(26 / 3), 0, 1) * 13 + C((r.like - 0.85) / 0.13, 0, 1) * 6 + C(r.favk / 30, 0, 1) * 3 + C(r.vk / 5, 0, 1) * 3 + (r.R ? 3 : 0);
      var lo = Math.min(15, (r.hrs < 24 ? 9 : r.hrs < 72 ? 6 : r.hrs < 168 ? 3 : 0) + (CUE.test(r.name) ? 3 : 0) + (r.age > 30 && r.hrs < 72 ? 3 : 0));
      var og = C((r.shape === "staircase" ? 13 : 9) - (r.wave ? 6 : 0), 0, 15);
      var mon = r.E ? (r.E <= 50 ? 10 : r.E <= 100 ? 8 : r.E <= 150 ? 6 : 4) : 0;
      var own = r.ctype === "User" ? "U" : r.ver ? "Gv" : "G";
      if (members && members > 1000000) own = "Gbig";
      var deal = own === "U" ? 7 : own === "Gv" ? 5 : own === "Gbig" ? 3 : 8;
      if (r.ip) deal = Math.max(0, deal - 6);
      var flags = [];
      if (r.sess > 45) flags.push("Estimated " + Math.round(r.sess) + " minutes per visit, high for most genres" + (r.fresh ? "" : ". No fresh visit reading"));
      if (r.favk > 60) flags.push(Math.round(r.favk) + " favorites per 1,000 visits, among the highest this week");
      if (r.vk < 0.5) flags.push((Math.round(r.vk * 10) / 10) + " votes per 1,000 visits, among the lowest this week");
      if (r.accel != null && r.accel > 20 && r.age > 60) flags.push("Visits jumped " + Math.round(r.accel) + "× its lifetime average");
      if (AFK.test(r.name)) flags.push("Name suggests AFK or free-item rewards");
      return { mom: mom, st: st, lo: lo, og: og, mon: mon, deal: deal, own: own, flags: flags };
    }
    function scoreAll(members) {
      var parts = pool.map(function (r) { return rawParts(r, members[r.uid] && members[r.uid].members); });
      var pm = pct(parts.map(function (p) { return p.mom; })), ps = pct(parts.map(function (p) { return p.st; }));
      pool.forEach(function (r, i) {
        var p = parts[i];
        r.comp = [Math.round(pm[i] * 25), Math.round(ps[i] * 25), Math.round(p.lo), Math.round(p.og), p.mon, p.deal];
        r.score = r.comp.reduce(function (a, b) { return a + b; }, 0) - p.flags.length * 5;
        r.flags = p.flags; r.own = p.own;
      });
    }
    scoreAll({});
    var cands = pool.filter(function (r) { return !r.ip && !r.flags.length; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 35);
    var extra = await enrich(cands.map(function (r) { return { uid: r.uid, cid: r.cid, ctype: r.ctype }; }));
    scoreAll(extra);
    var board = pool.filter(function (r) { return !r.ip && !r.flags.length && r.score >= 55; }).sort(function (a, b) { return b.score - a.score || b.playing - a.playing; }).slice(0, 25);

    var r1 = function (x) { return Math.round(x * 10) / 10; };
    var BOARD = board.map(function (r) {
      var e = extra[r.uid] || {};
      return [r.pid, r.name, r.creator, r.own, r.genre, r.genre2, Math.round(r.age), r.playing, Math.round(r.pace), r.fresh, r.accel != null ? r1(r.accel) : null, r1(r.sess), r1(r.like * 100), r1(r.favk), r1(r.vk), Math.round(r.hrs), r.U, r.T, r.E, r.R, r.Gk, r.shape, r.wave ? 1 : 0, r.comp.join("/"), r.score, r.mult,
        { passes: e.passes, pmin: e.pmin, pmax: e.pmax, members: e.members, discord: /discord/i.test(r.g.description || "") ? 1 : 0, cid: r.cid, ctype: r.ctype, pgrowth7: r.pgrowth7 != null ? r1(r.pgrowth7) : null, decay: r.decay != null ? r1(r.decay * 100) : null }];
    });
    var big = rows.slice().sort(function (a, b) { return b.playing - a.playing; }).slice(0, 25);
    var abbr = { "up-and-coming": "U", "top-trending": "T", "top-earning": "E", "top-revisited": "R" };
    var BIG = big.map(function (r) {
      var ranks = Object.keys(r.sorts).filter(function (k) { return abbr[k]; }).map(function (k) { return abbr[k] + r.sorts[k]; }).join(" ");
      return [r.pid, r.name, r.creator, r.ctype === "User" ? "U" : r.ver ? "Gv" : "G", r.genre, r.genre2, Math.round(r.age), r.playing, r.visits, Math.round(r.pace), r.fresh, r1(r.like * 100), ranks];
    });
    var BIG_NOTES = {};
    big.forEach(function (r) {
      var n = {};
      if (r.ip) n.ip = "Name may reference " + r.ip;
      if (r.mult) { n.mult = r.mult; n.note = "Down about " + Math.round(r.decay * 100) + "% a month"; }
      if (Object.keys(n).length) BIG_NOTES[r.pid] = n;
    });
    var IP_OFF = pool.filter(function (r) { return r.ip && r.score >= 45; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 12)
      .map(function (r) { return [r.pid, r.name, r.playing, Math.round(r.age), "Name may reference " + r.ip]; });
    var FLAG_OFF = pool.filter(function (r) { return !r.ip && r.flags.length && r.score >= 45; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 12)
      .map(function (r) { return [r.pid, r.name, r.playing, Math.round(r.age), r.flags.join(". ")]; });

    var first = hist.snaps[0];
    var visitsNote = p7 ? "Visits are the daily average over the past " + Math.round(daysAgo(p7)) + " days." : p1 ? "Visits are the daily change since " + pLabel(new Date(p1.t)) + "." : "Visits are lifetime averages until our daily record builds up.";
    var picks = loadJSON(PICKS, []);
    if (opts.weekly) {
      var d = pDate(now);
      picks = picks.filter(function (x) { return x.d !== d; });
      board.forEach(function (r, i) { picks.push({ d: d, rank: i + 1, uid: r.uid, pid: r.pid, name: r.name, score: r.score, playing: r.playing, pace: Math.round(r.pace) }); });
      saveJSON(PICKS, picks);
    }
    var pickDates = Array.from(new Set(picks.map(function (x) { return x.d; }))).sort();
    var META = {
      snapshot: pLabel(now),
      issueNote: "Players counted at " + pTime(now) + " Pacific. " + visitsNote,
      checked: data.uids.length,
      pool: pool.length,
      readings: "We read Roblox's public chart lists once a day at about the same time and keep a daily record of every young game's visits, players, favorites and votes. Our record started on " + pLabel(new Date(first.t)) + " and now covers " + hist.snaps.length + " day" + (hist.snaps.length === 1 ? "" : "s") + ". " + visitsNote + " Players is the live count at the latest reading.",
      playersNote: "one count at " + pTime(now) + " Pacific",
      historyDays: hist.snaps.length,
      picksLogged: picks.length,
      firstPicks: pickDates[0] || null,
      issues: pickDates.length
    };
    var BR = { META: META, BOARD: BOARD, BIG: BIG, BIG_NOTES: BIG_NOTES, IP_OFF: IP_OFF, FLAG_OFF: FLAG_OFF };
    var dataJs = "/* Spawnbook data, built " + now.toISOString() + ". The page reads window.BR. */\nwindow.BR = " + JSON.stringify(BR, null, 1) + ";\n";
    var picksCsv = opts.weekly ? board.map(function (r, i) { return [pDate(now), i + 1, '"' + r.name.replace(/"/g, '""') + '"', r.pid, r.score, r.playing, Math.round(r.pace)].join(","); }).join("\n") : "";
    window.__BR_LAST = { dataJs: dataJs, picksCsv: picksCsv, board: board.map(function (r) { return [r.name, r.score]; }), ids: rows.map(function (r) { return [r.pid, r.uid, r.cid, r.ctype, r.playing]; }), descs: rows.reduce(function (o, r) { o[r.pid] = r.g.description || ""; return o; }, {}) };
    return {
      ok: true, at: now.toISOString(), lists: data.lists, gamesSeen: data.uids.length, youngTracked: young.length, pool: pool.length,
      board: board.length, top5: board.slice(0, 5).map(function (r) { return r.name + " (" + r.score + ")"; }),
      historyDays: hist.snaps.length, firstDay: first.d, visitsBasis: p7 ? "7-day" : p1 ? "1-day" : "lifetime",
      picksLogged: picks.length, dataJsLength: dataJs.length
    };
  }

  function exportHistory() { return localStorage.getItem(KEY) || ""; }
  function importHistory(json) {
    var incoming = typeof json === "string" ? JSON.parse(json) : json;
    var hist = loadJSON(KEY, { v: 1, snaps: [] });
    var byDay = {};
    hist.snaps.concat(incoming.snaps || []).forEach(function (s) { if (!byDay[s.d] || byDay[s.d].t < s.t) byDay[s.d] = s; });
    hist.snaps = Object.keys(byDay).sort().map(function (k) { return byDay[k]; }).slice(-120);
    saveJSON(KEY, hist);
    return hist.snaps.length;
  }
  function compactToday() {
    var hist = loadJSON(KEY, { v: 1, snaps: [] }); var s = hist.snaps[hist.snaps.length - 1];
    return s ? JSON.stringify({ v: 1, snaps: [s] }) : "";
  }
  return { run: run, enrich: enrich, exportHistory: exportHistory, importHistory: importHistory, compactToday: compactToday };
})();
"BRC ready";

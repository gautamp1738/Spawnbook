/* Spawnbook collector, v2.
   Runs in Node through pipeline/runner.mjs (GitHub Actions, daily), which gives it a window and a
   localStorage backed by the files in pipeline/state/. It reads Roblox's public chart lists and game
   stats, keeps a daily history (key "br.hist.v1"), scores young games and builds the board's data file.
   v2 adds, for the 25 board games: rank change and days on the board, a 14-day player series, peak
   players, 1- and 7-day changes, developer products, servers, creator portfolio, content maturity
   and badges. v3 adds the track record (key "br.track.v1": each Monday's picks and the games that
   made the cut but weren't picked, read again at 1, 2, 4 and 8 weeks) and the weekly report
   (key "br.report.v1": one issue per Monday).

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
  // For the extra detail on board games: one retry at most, and no retry on 4xx, so a blocked or
  // missing source costs seconds rather than minutes. Shares the same 1.2 s spacing as getJSON.
  async function getOnce(url, init) {
    for (var i = 0; i < 2; i++) {
      var wait = Math.max(0, lastCall + 1200 - Date.now());
      if (wait) await sleep(wait);
      lastCall = Date.now();
      var r = await fetch(url, Object.assign({ credentials: "omit" }, init || {}));
      if (r.status === 429 && i === 0) { await sleep(8000); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
      return await r.json();
    }
    throw new Error("Rate limited: " + url);
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

  // Extra public detail for the games that make the board. Every source is optional: if one fails,
  // that field is left out and the run carries on. Sources that fail with a network error (blocked)
  // are skipped for the rest of the run.
  async function deep(list) {
    var out = {}, off = {};
    async function tryGet(key, url, init) {
      if (off[key]) return null;
      try { return await getOnce(url, init); }
      catch (e) { if (!/^(HTTP |Rate limited)/.test(String(e && e.message))) off[key] = true; return null; }
    }
    // The servers endpoint rate-limits hard from shared IPs like GitHub's, so its pages get
    // patient retries, up to about five minutes of waiting in a whole run.
    var serverWait = 300000;
    async function serverPage(url) {
      for (var a = 0; a < 3; a++) {
        var res = await tryGet("servers", url);
        if (res || off.servers) return res;
        var w = a === 0 ? 12000 : 30000;
        if (a === 2 || serverWait < w) return null;
        serverWait -= w; await sleep(w);
      }
      return null;
    }
    var srvState = {};
    var serversUrl = function (r, cur) { return "https://games.roblox.com/v1/games/" + r.pid + "/servers/Public?limit=100&sortOrder=Desc" + (cur ? "&cursor=" + encodeURIComponent(cur) : ""); };
    var rng = function (nums) { return nums.length ? [Math.min.apply(null, nums), Math.max.apply(null, nums)] : null; };
    for (var r of list) {
      var d = {}, g = r.g || {};
      d.game = {
        maxPlayers: g.maxPlayers || null,
        paid: g.price || null,
        vip: !!g.createVipServersAllowed,
        licensed: g.isOfficiallyLicensed ? "official" : g.isCommunityLicensed ? "community" : null,
        restricted: !!g.isContentRestricted,
        created: g.created || null,
        updated: g.updated || null
      };

      // Developer products: up to 5 pages of 100.
      var prods = [], cur = "", pages = 0, gotAny = false, more = false;
      do {
        var dp = await tryGet("dp", "https://apis.roblox.com/developer-products/v2/universes/" + r.uid + "/developerproducts?limit=100" + (cur ? "&cursor=" + encodeURIComponent(cur) : ""));
        if (!dp) break;
        gotAny = true; pages++;
        prods = prods.concat((dp.developerProducts || []).filter(function (x) { return x.IsForSale && x.PriceInRobux; }));
        cur = dp.nextPageCursor || ""; more = !!cur;
      } while (cur && pages < 5);
      if (gotAny) d.products = { n: prods.length, more: more, range: rng(prods.map(function (x) { return x.PriceInRobux; })) };

      // Public servers, fullest first. The first page (100) is read here, between the other
      // calls, so every game gets one; more pages are read after the loop if Roblox allows.
      var sv = await serverPage(serversUrl(r, ""));
      if (sv) srvState[r.uid] = { r: r, g: g, list: sv.data || [], cur: sv.nextPageCursor || "", pages: 1 };

      var c = { type: r.ctype, id: r.cid };
      if (r.ctype === "Group") {
        var gr = await tryGet("group", "https://groups.roblox.com/v1/groups/" + r.cid);
        if (gr) {
          c.members = gr.memberCount || null;
          c.verified = !!gr.hasVerifiedBadge;
          c.owner = gr.owner ? gr.owner.username : null;
          c.tier = gr.communityTier && gr.communityTier.currentTier != null ? gr.communityTier.currentTier : null;
        }
      } else if (r.ctype === "User") {
        var us = await tryGet("user", "https://users.roblox.com/v1/users/" + r.cid);
        if (us) { c.verified = !!us.hasVerifiedBadge; c.joined = us.created || null; }
      }
      var pf = await tryGet("portfolio", "https://games.roblox.com/v2/" + (r.ctype === "Group" ? "groups" : "users") + "/" + r.cid + "/games?accessFilter=Public&limit=50&sortOrder=Desc");
      if (pf && pf.data) {
        var others = pf.data.filter(function (x) { return !(x.rootPlace && x.rootPlace.id === r.pid) && x.id !== r.uid; });
        var top = others.slice().sort(function (a, b) { return (b.placeVisits || 0) - (a.placeVisits || 0); })[0];
        c.games = pf.data.length;
        c.moreGames = !!pf.nextPageCursor;
        c.totalVisits = pf.data.reduce(function (a, x) { return a + (x.placeVisits || 0); }, 0);
        c.topOther = top ? [top.name, top.placeVisits || 0, top.rootPlace ? top.rootPlace.id : null] : null;
      }
      d.creator = c;

      var mat = await tryGet("maturity", "https://apis.roblox.com/experience-guidelines-api/experience-guidelines/get-age-recommendation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ universeId: r.uid }) });
      var ard = mat && mat.ageRecommendationDetails;
      var rec = ard && ard.summary && ard.summary.ageRecommendation;
      if (rec) d.maturity = {
        name: rec.contentMaturity === "unrated" ? "Unrated" : rec.displayName || null,
        minAge: rec.contentMaturity === "unrated" ? 0 : rec.minimumAge || 0,
        has: (ard.descriptorUsages || []).filter(function (u) { return u.contains !== false && u.descriptor && u.descriptor.displayName; }).map(function (u) { return u.descriptor.displayName; }).slice(0, 6)
      };

      var bd = await tryGet("badges", "https://badges.roblox.com/v1/universes/" + r.uid + "/badges?limit=100&sortOrder=Asc");
      if (bd && bd.data) {
        var awarded = bd.data.map(function (x) { return (x.statistics && x.statistics.awardedCount) || 0; });
        d.badges = { n: bd.data.length, more: !!bd.nextPageCursor, topAwarded: awarded.length ? Math.max.apply(null, awarded) : 0 };
      }
      out[r.uid] = d;
    }
    // Up to two more server pages per game, stopping at the first refusal so the limit isn't pushed.
    var srvOk = true;
    for (var uid in srvState) {
      var st = srvState[uid];
      while (srvOk && st.cur && st.pages < 3) {
        await sleep(1500);
        var nxt = await tryGet("servers", serversUrl(st.r, st.cur));
        if (!nxt) { srvOk = false; break; }
        st.list = st.list.concat(nxt.data || []); st.cur = nxt.nextPageCursor || ""; st.pages++;
      }
    }
    // If there are more servers than we read, the fullest servers' average overstates the real
    // one, so players / that average is a floor on the server count.
    Object.keys(srvState).forEach(function (uid) {
      var st = srvState[uid], srv = st.list;
      if (!srv.length || !out[uid]) return;
      var avg = srv.reduce(function (a, x) { return a + (x.playing || 0); }, 0) / srv.length;
      var cap = srv[0].maxPlayers || st.g.maxPlayers || null;
      out[uid].servers = { counted: srv.length, complete: !st.cur, avgPlayers: Math.round(avg * 10) / 10, fill: cap ? Math.round(avg / cap * 100) : null,
        atLeast: st.cur && avg > 0 ? Math.max(srv.length, Math.round(st.r.playing / avg)) : srv.length };
    });
    return { byUid: out, skipped: Object.keys(off) };
  }

  // ---------- Track record ----------
  // Each Monday's picks are kept with their numbers at the time ("at0"), next to every other game
  // that made the cut that day but wasn't picked (the "pool"), so picks can be compared with a fair
  // baseline. Every daily run reads all of them again straight from Roblox, whether or not they're
  // still on the chart lists, and keeps a reading at 1, 2, 4 and 8 weeks. Readings are
  // [visits, players, favorites, up votes, down votes]; at0 adds visits a day at pick time.
  var TRACK = "br.track.v1", REPORT = "br.report.v1", INDEX = "br.index.v1";
  var trackReadings = {}, fetchedGames = {};
  var CPS = [7, 14, 28, 56];
  var median = function (xs) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  async function readNow(uids, G, V) {
    var need = uids.filter(function (u) { return !G[u]; }), g2 = {}, v2 = {};
    for (var i = 0; i < need.length; i += 50) {
      var gj = await getJSON("https://games.roblox.com/v1/games?universeIds=" + need.slice(i, i + 50).join(","));
      (gj.data || []).forEach(function (g) { g2[g.id] = g; fetchedGames[g.id] = g; });
    }
    for (var j = 0; j < need.length; j += 50) {
      try {
        var vj = await getJSON("https://games.roblox.com/v1/games/votes?universeIds=" + need.slice(j, j + 50).join(","));
        (vj.data || []).forEach(function (v) { v2[v.id] = v; });
      } catch (e) {}
    }
    var out = {};
    uids.forEach(function (u) {
      var g = G[u] || g2[u], v = V[u] || v2[u] || {};
      out[u] = g ? [g.visits, g.playing, g.favoritedCount, v.upVotes || 0, v.downVotes || 0] : null;
    });
    return out;
  }

  async function updateTrack(now, opts, board, pool, G, V, histSnaps) {
    var tr = loadJSON(TRACK, { v: 1, batches: [] });
    var picks = loadJSON(PICKS, []);
    var today = pDate(now);
    var have = {};
    tr.batches.forEach(function (b) { have[b.d] = 1; });

    // Picks logged before tracking existed: rebuild their starting numbers from that day's snapshot.
    Array.from(new Set(picks.map(function (x) { return x.d; }))).forEach(function (d) {
      if (have[d] || (opts.weekly && d === today)) return;
      var rowsD = picks.filter(function (x) { return x.d === d; });
      var s = histSnaps.filter(function (h) { return h.d === d; }).pop();
      var at0 = {}, peak = {};
      rowsD.forEach(function (x) {
        var a = s && s.g[x.uid];
        at0[x.uid] = a ? [a[0], a[1], a[2], a[3], a[4], x.pace] : [null, x.playing, null, null, null, x.pace];
        peak[x.uid] = [at0[x.uid][1], d];
      });
      tr.batches.push({ d: d, t: s ? s.t : d + "T21:33:00.000Z", picks: rowsD.map(function (x) { return { uid: x.uid, pid: x.pid, name: x.name, rank: x.rank, score: x.score }; }), pool: [], at0: at0, cp: {}, peak: peak });
    });

    // Today's picks, on Mondays.
    if (opts.weekly) {
      tr.batches = tr.batches.filter(function (b) { return b.d !== today; });
      var onBoard = {};
      board.forEach(function (r) { onBoard[r.uid] = 1; });
      var rest = pool.filter(function (r) { return !onBoard[r.uid]; });
      var at0 = {}, peak = {};
      board.concat(rest).forEach(function (r) {
        var v = V[r.uid] || {};
        at0[r.uid] = [r.visits, r.playing, r.g.favoritedCount, v.upVotes || 0, v.downVotes || 0, Math.round(r.pace)];
      });
      board.forEach(function (r) { peak[r.uid] = [r.playing, today]; });
      tr.batches.push({
        d: today, t: now.toISOString(),
        picks: board.map(function (r, i) { return { uid: r.uid, pid: r.pid, name: r.name, rank: i + 1, score: r.score }; }),
        pool: rest.map(function (r) { return r.uid; }), at0: at0, cp: {}, peak: peak
      });
    }
    tr.batches.sort(function (a, b) { return a.d < b.d ? -1 : 1; });

    // Read every game in every batch that still has checkpoints to fill.
    var ageOf = function (b) { return (now - new Date(b.t)) / 864e5; };
    var active = tr.batches.filter(function (b) { return ageOf(b) > 0.25 && !b.cp[CPS[CPS.length - 1]]; });
    var want = {};
    active.forEach(function (b) { b.picks.forEach(function (p) { want[p.uid] = 1; }); b.pool.forEach(function (u) { want[u] = 1; }); });
    var R = await readNow(Object.keys(want).map(Number), G, V);
    trackReadings = R;
    var stamp = now.toISOString();
    active.forEach(function (b) {
      var r = {};
      b.picks.forEach(function (p) { r[p.uid] = R[p.uid] || null; });
      b.pool.forEach(function (u) { r[u] = R[u] || null; });
      b.last = { t: stamp, r: r };
      b.picks.forEach(function (p) { var x = R[p.uid]; if (x && (!b.peak[p.uid] || x[1] > b.peak[p.uid][0])) b.peak[p.uid] = [x[1], today]; });
      // A checkpoint is taken on the first run at least that many days after the pick (half a day
      // of slack, since run times drift). If runs were missed, it's taken late and says so in "t".
      CPS.forEach(function (k) { if (!b.cp[k] && ageOf(b) >= k - 0.5) b.cp[k] = { t: stamp, r: r }; });
      if (b.cp[CPS[CPS.length - 1]]) delete b.last;
    });
    saveJSON(TRACK, tr);
    return tr;
  }

  // One game's numbers in a reading, measured against when it was picked.
  function cell(b, u, snap) {
    var a = b.at0[u], n = snap.r[u];
    if (!a) return null;
    if (!n) return { gone: 1 };
    var days = (new Date(snap.t) - new Date(b.t)) / 864e5;
    return {
      players: n[1],
      ch: a[1] > 0 ? Math.round((n[1] / a[1] - 1) * 100) : null,
      vpd: a[0] != null && days > 0.5 ? Math.round((n[0] - a[0]) / days) : null
    };
  }
  function groupStats(b, ids, snap) {
    var ch = [], vch = [], up = 0, gone = 0, hits = 0;
    var days = (new Date(snap.t) - new Date(b.t)) / 864e5;
    ids.forEach(function (u) {
      var a = b.at0[u], n = snap.r[u];
      if (!a) return;
      if (!n) { gone++; return; }
      if (a[1] > 0) { var c = n[1] / a[1] - 1; ch.push(c); if (c > 0) up++; if (c >= 4) hits++; }
      if (a[0] != null && a[5] > 0 && days > 0.5) vch.push(((n[0] - a[0]) / days) / a[5] - 1);
    });
    return { n: ids.length, measured: ch.length, gone: gone, players: ch, visits: vch, up: up, hits: hits, days: Math.round(days * 10) / 10 };
  }
  function summarize(groups) {
    var ch = [], vch = [], up = 0, n = 0, gone = 0, measured = 0, hits = 0;
    groups.forEach(function (g) { ch = ch.concat(g.players); vch = vch.concat(g.visits); up += g.up; n += g.n; gone += g.gone; measured += g.measured; hits += g.hits; });
    if (!n) return null;
    var pc = function (x) { return x == null ? null : Math.round(x * 1000) / 10; };
    return { n: n, measured: measured, gone: gone, hits: hits, playersMedian: pc(median(ch)), visitsMedian: pc(median(vch)), upShare: measured ? Math.round(up / measured * 100) : null };
  }

  // The public track record. Names appear once a batch is a week old, so it never gives away the
  // current week's board.
  function trackPublic(now, tr) {
    var SHOW_AFTER = 6.5;
    var ageOf = function (b) { return (now - new Date(b.t)) / 864e5; };
    var overall = {};
    CPS.forEach(function (k) {
      var withK = tr.batches.filter(function (b) { return b.cp[k] && ageOf(b) >= SHOW_AFTER; });
      if (!withK.length) return;
      overall[k] = {
        batches: withK.length,
        picks: summarize(withK.map(function (b) { return groupStats(b, b.picks.map(function (p) { return p.uid; }), b.cp[k]); })),
        others: summarize(withK.filter(function (b) { return b.pool.length; }).map(function (b) { return groupStats(b, b.pool, b.cp[k]); }))
      };
    });
    var batches = tr.batches.slice().reverse().map(function (b) {
      var age = ageOf(b), shown = age >= SHOW_AFTER;
      var o = { d: b.d, label: pLabel(new Date(b.d + "T12:00:00Z")), days: Math.floor(age), shown: shown, n: b.picks.length, others: b.pool.length,
        showOn: pLabel(new Date(new Date(b.d + "T12:00:00Z").getTime() + 7 * 864e5)), checkpoints: {} };
      if (!shown) return o;
      CPS.forEach(function (k) {
        if (!b.cp[k]) return;
        o.checkpoints[k] = {
          days: groupStats(b, [], b.cp[k]).days,
          picks: summarize([groupStats(b, b.picks.map(function (p) { return p.uid; }), b.cp[k])]),
          others: b.pool.length ? summarize([groupStats(b, b.pool, b.cp[k])]) : null
        };
      });
      var latest = b.last || b.cp[CPS[CPS.length - 1]];
      if (latest) {
        o.latest = { days: groupStats(b, [], latest).days, picks: summarize([groupStats(b, b.picks.map(function (p) { return p.uid; }), latest)]),
          others: b.pool.length ? summarize([groupStats(b, b.pool, latest)]) : null };
      }
      o.picks = b.picks.map(function (p) {
        var a = b.at0[p.uid] || [];
        var row = { name: p.name, pid: p.pid, rank: p.rank, score: p.score, players: a[1], pace: a[5] || null, peak: b.peak[p.uid] || null, at: {} };
        CPS.forEach(function (k) { if (b.cp[k]) row.at[k] = cell(b, p.uid, b.cp[k]); });
        if (latest) row.now = cell(b, p.uid, latest);
        return row;
      });
      return o;
    });
    return { updated: pLabel(now), checkpoints: CPS, overall: overall, batches: batches };
  }

  // ---------- Weekly report ----------
  // Built on Mondays from that day's board. Issues are kept, so the report page has an archive.
  function buildIssue(now, board, pool, rows, extra, tr, histSnaps) {
    var d = pDate(now);
    var reports = loadJSON(REPORT, []);
    reports = reports.filter(function (x) { return x.d !== d; });
    var prev = tr.batches.filter(function (b) { return b.d < d; }).pop() || null;
    var prevRank = {};
    if (prev) prev.picks.forEach(function (p) { prevRank[p.uid] = p.rank; });
    var inPool = {}, onBoard = {}, byUid = {};
    pool.forEach(function (r) { inPool[r.uid] = r; });
    board.forEach(function (r) { onBoard[r.uid] = 1; });
    rows.forEach(function (r) { byUid[r.uid] = r; });

    // "This week" means against the reading closest to 7 days ago, or at least 2 days ago while
    // the daily record is still young. The issue says how many days it covers.
    var base = null, baseDays = null;
    histSnaps.forEach(function (h) {
      var dd = (now - new Date(h.t)) / 864e5;
      if (dd >= 1.5 && dd <= 8.5 && (baseDays == null || Math.abs(dd - 7) < Math.abs(baseDays - 7))) { base = h; baseDays = dd; }
    });
    var growthOf = function (r) { var a = base && base.g[r.uid]; return a && a[1] >= 100 ? Math.round((r.playing / a[1] - 1) * 100) : null; };
    var top = board.slice(0, 10).map(function (r, i) {
      var e = extra[r.uid] || {};
      return { name: r.name, pid: r.pid, rank: i + 1, was: prev ? (prevRank[r.uid] || 0) : null, score: r.score, players: r.playing, pace: Math.round(r.pace),
        age: Math.round(r.age), genre: r.genre2 || r.genre, shape: r.shape, mult: r.mult, own: r.own, creator: r.creator, ctype: r.ctype, cid: r.cid,
        members: e.members || null, discord: /discord/i.test(r.g.description || "") ? 1 : 0, growth: growthOf(r) };
    });
    var movers = rows.filter(function (r) { return growthOf(r) != null && r.playing >= 500 && r.age <= 120; })
      .sort(function (a, b) { return growthOf(b) - growthOf(a); }).slice(0, 8)
      .map(function (r) { return { name: r.name, pid: r.pid, players: r.playing, growth: growthOf(r), age: Math.round(r.age), onBoard: onBoard[r.uid] ? 1 : 0 }; });
    var newOn = prev ? board.map(function (r, i) { return { name: r.name, pid: r.pid, rank: i + 1, uid: r.uid }; }).filter(function (x) { return !prevRank[x.uid]; })
      .map(function (x) { return { name: x.name, pid: x.pid, rank: x.rank }; }) : [];
    var off = prev ? prev.picks.filter(function (p) { return !onBoard[p.uid]; }).map(function (p) {
      var r = byUid[p.uid], why;
      var seen = prev.last && prev.last.r[p.uid];
      if (!r && prev.last && !seen) why = "Was deleted or made private";
      else if (!r && seen && seen[1] > 15000) why = "Grew past 15,000 players";
      else if (!r && seen && seen[1] < 500) why = "Fell under 500 players";
      else if (!r) why = "Dropped off Roblox's chart lists";
      else if (r.playing > 15000) why = "Grew past 15,000 players";
      else if (r.playing < 500) why = "Fell under 500 players";
      else if (r.age > 120) why = "Turned four months old";
      else if (r.like < 0.85) why = "Rating fell under 85%";
      else if (inPool[p.uid] && (inPool[p.uid].ip || (inPool[p.uid].flags || []).length)) why = "Picked up a red flag: " + (inPool[p.uid].ip ? "name may reference " + inPool[p.uid].ip : inPool[p.uid].flags[0]);
      else why = "Scored below this week's cut";
      return { name: p.name, pid: p.pid, wasRank: p.rank, players: r ? r.playing : seen ? seen[1] : null, why: why };
    }) : [];
    var since = null;
    if (prev && prev.last) {
      var g = groupStats(prev, prev.picks.map(function (p) { return p.uid; }), prev.last);
      since = { d: prev.d, label: pLabel(new Date(prev.d + "T12:00:00Z")), days: g.days, stats: summarize([g]),
        best: prev.picks.map(function (p) { var c = cell(prev, p.uid, prev.last); return { name: p.name, pid: p.pid, rank: p.rank, c: c }; })
          .filter(function (x) { return x.c && !x.c.gone && x.c.ch != null; }).sort(function (a, b) { return b.c.ch - a.c.ch; }).slice(0, 5)
          .map(function (x) { return { name: x.name, pid: x.pid, rank: x.rank, ch: x.c.ch, players: x.c.players }; }) };
    }
    // Issue numbers stay fixed: a re-run on the same Monday keeps that issue's number.
    var old = loadJSON(REPORT, []).filter(function (x) { return x.d === d; })[0];
    var no = old ? old.no : reports.reduce(function (m, x) { return Math.max(m, x.no || 0); }, 0) + 1;
    var issue = { d: d, label: pLabel(now), t: now.toISOString(), no: no, boardSize: board.length, poolSize: pool.length,
      growthDays: baseDays != null ? Math.round(baseDays) : null, top: top, movers: movers, newOn: newOn, off: off, since: since };
    reports.push(issue);
    reports.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    if (reports.length > 52) reports = reports.slice(-52);
    saveJSON(REPORT, reports);
    return issue;
  }

  // ---------- Games index and daily history ----------
  // The index keeps each young game's name, link, genre and creator, so the history can name games
  // on days they weren't on the chart lists. The history file gives every game's daily readings
  // for the game pages, comparisons, watchlists and the market view.
  function updateIndex(now, games) {
    var idx = loadJSON(INDEX, {}), today = pDate(now);
    games.forEach(function (g) {
      if (!g || !g.id) return;
      idx[g.id] = { n: g.name, p: g.rootPlaceId, g: g.genre_l1 || (idx[g.id] && idx[g.id].g) || "", g2: g.genre_l2 || (idx[g.id] && idx[g.id].g2) || "",
        c: (g.creator && g.creator.name) || "", ct: g.creator && g.creator.type, ci: g.creator && g.creator.id, cr: String(g.created || "").slice(0, 10), ls: today };
    });
    var cutoff = new Date(now.getTime() - 130 * 864e5).toISOString().slice(0, 10);
    Object.keys(idx).forEach(function (u) { if (idx[u].ls < cutoff) delete idx[u]; });
    saveJSON(INDEX, idx);
    return idx;
  }

  function historyPublic(now, hist, idx) {
    var snaps = hist.snaps.slice(-60);
    var onBoard = {}, series = {};
    snaps.forEach(function (s, di) {
      (s.b || []).forEach(function (u) { onBoard[u] = 1; });
      Object.keys(s.g).forEach(function (u) { var a = s.g[u]; (series[u] = series[u] || []).push([di, a[1], a[0], a[3], a[4]]); });
    });
    var games = {};
    Object.keys(series).forEach(function (u) {
      var m = idx[u], sr = series[u];
      if (!m) return;
      var peak = 0; sr.forEach(function (x) { if (x[1] > peak) peak = x[1]; });
      if (peak < 300 && !onBoard[u]) return;
      games[u] = [m.n, m.p, m.g, m.g2, m.c, m.ct, m.ci, m.cr, sr];
    });
    return { updated: pLabel(now), dates: snaps.map(function (s) { return s.d; }), times: snaps.map(function (s) { return s.t; }),
      boards: snaps.map(function (s) { return s.b || null; }), games: games };
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
      // Top Trending earns nothing: in the first track-record check (Oct 23 picks, 3 days on),
      // picks on Top Trending fell 30% against 4% for the rest. It marks a game near its peak,
      // and the board is for getting in before that.
      var mom = (r.accel != null ? C((Math.min(r.accel, 6) - 1) / 5, 0, 1) * 12 : 4) + (r.U ? (1 - (r.U - 1) / 100) * 8 : 0) + (r.Gk && r.Gk <= 20 ? 2 : 0) + (r.pgrowth7 != null ? C(r.pgrowth7 - 1, 0, 1) * 6 : 0);
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

    // Remember today's board in today's snapshot, so tomorrow can show rank changes and streaks.
    snap.b = board.map(function (r) { return r.uid; });
    try { saveJSON(KEY, hist); } catch (e) {}

    // Trends from the daily record. Snapshots from before boards were saved have no "b", so rank
    // change and days on the board start out unknown and fill in from the next day on.
    var prevSnap = prior.length ? prior[prior.length - 1] : null;
    var likeOf = function (a) { return a && a[3] + a[4] ? a[3] / (a[3] + a[4]) : null; };
    function change(r, then) {
      var a = then && then.g[r.uid], n = snap.g[r.uid];
      if (!a || !n) return null;
      var la = likeOf(a), ln = likeOf(n);
      return {
        days: r1(daysAgo(then)),
        players: a[1] > 0 ? Math.round((n[1] / a[1] - 1) * 100) : null,
        favorites: a[2] > 0 ? r1((n[2] / a[2] - 1) * 100) : null,
        rating: la != null && ln != null ? r1((ln - la) * 100) : null,
        visits: n[0] - a[0]
      };
    }
    function trendOf(r) {
      var t = {};
      if (prevSnap && prevSnap.b) {
        var at = prevSnap.b.indexOf(r.uid);
        t.prevRank = at >= 0 ? at + 1 : 0;
        var days = 1, complete = true;
        for (var i = prior.length - 1; i >= 0; i--) {
          if (!prior[i].b) { complete = false; break; }
          if (prior[i].b.indexOf(r.uid) < 0) break;
          days++;
        }
        t.daysOn = days;
        t.daysOnAtLeast = !complete;
      }
      var seen = hist.snaps.filter(function (s) { return s.g[r.uid]; });
      t.series = seen.slice(-14).map(function (s) { return [s.d, s.g[r.uid][1]]; });
      t.peak = Math.max.apply(null, seen.map(function (s) { return s.g[r.uid][1]; }));
      t.peakDate = (seen.filter(function (s) { return s.g[r.uid][1] === t.peak; }).pop() || {}).d || null;
      t.tracked = seen.length;
      t.d1 = change(r, p1);
      t.d7 = change(r, p7);
      return t;
    }

    var DEEP = await deep(board);
    var BOARD = board.map(function (r, i) {
      var e = extra[r.uid] || {};
      return [r.pid, r.name, r.creator, r.own, r.genre, r.genre2, Math.round(r.age), r.playing, Math.round(r.pace), r.fresh, r.accel != null ? r1(r.accel) : null, r1(r.sess), r1(r.like * 100), r1(r.favk), r1(r.vk), Math.round(r.hrs), r.U, r.T, r.E, r.R, r.Gk, r.shape, r.wave ? 1 : 0, r.comp.join("/"), r.score, r.mult,
        { passes: e.passes, pmin: e.pmin, pmax: e.pmax, members: e.members, discord: /discord/i.test(r.g.description || "") ? 1 : 0, cid: r.cid, ctype: r.ctype, pgrowth7: r.pgrowth7 != null ? r1(r.pgrowth7) : null, decay: r.decay != null ? r1(r.decay * 100) : null,
          rank: i + 1, uid: r.uid, trend: trendOf(r), deep: DEEP.byUid[r.uid] || null }];
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

    // Track record and weekly report. If Roblox refuses these extra reads, the board still goes out
    // and the record carries on from its last saved state the next day.
    var trackError = null, tr = null;
    try { tr = await updateTrack(now, opts, board, pool, G, V, hist.snaps); }
    catch (e) { trackError = String(e && e.message || e); tr = loadJSON(TRACK, { v: 1, batches: [] }); }
    // Tracked games that have left the chart lists keep a daily reading in the history.
    var carried = 0;
    Object.keys(trackReadings).forEach(function (u) { if (!snap.g[u] && trackReadings[u]) { snap.g[u] = trackReadings[u]; carried++; } });
    if (carried) { try { saveJSON(KEY, hist); } catch (e) {} }
    var idx = updateIndex(now, young.concat(Object.keys(fetchedGames).map(function (u) { return fetchedGames[u]; })));
    var HX = historyPublic(now, hist, idx);
    var historyJs = "/* Spawnbook daily history, built " + now.toISOString() + ". The game, watchlist and market pages read window.HX. */\nwindow.HX = " + JSON.stringify(HX) + ";\n";

    var issue = null;
    if (opts.weekly) { try { issue = buildIssue(now, board, pool, rows, extra, tr, hist.snaps); } catch (e) { trackError = (trackError ? trackError + "; " : "") + "report: " + String(e && e.message || e); } }
    var TR = trackPublic(now, tr);
    var reportsAll = loadJSON(REPORT, []);
    var trackJs = "/* Spawnbook track record, built " + now.toISOString() + ". Public. The page reads window.TR. */\nwindow.TR = " + JSON.stringify(TR) + ";\n";
    var reportJs = "/* Spawnbook weekly reports, built " + now.toISOString() + ". The page reads window.RP. */\nwindow.RP = " + JSON.stringify({ issues: reportsAll.slice().reverse().slice(0, 26) }) + ";\n";

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
      issues: pickDates.length,
      ranksKnown: !!(prevSnap && prevSnap.b),
      prevDate: prevSnap ? prevSnap.d : null,
      deepSkipped: DEEP.skipped
    };
    var BR = { META: META, BOARD: BOARD, BIG: BIG, BIG_NOTES: BIG_NOTES, IP_OFF: IP_OFF, FLAG_OFF: FLAG_OFF };
    var dataJs = "/* Spawnbook data, built " + now.toISOString() + ". The page reads window.BR. */\nwindow.BR = " + JSON.stringify(BR, null, 1) + ";\n";
    var picksCsv = opts.weekly ? board.map(function (r, i) { return [pDate(now), i + 1, '"' + r.name.replace(/"/g, '""') + '"', r.pid, r.score, r.playing, Math.round(r.pace)].join(","); }).join("\n") : "";
    window.__BR_LAST = { dataJs: dataJs, trackJs: trackJs, reportJs: reportJs, historyJs: historyJs, picksCsv: picksCsv, board: board.map(function (r) { return [r.name, r.score]; }), ids: rows.map(function (r) { return [r.pid, r.uid, r.cid, r.ctype, r.playing]; }), descs: rows.reduce(function (o, r) { o[r.pid] = r.g.description || ""; return o; }, {}) };
    return {
      ok: true, at: now.toISOString(), lists: data.lists, gamesSeen: data.uids.length, youngTracked: young.length, pool: pool.length,
      board: board.length, top5: board.slice(0, 5).map(function (r) { return r.name + " (" + r.score + ")"; }),
      historyDays: hist.snaps.length, firstDay: first.d, visitsBasis: p7 ? "7-day" : p1 ? "1-day" : "lifetime",
      picksLogged: picks.length, dataJsLength: dataJs.length, deepSkipped: DEEP.skipped,
      trackBatches: tr.batches.length, trackShown: TR.batches.filter(function (b) { return b.shown; }).length,
      reportIssues: reportsAll.length, newIssue: issue ? issue.no : null, trackError: trackError,
      historyGames: Object.keys(HX.games).length, historyJsLength: historyJs.length, carriedReadings: carried
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
  return { run: run, enrich: enrich, exportHistory: exportHistory, importHistory: importHistory, compactToday: compactToday,
    _test: { trackPublic: trackPublic } };
})();
"BRC ready";

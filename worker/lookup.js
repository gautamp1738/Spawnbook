// Game lookup: paste a Roblox link, a place ID or a game's name and get its public numbers with a
// plain-English read of what looks good and what to check first. Everything comes from Roblox's
// public APIs plus Spawnbook's own daily record (history.js) and today's board (data.js). Prices
// use the same math as the board, so they're estimates with low confidence.
//
// GET /api/lookup?q=<link, place ID or name>   or   /api/lookup?u=<universe ID>
// The caller (worker/index.js) checks access first.

const DAY = 864e5;
const PER_VISIT = [0.004, 0.008, 0.012];
const MULT = { rocket: [1, 1.5, 2], staircase: [3, 4.5, 6] };
const DEVEX = 0.0038;

// Kept in step with pipeline/collector.js.
const STAIR = ["RPG", "Shooter", "Action", "Sports & Racing", "Strategy", "Roleplay & Avatar Sim", "Adventure", "Puzzle", "Party & Casual", "Survival", "Obby & Platformer"];
const WAVE = /steal|grow a|\+1|egg|brainrot|hatcher|rng|anomaly|lucky block|evolution|roll a/i;
const AFK = /afk|donate|pls |ugc/i;
const IP = [[/free fire/i, "Free Fire"], [/blue lock/i, "Blue Lock"], [/deltarune|undertale/i, "DELTARUNE or Undertale"], [/hulk|ultron|marvel|spider-?man|avengers/i, "Marvel characters"], [/\bipad\b|\biphone\b|\bapple\b/i, "Apple"], [/chiikawa/i, "Chiikawa"], [/adventure time/i, "Adventure Time"], [/fnaf|freddy/i, "Five Nights at Freddy's"], [/oregon trail/i, "The Oregon Trail"], [/mothra|godzilla|kaiju/i, "Toho's kaiju"], [/krusty|spongebob/i, "SpongeBob"], [/morioh|jojo/i, "JoJo's Bizarre Adventure"], [/kukirin/i, "Kukirin, a scooter brand"], [/mafuba|dragon ball/i, "Dragon Ball"], [/naruto/i, "Naruto"], [/one piece/i, "One Piece"], [/pok[eé]mon/i, "Pokémon"], [/minecraft/i, "Minecraft"], [/disney|pixar/i, "Disney"], [/skibidi|cameraman/i, "Skibidi Toilet"], [/\bsonic\b/i, "Sonic"], [/\bmario\b/i, "Mario"]];
// From the trends study (public/trends.html).
const ANIMAL = /\b(eggs?|pets?|animals?|dinos?|dinosaurs?|dogs?|puppy|puppies|cats?|kittens?|kitty|bunny|bunnies|horses?|pony|ponies|birds?|ducks?|frogs?|mosquito(es)?|bees?|shark|sharks|monkeys?|cows?|pigs?|chickens?|zoo|farm animals?|capybaras?|hamsters?)\b/i;
const QUIET_GENRES = ["Puzzle", "Party & Casual", "Obby & Platformer", "Shooter"];

const ROBLOX = { Accept: "application/json" };
const timeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});

async function getJSON(url, init) {
  try {
    const r = await fetch(url, Object.assign({ headers: ROBLOX }, timeout(8000), init || {}));
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function out(data, status, cache) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache || "no-store" } });
}

// ---------- formatting for the plain-English points ----------
const commas = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
function trim(v) { const s = v >= 100 ? v.toFixed(0) : v.toFixed(1); return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
function short(n) {
  n = Number(n) || 0;
  if (n >= 999.5e6) return trim(n / 1e9) + "B";
  if (n >= 999.5e3) return trim(n / 1e6) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "K";
  if (n >= 1e3) return trim(n / 1e3) + "K";
  return String(Math.round(n));
}
function money(x) {
  if (!isFinite(x) || x <= 0) return "$0";
  if (x >= 999.5e6) return "$" + trim(x / 1e9) + "B";
  if (x >= 999.5e3) return "$" + trim(x / 1e6) + "M";
  if (x >= 1e3) return "$" + Math.round(x / 1e3) + "K";
  return "$" + Math.round(x);
}
const pct = (x) => Math.round(x * 100) + "%";
const pct1 = (x) => trim(x * 100) + "%";
function ago(hours) {
  if (hours < 1) return "less than an hour ago";
  if (hours < 36) return Math.round(hours) + (Math.round(hours) === 1 ? " hour ago" : " hours ago");
  const d = Math.round(hours / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}
const days = (n) => n + (n === 1 ? " day" : " days");
const median = (xs) => {
  const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Names compared without case, brackets, emoji or punctuation: "[🎃] Urban Reload" -> "urban reload".
const norm = (s) => String(s || "").toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------- Spawnbook's own data ----------
// history.js and data.js are rebuilt once a day, so the parsed copies are kept for 10 minutes.
let cached = { at: 0, hx: null, br: null };
async function ourData(env, origin) {
  if (Date.now() - cached.at < 10 * 60e3 && cached.hx) return cached;
  const read = async (path, marker) => {
    try {
      const r = await env.ASSETS.fetch(new Request(new URL(path, origin)));
      if (!r.ok) return null;
      const t = await r.text();
      const at = t.indexOf(marker);
      if (at < 0) return null;
      return JSON.parse(t.slice(at + marker.length).trim().replace(/;\s*$/, ""));
    } catch (e) {
      return null;
    }
  };
  const [hx, br] = await Promise.all([read("/history.js", "window.HX ="), read("/data.js", "window.BR =")]);
  cached = { at: Date.now(), hx, br };
  return cached;
}

// ---------- finding the game ----------
function parseQuery(q) {
  const t = String(q || "").trim().slice(0, 200);
  if (!t) return null;
  if (/roblox\.com\/share|ro\.blox\.com/i.test(t)) return { kind: "share" };
  const m = /roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{3,19})/i.exec(t) || /[?&]placeId=(\d{3,19})/i.exec(t);
  if (m) return { kind: "link", pid: Number(m[1]) };
  if (/^\d{3,19}$/.test(t)) return { kind: "id", id: Number(t) };
  if (/^https?:\/\//i.test(t)) return { kind: "badlink" };
  return { kind: "name", name: t };
}

async function placeToUniverse(pid) {
  const j = await getJSON("https://apis.roblox.com/universes/v1/places/" + pid + "/universe");
  return Number(j && j.universeId) || 0;
}

// Roblox's own search, the same one its home page uses. Falls back to the names in our record.
async function searchByName(name, hx) {
  const want = norm(name);
  const sid = crypto.randomUUID();
  const j = await getJSON("https://apis.roblox.com/search-api/omni-search?searchQuery=" + encodeURIComponent(name) + "&sessionId=" + sid + "&pageType=all");
  const found = [];
  for (const grp of (j && j.searchResults) || []) {
    if (grp.contentGroupType !== "Game") continue;
    for (const c of grp.contents || []) {
      if (c.universeId && !found.some((f) => f.uid === c.universeId)) found.push({ uid: Number(c.universeId), name: String(c.name || ""), players: c.playerCount || 0, creator: c.creatorName || "" });
    }
  }
  const ours = [];
  if (want && hx && hx.games) {
    const last = hx.dates.length - 1;
    for (const u of Object.keys(hx.games)) {
      const g = hx.games[u], n = norm(g[0]);
      if (want && n.includes(want)) {
        const r = g[8][g[8].length - 1];
        ours.push({ uid: Number(u), name: g[0], players: r && r[0] === last ? r[1] : 0, creator: g[4] || "", exact: n === want });
      }
    }
    ours.sort((a, b) => b.exact - a.exact || b.players - a.players);
  }
  // Roblox's search always answers with something, even for gibberish. Only go straight to a game
  // when its name actually contains what was typed; otherwise let the visitor choose.
  const close = (x) => closeEnough(want, norm(x.name));
  const pick = found.find((f) => norm(f.name) === want) || ours.find((o) => o.exact) || found.find(close) || ours.find(close) || null;
  const list = (pick ? [pick] : []).concat(found, ours).filter((x, i, all) => all.findIndex((y) => y.uid === x.uid) === i)
    .map((x) => ({ uid: x.uid, name: x.name, players: x.players, creator: x.creator }));
  return { uid: pick ? pick.uid : 0, others: pick ? list.slice(1, 7) : list.slice(0, 8) };
}

// "pinkie" matches "pinkie promise horror"; "martial world" matches "martial arts world". Every word
// typed has to start a word in the name.
function closeEnough(want, name) {
  if (!want || !name) return false;
  if (name.includes(want)) return true;
  const words = name.split(" ");
  return want.split(" ").every((w) => words.some((n) => n.startsWith(w)));
}

// ---------- reading Roblox ----------
async function icon(uid) {
  const j = await getJSON("https://thumbnails.roblox.com/v1/games/icons?universeIds=" + uid + "&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false");
  const d = j && j.data && j.data[0];
  if (!d || d.state !== "Completed" || !d.imageUrl) return null;
  let u;
  try { u = new URL(d.imageUrl); } catch (e) { return null; }
  if (u.protocol !== "https:" || !/\.rbxcdn\.com$/i.test(u.hostname)) return null;
  try {
    const r = await fetch(u.href, timeout(6000));
    if (!r.ok) return null;
    const type = (r.headers.get("Content-Type") || "image/png").split(";")[0];
    if (!/^image\/(png|jpeg|webp)$/.test(type)) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 150000) return null;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return "data:" + type + ";base64," + btoa(bin);
  } catch (e) {
    return null;
  }
}

async function passes(uid) {
  const j = await getJSON("https://apis.roblox.com/game-passes/v1/universes/" + uid + "/game-passes?passView=Full&pageSize=100");
  if (!j) return null;
  const prices = (j.gamePasses || []).filter((p) => p.isForSale && p.price).map((p) => p.price);
  return { n: prices.length, more: !!j.nextPageToken, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, median: median(prices) };
}

async function products(uid) {
  let prices = [], cur = "", pages = 0, got = false;
  do {
    const j = await getJSON("https://apis.roblox.com/developer-products/v2/universes/" + uid + "/developerproducts?limit=100" + (cur ? "&cursor=" + encodeURIComponent(cur) : ""));
    if (!j) break;
    got = true; pages++;
    prices = prices.concat((j.developerProducts || []).filter((p) => p.IsForSale && p.PriceInRobux).map((p) => p.PriceInRobux));
    cur = j.nextPageCursor || "";
  } while (cur && pages < 3);
  if (!got) return null;
  return { n: prices.length, more: !!cur, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, median: median(prices) };
}

async function maturity(uid) {
  const j = await getJSON("https://apis.roblox.com/experience-guidelines-api/experience-guidelines/get-age-recommendation", {
    method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, ROBLOX), body: JSON.stringify({ universeId: uid }),
  });
  const rec = j && j.ageRecommendationDetails && j.ageRecommendationDetails.summary && j.ageRecommendationDetails.summary.ageRecommendation;
  if (!rec) return null;
  const unrated = rec.contentMaturity === "unrated";
  return { name: unrated ? "Unrated" : String(rec.displayName || "").replace(/^Maturity:\s*/i, "") || null, minAge: unrated ? 0 : rec.minimumAge || 0 };
}

async function creatorInfo(c, pid, uid) {
  const out = { type: c.type, id: c.id, name: c.name, verified: !!c.hasVerifiedBadge };
  const jobs = [];
  if (c.type === "Group") {
    jobs.push(getJSON("https://groups.roblox.com/v1/groups/" + c.id).then((g) => {
      if (!g) return;
      out.members = g.memberCount || 0;
      out.verified = out.verified || !!g.hasVerifiedBadge;
      if (g.owner) out.owner = { id: g.owner.userId, name: g.owner.username };
    }));
  } else if (c.type === "User") {
    jobs.push(getJSON("https://users.roblox.com/v1/users/" + c.id).then((u) => {
      if (u) out.joined = u.created || null;
    }));
  }
  jobs.push(getJSON("https://games.roblox.com/v2/" + (c.type === "Group" ? "groups" : "users") + "/" + c.id + "/games?accessFilter=Public&limit=50&sortOrder=Desc").then((pf) => {
    if (!pf || !pf.data) return;
    const others = pf.data.filter((x) => x.id !== uid && !(x.rootPlace && x.rootPlace.id === pid));
    const top = others.slice().sort((a, b) => (b.placeVisits || 0) - (a.placeVisits || 0))[0];
    out.games = pf.data.length;
    out.moreGames = !!pf.nextPageCursor;
    out.topOther = top ? { name: top.name, visits: top.placeVisits || 0, pid: top.rootPlace ? top.rootPlace.id : null } : null;
  }));
  await Promise.all(jobs);
  return out;
}

async function servers(pid, playing) {
  const j = await getJSON("https://games.roblox.com/v1/games/" + pid + "/servers/Public?limit=100&sortOrder=Desc");
  if (!j || !j.data) return null;
  const list = j.data;
  if (!list.length) return { counted: 0, avg: null, complete: true, atLeast: 0 };
  const avg = list.reduce((a, s) => a + (s.playing || 0), 0) / list.length;
  const more = !!j.nextPageCursor;
  return { counted: list.length, avg: Math.round(avg * 10) / 10, complete: !more, atLeast: more && avg > 0 ? Math.max(list.length, Math.round(playing / avg)) : list.length };
}

// ---------- the read ----------
function ipOf(name) { for (const [re, what] of IP) if (re.test(name)) return what; return null; }

// The reading in our record closest to `target` days before `t`, at least `min` days before it.
function readingBefore(rows, t, min, target) {
  let best = null;
  for (const r of rows) {
    const d = (t - r.t) / DAY;
    if (d >= min && (!best || Math.abs(d - target) < Math.abs((t - best.t) / DAY - target))) best = r;
  }
  return best;
}

function analyse(ctx) {
  const { g, v, hx, br, pass, prod, mat, cr, srv } = ctx;
  const now = Date.now();
  const uid = g.id, pid = g.rootPlaceId;
  const age = Math.max(0, (now - Date.parse(g.created)) / DAY);
  const ageD = Math.floor(age);
  const hrs = Math.max(0, (now - Date.parse(g.updated)) / 36e5);
  const up = (v && v.upVotes) || 0, down = (v && v.downVotes) || 0, votes = up + down;
  const like = votes ? up / votes : null;
  const life = g.visits / Math.max(age, 0.5);

  // Our daily record for this game, oldest first, with the reading's exact time.
  const rec = hx && hx.games && hx.games[uid];
  const rows = rec ? rec[8].map((r) => ({ t: Date.parse(hx.times[r[0]]), d: hx.dates[r[0]], players: r[1], visits: r[2], up: r[3], down: r[4] })) : [];
  const nowRow = { t: now, players: g.playing, visits: g.visits };
  const p7 = readingBefore(rows, now, 5, 7), p1 = readingBefore(rows, now, 0.75, 1);
  let pace = null, basis = "lifetime", basisDays = null;
  if (p7 && g.visits > p7.visits) { pace = (g.visits - p7.visits) / ((now - p7.t) / DAY); basis = "week"; basisDays = Math.round((now - p7.t) / DAY); }
  else if (p1 && g.visits > p1.visits) { pace = (g.visits - p1.visits) / ((now - p1.t) / DAY); basis = "day"; basisDays = Math.round((now - p1.t) / DAY * 10) / 10; }
  const perDay = pace || life;
  const accel = pace ? pace / life : null;
  // Players compared across our daily readings, which are all taken at about the same time of day.
  const lastRow = rows[rows.length - 1];
  const wk = lastRow ? readingBefore(rows, lastRow.t, 5, 7) : null;
  const playersWeek = wk && wk.players > 0 ? { change: lastRow.players / wk.players - 1, days: Math.round((lastRow.t - wk.t) / DAY), from: wk.players, to: lastRow.players } : null;
  const peak = rows.length ? rows.reduce((a, r) => (r.players > a.players ? r : a), rows[0]) : null;
  const sess = perDay > 0 ? g.playing * 1440 / perDay : null;
  const favk = g.favoritedCount / Math.max(g.visits, 1) * 1000;
  const vk = votes / Math.max(g.visits, 1) * 1000;

  // Today's board.
  const BOARD = (br && br.BOARD) || [];
  const row = BOARD.find((r) => r[26] && r[26].uid === uid) || BOARD.find((r) => r[0] === pid);
  const bmed = { favk: median(BOARD.map((r) => r[13])), vk: median(BOARD.map((r) => r[14])), sess: median(BOARD.map((r) => r[11])), like: median(BOARD.map((r) => r[12])) };
  let streak = 0;
  if (hx && hx.boards) for (let i = hx.boards.length - 1; i >= 0; i--) { if (hx.boards[i] && hx.boards[i].includes(uid)) streak++; else break; }
  const flaggedOff = br && ((br.FLAG_OFF || []).find((r) => r[0] === pid) || (br.IP_OFF || []).find((r) => r[0] === pid));

  const ip = ipOf(g.name);
  const licensed = g.isOfficiallyLicensed ? "official" : g.isCommunityLicensed ? "community" : null;
  const wave = WAVE.test(g.name);
  const shape = (STAIR.includes(g.genre_l1) && !wave) || /fish/i.test(g.name) ? "staircase" : "rocket";
  const mult = MULT[shape];
  const rev = PER_VISIT.map((k) => perDay * 30 * k);
  const fair = [rev[0] * mult[0], rev[1] * mult[1], rev[2] * mult[2]];

  const good = [], check = [], know = [];
  const add = (list, w, title, text) => list.push({ w, title, text });

  // Red flags first: these decide the verdict on their own.
  const hard = [];
  if (ip && !licensed) { hard.push("name"); add(check, 100, "The name may use someone else's brand", "It looks like it references " + ip + ". Lawyers call unlicensed characters or brands a major red flag in a game sale. Check whether it's licensed before going further."); }
  if (ip && licensed) add(know, 40, "Uses a licensed brand", "The name references " + ip + ", and Roblox lists the game as " + (licensed === "official" ? "officially" : "community") + " licensed. Ask what the license allows if the game changes hands.");
  if (AFK.test(g.name)) { hard.push("afk"); add(check, 90, "The name suggests AFK or free-item rewards", "Games that pay players to idle or hand out free items can inflate players and play time. Check how much of its traffic is real play."); }
  if (sess != null && sess > 45) { hard.push("sess"); add(check, 85, "Unusually long visits", "About " + Math.round(sess) + " minutes per visit, which is high for almost any genre. Bots or AFK farms can do this, so the board flags anything over 45 minutes."); }
  if (favk > 60) { hard.push("favk"); add(check, 80, "Unusually many favorites", commas(favk) + " favorites per 1,000 visits is far above normal. Prompts that reward favoriting, or bots, can push it up."); }
  // Votes only come once per player, so long-running giants have few per visit. Young games only.
  if (age <= 183 && g.visits > 5000 && vk < 0.5) { hard.push("vk"); add(check, 80, "Very few votes for its traffic", "Only " + trim(vk) + " votes per 1,000 visits. Real players vote; very low counts can mean bot or AFK traffic."); }

  // Age.
  if (age <= 60) add(good, 70, "Inside the breakout window", "Launched " + days(ageD) + " ago. Of the young games in Roblox's top 100 that we studied, 74% were under 60 days old, and the typical one was 37 days old.");
  else if (age <= 120) add(know, 50, ageD + " days old", "Past the first two months, when most breakouts happen, but young enough for our board, which takes games up to 120 days old.");
  else if (age <= 183) add(check, 55, "Older than most breakouts", "Launched " + days(ageD) + " ago. Only 4 of the 42 young hits we studied were older than four months, so price it on what it earns now rather than on growth.");
  else add(check, 50, "Over six months old", "Launched " + days(ageD) + " ago. Spawnbook looks for games under six months old; for an older game, price it on steady earnings.");

  // Growth.
  if (pace && accel != null) {
    const w = basis === "week" ? "over the past " + days(basisDays) : "since our last reading";
    if (accel >= 1.5) add(good, 75, "Speeding up", "About " + short(pace) + " visits a day " + w + ", " + trim(accel) + "× its lifetime average of " + short(life) + ". It's getting more traffic now than it ever has.");
    else if (accel >= 0.8) add(know, 45, "Holding steady", "About " + short(pace) + " visits a day " + w + ", close to its lifetime average of " + short(life) + ".");
    else add(check, 70, "Slowing down", "About " + short(pace) + " visits a day " + w + ", against a lifetime average of " + short(life) + ". It's past its busiest stretch so far.");
  } else if (!rows.length) {
    add(know, 30, "Not in our daily record yet", "We only keep daily readings for young games on Roblox's chart lists, so we can't show a trend for this one. Visits a day here is its lifetime average.");
  }
  if (playersWeek) {
    const c = playersWeek.change;
    if (c >= 0.2) add(good, 72, "Players are climbing", "At our daily readings it went from " + commas(playersWeek.from) + " to " + commas(playersWeek.to) + " players over " + days(playersWeek.days) + ", up " + pct(c) + ".");
    else if (c <= -0.2) add(check, 68, "Players are falling", "At our daily readings it went from " + commas(playersWeek.from) + " to " + commas(playersWeek.to) + " players over " + days(playersWeek.days) + ", down " + pct(-c) + ".");
    else add(know, 35, "Players are flat", "At our daily readings it went from " + commas(playersWeek.from) + " to " + commas(playersWeek.to) + " players over " + days(playersWeek.days) + ".");
  }

  // Size.
  if (g.playing < 500) add(know, 30, "Small for now", commas(g.playing) + " players right now. Splitting Point bought into Grow a Garden at about 500 to 1,000 players, so small isn't a dealbreaker, but there's less to verify.");
  else if (g.playing > 15000) add(know, 40, "Already big", commas(g.playing) + " players right now. A game this size is on other buyers' radar too, and it's likely priced to match.");

  // Rating.
  if (like != null && votes >= 50) {
    if (like >= 0.9) add(good, 50, "Players like it", "Rated " + pct1(like) + " from " + commas(votes) + " votes. Good, though rating alone doesn't separate hits: in our study hits averaged 92% and games that stayed small 91%.");
    else if (like >= 0.85) add(know, 40, "Rating is on the low side", "Rated " + pct1(like) + " from " + commas(votes) + " votes. That clears the 85% bar for our board, but only just.");
    else add(check, like < 0.8 ? 75 : 60, "Low rating", "Rated " + pct1(like) + " from " + commas(votes) + " votes, under the 85% we need for our board. Play it to see why: bugs, a pay-to-win feel or a misleading thumbnail are common reasons.");
  } else add(know, 20, "Too few votes to judge", "Only " + commas(votes) + " votes so far, too few for the rating to mean much.");

  // Time per visit.
  if (sess != null && sess <= 45) {
    const rough = pace ? "" : " This is rough, since it uses lifetime visits.";
    if (sess >= 14.5) add(good, 60, "People stay a while", "About " + Math.round(sess) + " minutes per visit, in the top quarter of games by GameAnalytics' benchmarks (the top quarter starts at 14.5 minutes)." + rough);
    else if (sess >= 6.6) add(know, 35, "Average time per visit", "About " + trim(sess) + " minutes per visit, above GameAnalytics' 6.6-minute median but short of the top quarter (14.5)." + rough);
    else add(check, 50, "Short visits", "About " + trim(sess) + " minutes per visit, under GameAnalytics' 6.6-minute median, so players tend to leave quickly." + rough);
  }

  // Favorites against today's board.
  if (favk <= 60 && bmed.favk) {
    if (favk >= bmed.favk * 1.25) add(good, 45, "Lots of favorites", trim(favk) + " favorites per 1,000 visits, against " + trim(bmed.favk) + " for the typical game on today's board. People want to come back.");
    else if (favk < bmed.favk * 0.6) add(know, 30, "Fewer favorites than most", trim(favk) + " favorites per 1,000 visits, against " + trim(bmed.favk) + " for the typical game on today's board.");
  }

  // Updates.
  if (hrs <= 72) add(good, 55, "Updated " + ago(hrs), "Every new hit we studied had been updated in the past week, and the typical one in the last 9 hours.");
  else if (hrs <= 7 * 24) add(good, 40, "Updated " + ago(hrs), "Inside the weekly rhythm every new hit we studied kept.");
  else if (hrs <= 30 * 24) add(check, 50, "Last updated " + ago(hrs), "Every new hit we studied had been updated in the past week. Ask the owner what's coming next.");
  else add(check, 55, "No update in " + Math.round(hrs / 24) + " days", "Games that stop updating usually lose players. It can also mean the owner has moved on, which can make them more open to selling.");

  // Genre and theme.
  if (QUIET_GENRES.includes(g.genre_l1)) add(check, 45, g.genre_l1 + " games rarely break out", "Puzzle, party, obby and shooter games were 31% of the young games that stayed small in our study, and none of the 42 recent hits.");
  if (/tycoon/i.test(g.genre_l2 || "") || /tycoon/i.test(g.name)) add(good, 40, "Tycoons do well", "Tycoons were 29% of recent hits in our study, against 10% of young games that stayed small.");
  if (ANIMAL.test(g.name)) add(good, 40, "Animal, egg or pet theme", "36% of recent hits have one, against 10% of young games that stayed small. Steal An Egg made it the theme of the moment.");
  if (wave) add(know, 45, "Follows a current trend", "Its name follows a trend (steal, grow, brainrot, RNG and the like). Trend games can rise fast and fade fast, so we price them on 1 to 2 months of earnings instead of 3 to 6.");

  // Servers.
  if (g.maxPlayers) {
    if (g.maxPlayers <= 12) add(know, 20, "Small servers", "Up to " + g.maxPlayers + " players per server. Recent hits run small servers too: a median of 12, against 20 for older top games.");
    else if (g.maxPlayers > 30) add(know, 20, "Big servers", "Up to " + g.maxPlayers + " players per server. Recent hits usually run smaller ones (a median of 12).");
  }

  // Money.
  if (pass && prod) {
    const heavy = prod.n > 83 || (prod.max || 0) >= 10000;
    if (!pass.n && !prod.n) add(know, 40, "Sells nothing yet", "No game passes or developer products for sale. A buyer could add them, but there are no earnings to check against.");
    else if (heavy) add(know, 35, "Already well monetized", commas(prod.n) + (prod.more ? "+" : "") + " developer products, the priciest at " + commas(prod.max) + " Robux, and " + pass.n + " game passes. Less room to grow earnings by adding purchases.");
    else add(good, 40, "Room to earn more", pass.n + " game passes and " + prod.n + " developer products. That's light, like recent hits, which launch with a median of 4 passes and 39 products and add bigger purchases later.");
  }

  // Ownership.
  if (cr.type === "Group") {
    if (cr.members > 1e6) add(check, 55, "Owned by a big studio", "The group has " + short(cr.members) + " members. Big studios rarely sell young games cheaply, if at all.");
    else if (cr.verified) add(know, 40, "A verified studio owns it", "The group has Roblox's verified badge, so it's an established team. They may price higher or not want to sell.");
    if (cr.games === 1) add(good, 50, "The only game in its group", "69% of recent hits are set up this way. It makes a sale simple: the group changes hands and the game goes with it.");
    else if (cr.games > 1) add(know, 35, "The group runs other games", "It has " + (cr.moreGames ? "50+" : cr.games) + " public games" + (cr.topOther && cr.topOther.visits > 1e6 ? ", the biggest being " + cr.topOther.name + " with " + short(cr.topOther.visits) + " visits" : "") + ". Buying only this one means moving it out of their group, so ask how they'd hand it over.");
  } else if (cr.type === "User") {
    add(know, 40, "Owned by one person's account", "Every one of the 42 recent hits we studied is owned by a group. A personal account means one person to talk to, but agree how the game moves to you before you pay.");
  }

  // Our board.
  if (row) {
    const x = row[26] || {};
    add(good, 80, "On today's Spawnbook board", "Ranked #" + (x.rank || "?") + " with a score of " + row[24] + " out of 100" + (streak > 1 ? ", " + streak + " days running" : "") + ".");
  } else if (flaggedOff) {
    add(check, 65, "Made our cut, then got flagged", flaggedOff[4] + ".");
  } else {
    const why = [];
    if (age > 120) why.push("it's older than 120 days");
    if (g.playing < 500) why.push("it has fewer than 500 players");
    if (g.playing > 15000) why.push("it has more than 15,000 players");
    if (like != null && like < 0.85) why.push("its rating is under 85%");
    const seenToday = lastRow && hx && lastRow.d === hx.dates[hx.dates.length - 1];
    add(know, 15, "Not on today's board", why.length ? "It's outside our board's filters: " + why.join(", ") + "." : seenToday ? "It was in today's reading but didn't score 55 or more." : "It wasn't on Roblox's chart lists when we read them today.");
  }
  if (mat && mat.minAge >= 17) add(know, 25, "Rated for 17 and over", "Roblox recommends it for players 17 and older, which limits who can find it.");

  for (const l of [good, check, know]) l.sort((a, b) => b.w - a.w);

  // The verdict: plain rules, so it can be explained.
  const score = good.reduce((a, p) => a + p.w, 0) - check.reduce((a, p) => a + p.w, 0);
  let call, line;
  const top = (l) => l[0] && l[0].title.charAt(0).toLowerCase() + l[0].title.slice(1);
  if (hard.length) {
    call = "Check first";
    line = "Before anything else: " + top(check) + ". " + (good.length ? "On the plus side: " + top(good) + "." : "");
  } else if (age > 183) {
    call = "Not what we look for";
    line = "It's past six months, so price it on steady earnings, not growth." + (good.length ? " On the plus side: " + top(good) + "." : "");
  } else if (score >= 120 && good.length >= 3) {
    call = "Worth a closer look";
    line = "The best signs: " + good.slice(0, 2).map((p) => p.title.charAt(0).toLowerCase() + p.title.slice(1)).join(" and ") + "." + (check.length ? " Ask about this first: " + top(check) + "." : "");
  } else if (score <= -60) {
    call = "Probably a pass";
    line = "More against it than for it. Biggest worry: " + top(check) + "." + (good.length ? " On the plus side: " + top(good) + "." : "");
  } else {
    call = "Mixed";
    line = (good.length ? "In its favor: " + top(good) + ". " : "") + (check.length ? "Against it: " + top(check) + "." : "Nothing stands out either way.");
  }

  return {
    game: {
      uid, pid, name: g.name, url: "https://www.roblox.com/games/" + pid, created: g.created, updated: g.updated, age: ageD, hoursSinceUpdate: Math.round(hrs),
      genre: g.genre_l1 || null, genre2: g.genre_l2 || null, maxPlayers: g.maxPlayers || null, paid: g.price || null, licensed,
      players: g.playing, visits: g.visits, favorites: g.favoritedCount, up, down, rating: like != null ? Math.round(like * 1000) / 10 : null,
    },
    numbers: {
      perDay: Math.round(perDay), basis, basisDays, lifetimePerDay: Math.round(life), accel: accel != null ? Math.round(accel * 10) / 10 : null,
      playersWeek: playersWeek ? { change: Math.round(playersWeek.change * 100), days: playersWeek.days, from: playersWeek.from, to: playersWeek.to } : null,
      minutesPerVisit: sess != null ? Math.round(sess * 10) / 10 : null, favPer1k: Math.round(favk * 10) / 10, votesPer1k: Math.round(vk * 10) / 10,
      boardMedian: { favPer1k: bmed.favk, minutesPerVisit: bmed.sess, rating: bmed.like },
      record: rows.length ? { since: rows[0].d, readings: rows.length, peak: peak ? { players: peak.players, date: peak.d } : null, series: rows.map((r) => [r.d, r.players]) } : null,
    },
    money: { passes: pass, products: prod, revenue: rev.map(Math.round), robuxMonth: Math.round(rev[1] / DEVEX), fair: fair.map(Math.round), shape, months: shape === "staircase" ? "3 to 6" : "1 to 2" },
    owner: cr,
    servers: srv,
    maturity: mat,
    board: row ? { rank: (row[26] || {}).rank || null, score: row[24], days: streak, tracked: true } : { tracked: !!rec },
    points: { good, check, know },
    verdict: { call, line: line.trim() },
  };
}

// ---------- the endpoint ----------
export async function lookup(env, url) {
  const origin = url.origin;
  const data = await ourData(env, origin);
  // Today's top three, as examples for the search box.
  if (url.searchParams.has("examples")) {
    const B = (data.br && data.br.BOARD) || [];
    return out({ examples: B.slice(0, 3).map((r) => r[1]) }, 200, "private, max-age=600");
  }
  let uid = Number(url.searchParams.get("u")) || 0, others = [], kind = "uid";
  const q = url.searchParams.get("q");
  if (!uid) {
    const p = parseQuery(q);
    if (!p) return out({ error: "empty" }, 400);
    kind = p.kind;
    if (p.kind === "share") return out({ error: "share" }, 400);
    if (p.kind === "badlink") return out({ error: "badlink" }, 400);
    if (p.kind === "link") uid = await placeToUniverse(p.pid);
    else if (p.kind === "id") {
      // Place IDs and universe IDs share one range of numbers, so a bare number can be either.
      const asPlace = await placeToUniverse(p.id);
      const ids = Array.from(new Set([asPlace, p.id].filter(Boolean)));
      const gj = await getJSON("https://games.roblox.com/v1/games?universeIds=" + ids.join(","));
      if (!gj) return out({ error: "roblox" }, 502);
      const by = {};
      for (const x of gj.data || []) by[x.id] = x;
      const a = asPlace && by[asPlace], u = by[p.id];
      if (a && u && a.id !== u.id) {
        const row = (x, as) => ({ uid: x.id, name: x.name, players: x.playing || 0, creator: (x.creator && x.creator.name) || "", as });
        return out({ error: "choose", kind: "both", others: [row(a, "As a place ID"), row(u, "As a universe ID")].sort((x, y) => y.players - x.players) });
      }
      uid = a ? a.id : u ? u.id : 0;
    } else {
      const s = await searchByName(p.name, data.hx);
      uid = s.uid; others = s.others;
      if (!uid && others.length) return out({ error: "choose", kind, others });
    }
    if (!uid) return out({ error: "notfound", kind }, 404);
  }
  if (!Number.isSafeInteger(uid) || uid <= 0) return out({ error: "notfound", kind }, 404);

  // The same game looked up twice within 10 minutes gets the saved answer.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://lookup.spawnbook.internal/v1/" + uid);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const body = await hit.json(); body.others = others; body.kind = kind; return out(body); }
  }

  const [gj, vj, pass, prod, mat, img] = await Promise.all([
    getJSON("https://games.roblox.com/v1/games?universeIds=" + uid),
    getJSON("https://games.roblox.com/v1/games/votes?universeIds=" + uid),
    passes(uid), products(uid), maturity(uid), icon(uid),
  ]);
  if (!gj) return out({ error: "roblox" }, 502);
  const g = gj.data && gj.data[0];
  if (!g) return out({ error: "notfound", kind }, 404);
  const v = vj && vj.data && vj.data[0];
  const [cr, srv] = await Promise.all([creatorInfo(g.creator || {}, g.rootPlaceId, g.id), servers(g.rootPlaceId, g.playing)]);

  const body = analyse({ g, v, hx: data.hx, br: data.br, pass, prod, mat, cr, srv });
  body.icon = img;
  body.at = Date.now();
  body.dataDate = data.hx && data.hx.dates ? data.hx.dates[data.hx.dates.length - 1] : null;
  if (cache) await cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" } }));
  body.others = others;
  body.kind = kind;
  return out(body);
}

export const _test = { parseQuery, norm, analyse };

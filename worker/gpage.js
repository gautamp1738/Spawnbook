// Public game pages: spawnbook.com/g/<place ID>/<name>. Anyone can open one, share it or find it on
// Google, no account needed. Each shows a game's players, growth, rank in its genre and estimated
// value, plus the good signs from the lookup; what to check first, money, owner and buyer signals stay
// in the full read on /lookup (free for a day, then free accounts get a few a day).
//
// The place ID is the number in a game's Roblox link, so swapping roblox.com/games for spawnbook.com/g
// in any game's link opens its page here.
//
// Routes
//   GET /g                 search box, plus the biggest young games in our record
//   GET /g/find?q= (or u=) finds the game and redirects to its page, or lists games to choose from
//   GET /g/<pid>[/<slug>]  the game's page; other spellings redirect to /g/<root place ID>/<slug>
//   GET /sitemap.xml       the public pages, and a page for every game in our daily record
//
// Rendered pages are kept at the edge for an hour, so Google crawling them doesn't hammer Roblox.

import { findGame, universeOf, gameData, ourData, short, money, commas } from "./lookup.js";

const ORIGIN = "https://spawnbook.com";
const PAGE_TTL = 3600;
const DAY = 864e5;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// "[🎃 UPD] Grow a Garden 🌱" -> "[UPD] Grow a Garden", for titles and share text.
function clean(n) {
  let s = String(n || "");
  try { s = s.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D|\u20E3/gu, ""); } catch (e) { /* old runtime */ }
  s = s.replace(/\[\s*\]|\(\s*\)/g, "").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]").replace(/\s{2,}/g, " ").trim();
  return s || String(n || "");
}

// "[🎃] 99 Nights in the Forest!" -> "99-nights-in-the-forest". Names with no Latin letters get "game".
export function slugOf(name) {
  const s = String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "game";
}
export const pagePath = (pid, name) => "/g/" + pid + "/" + slugOf(name);

const html = (body, status, cache, extra) => new Response(body, { status: status || 200, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache || "no-store" }, extra || {}) });
const moved = (to, status) => new Response(null, { status: status || 301, headers: { Location: to, "Cache-Control": status === 303 ? "no-store" : "public, max-age=3600" } });
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const pct = (n) => (n >= 0 ? "+" : "−") + Math.abs(n) + "%";

// ---------- the page around everything ----------
function shell(o) {
  const meta = [
    `<title>${esc(o.title)}</title>`,
    o.desc ? `<meta name="description" content="${esc(o.desc)}">` : "",
    o.noindex ? `<meta name="robots" content="noindex">` : "",
    o.canonical ? `<link rel="canonical" href="${esc(ORIGIN + o.canonical)}">` : "",
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Spawnbook">`,
    o.canonical ? `<meta property="og:url" content="${esc(ORIGIN + o.canonical)}">` : "",
    `<meta property="og:title" content="${esc(o.ogTitle || o.title)}">`,
    o.ogDesc || o.desc ? `<meta property="og:description" content="${esc(o.ogDesc || o.desc)}">` : "",
    `<meta property="og:image" content="${esc(o.image || ORIGIN + "/og.png")}">`,
    o.image ? `<meta property="og:image:width" content="768"><meta property="og:image:height" content="432">` : `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    o.jsonld ? `<script type="application/ld+json">${JSON.stringify(o.jsonld).replace(/</g, "\\u003c")}</script>` : "",
  ].filter(Boolean).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${meta}
<script>document.documentElement.classList.add('js')</script>
<link rel="stylesheet" href="/site.css">
</head>
<body>

<a class="skip" href="#main">${esc(o.skip || "Skip to the content")}</a>

<div class="bar wrap">
  <nav class="topbar" aria-label="Main">
    <a class="wordmark" href="/">Spawnbook</a>
    <ul class="navlinks">
      <li class="s-hide"><a href="/g"${o.here === "find" ? ' aria-current="page"' : ""}>Look up a game</a></li>
      <li class="m-hide"><a href="/value">Value your game</a></li>
      <li class="m-hide"><a href="/signin">Sign in</a></li>
      <li><a class="keep" href="/board">Today's board</a></li>
    </ul>
  </nav>
</div>

<main id="main" tabindex="-1">
${o.body}
</main>

<footer class="foot wrap">
  <div class="foot-top">
    <p>Spawnbook. Look up any Roblox game for free, and a daily board of young games for the studios and investors who buy them.</p>
    <a class="link" href="#">Back to top</a>
  </div>
  <div class="foot-meta">
    <nav aria-label="Legal">
      <ul>
        <li><a class="link" href="/privacy.html">Privacy Policy</a></li>
        <li><a class="link" href="/terms.html">Terms</a></li>
        <li><a class="link" href="/cookies.html">Cookie Policy</a></li>
        <li><a class="link" href="/refunds.html">Refund Policy</a></li>
      </ul>
    </nav>
    <p>Independent site. Not affiliated with, endorsed by or sponsored by Roblox Corporation. Values are estimates from public numbers, not offers or appraisals.</p>
    <p>© 2026 Gautam Prasanna</p>
  </div>
</footer>

<script src="/site.js"></script>
${o.script ? `<script>${o.script}</script>` : ""}
</body>
</html>`;
}

function searchForm(id, value, label) {
  return `<form class="lk-form" role="search" action="/g/find" method="get">
      <div class="lk-line" data-ui>
        <input id="${id}" name="q" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" enterkeyhint="search" placeholder="Game name or link" value="${esc(value || "")}"${label ? ` aria-label="${esc(label)}"` : ""} aria-describedby="${id}-help">
      </div>
      <button class="button" type="submit">Look it up</button>
    </form>
    <p class="small muted" id="${id}-help">A link like roblox.com/games/123…, a place ID or the game's name. Or swap roblox.com/games for spawnbook.com/g in any game's link.</p>`;
}

// ---------- /g: the search page ----------
const MSGS = {
  share: "Share links only open for people signed in to Roblox. Open the link, then copy the address of the game's page (it has /games/ in it) and paste that here.",
  badlink: "That link isn't a Roblox game page. Paste a link with roblox.com/games/ in it, or type the game's name.",
  notfound: "Roblox doesn't have a public game that matches. Check the spelling, or paste the game's link instead.",
  roblox: "Roblox didn't answer just now. Try again in a minute.",
};

async function findPage(env, origin, q, msg, status) {
  const data = await ourData(env, origin);
  const hx = data.hx;
  let list = "";
  if (hx && hx.games) {
    const last = hx.dates.length - 1;
    const now = Date.now();
    const rows = Object.keys(hx.games).map((u) => {
      const g = hx.games[u], r = g[8][g[8].length - 1];
      return { pid: g[1], name: g[0], genre: g[3] || g[2] || "", age: Math.floor((now - Date.parse(g[7])) / DAY), players: r && r[0] === last ? r[1] : 0 };
    }).filter((g) => g.players > 0 && g.age <= 183).sort((a, b) => b.players - a.players).slice(0, 12);
    if (rows.length) {
      list = `<section class="sec wrap gp-list" aria-labelledby="gp-big-h">
    <h2 id="gp-big-h" class="lk-col-h">Biggest new games on Roblox right now</h2>
    <p class="small muted">Games under six months old on Roblox's charts, by players at our last daily reading.</p>
    <ul class="lk-pick-list">${rows.map((g) => `<li><a class="lk-pick-b" href="${esc(pagePath(g.pid, g.name))}"><span class="n" dir="auto">${esc(g.name)}</span><span class="s">${commas(g.players)} playing. ${esc(g.genre)}${g.genre ? ", " : ""}${g.age} ${g.age === 1 ? "day" : "days"} old</span></a></li>`).join("")}</ul>
  </section>`;
    }
  }
  const body = `<section class="sec wrap page-top lk-top" aria-labelledby="gp-h">
    <h1 id="gp-h" class="lk-h"><label for="gp-q">Look up any Roblox game. See its players, how fast it's growing and what it could sell for. Free, no account needed.</label></h1>
    ${searchForm("gp-q", q)}
  </section>
  ${msg ? `<div class="wrap lk-msg" role="alert"><p class="lead">${esc(msg)}</p></div>` : ""}
  ${list}`;
  return html(shell({
    title: "Look up any Roblox game: players, growth and value | Spawnbook",
    desc: "Free Roblox game stats: players right now, visits a day, rank in its genre and an estimated value for any game. Paste a link or type a name.",
    canonical: msg ? null : "/g", noindex: !!msg, here: "find", skip: "Skip to the search", body,
  }), status || 200, msg ? "no-store" : "public, max-age=600");
}

function choosePage(q, f) {
  const intro = f.kind === "both"
    ? "That number is the ID of two different games: one as a place ID (the number in a game's link) and one as a universe ID. Which one?"
    : "No game is called exactly “" + q + "”. Here's what Roblox found. Pick one:";
  const body = `<section class="sec wrap page-top lk-top" aria-labelledby="gp-h">
    <h1 id="gp-h" class="lk-h"><label for="gp-q">Look up any Roblox game.</label></h1>
    ${searchForm("gp-q", q)}
  </section>
  <div class="wrap lk-msg"><div class="lk-pick"><p>${esc(intro)}</p>
    <ul class="lk-pick-list">${(f.others || []).map((o) => `<li><a class="lk-pick-b" href="/g/find?u=${o.uid}"><span class="n" dir="auto">${esc(o.name)}</span><span class="s">${o.as ? esc(o.as) + ". " : ""}${commas(o.players)} playing${o.creator ? ". By " + esc(o.creator) : ""}</span></a></li>`).join("")}</ul>
  </div></div>`;
  return html(shell({ title: "Which game? | Spawnbook", noindex: true, here: "find", skip: "Skip to the list", body }), 200);
}

async function find(env, url) {
  const origin = url.origin;
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 200);
  let uid = Number(url.searchParams.get("u")) || 0;
  if (!Number.isSafeInteger(uid) || uid < 0) uid = 0;
  if (!uid) {
    if (!q) return moved("/g", 303);
    const f = await findGame(env, origin, q);
    if (f.error === "empty") return moved("/g", 303);
    if (f.error === "choose") return choosePage(q, f);
    if (f.error) return findPage(env, origin, q, MSGS[f.error] || MSGS.roblox, f.status === 502 ? 502 : f.status === 400 ? 400 : 404);
    uid = f.uid;
  }
  const r = await gameData(env, origin, uid);
  if (r.error) return findPage(env, origin, q, MSGS[r.error] || MSGS.roblox, r.status);
  return moved(pagePath(r.body.game.pid, r.body.game.name), 303);
}

// ---------- /g/<pid>: one game ----------
function spark(series) {
  if (!series || series.length < 2) return "";
  const w = 120, h = 32, ys = series.map((s) => s[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const pts = ys.map((y, i) => [i / (ys.length - 1) * (w - 6) + 3, h - 3 - (y - lo) / span * (h - 6)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const l = pts[pts.length - 1];
  return `<svg class="lk-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false"><path d="${d}"></path><circle cx="${l[0].toFixed(1)}" cy="${l[1].toFixed(1)}" r="3"></circle></svg>`;
}

async function thumbnail(uid) {
  try {
    const r = await fetch("https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=" + uid + "&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false",
      Object.assign({ headers: { Accept: "application/json" } }, typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : {}));
    if (!r.ok) return null;
    const j = await r.json();
    const t = j && j.data && j.data[0] && j.data[0].thumbnails && j.data[0].thumbnails[0];
    if (t && t.state === "Completed" && /^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\/[^\s"'<>]+$/i.test(t.imageUrl || "")) return t.imageUrl;
  } catch (e) { /* the site's own image stands in */ }
  return null;
}

const tile = (label, value, sub, extra) => `<div class="tile"><dt>${esc(label)}</dt><dd>${esc(value)}${extra || ""}</dd>${sub ? `<p class="tile-sub">${esc(sub)}</p>` : ""}</div>`;
const pointList = (list) => `<ul class="lk-pts">${list.map((p) => `<li><strong>${esc(p.title)}</strong><span>${esc(p.text)}</span></li>`).join("")}</ul>`;

export function renderGame(d, image) {
  const g = d.game, n = d.numbers, m = d.money, o = d.owner || {}, sg = d.signals || {};
  const path = pagePath(g.pid, g.name);
  const name = clean(g.name);
  const genre = g.genre2 || g.genre || "";
  const value = m.fair[1] < 100 ? "Under $100" : "About " + money(m.fair[1]);
  const valueLc = value.charAt(0).toLowerCase() + value.slice(1);
  const pw = n.playersWeek;
  const basis = n.basis === "week" ? "Average over the past " + n.basisDays + " days" : n.basis === "day" ? "Since our last daily reading" : "Lifetime average";

  const tiles = [
    tile("Players right now", commas(g.players), pw ? pct(pw.change) + " over " + pw.days + " days at our daily readings" : "Live from Roblox", spark(n.record && n.record.series)),
    tile("Visits a day", short(n.perDay), basis),
    tile("Total visits", short(g.visits), commas(g.favorites) + " favorites"),
    tile("Rating", g.rating != null ? g.rating + "%" : "–", commas(g.up + g.down) + " votes"),
    sg.niche ? tile("Rank in its genre", "#" + sg.niche.rank + " of " + sg.niche.of, "Young " + sg.niche.genre + " games on Roblox's charts today") : "",
  ].join("");

  // Board points stay on the board, and what to check first is in the full read.
  const good = (d.points.good || []).filter((p) => !p.board).slice(0, 4), know = (d.points.know || []).filter((p) => !p.board).slice(0, 3);
  const cols = good.length || know.length ? `<div class="lk-cols">
      ${good.length ? `<section class="lk-col lk-good"><h2 class="lk-col-h">What stands out</h2>${pointList(good)}</section>` : ""}
      ${know.length ? `<section class="lk-col lk-know"><h2 class="lk-col-h">Worth knowing</h2>${pointList(know)}</section>` : ""}
    </div>` : "";

  const who = (o.name ? "by " + o.name + ". " : "") + (genre ? genre + ". " : "") + "Launched " + day(g.created) + ", " + commas(g.age) + (g.age === 1 ? " day" : " days") + " ago.";
  const shareText = name + ": " + commas(g.players) + " playing, about " + short(n.perDay) + " visits a day, worth " + valueLc + " by Spawnbook's estimate.";
  const pageUrl = ORIGIN + path;
  const at = new Date(d.at || Date.now());
  const atText = at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";

  const body = `<article class="sec wrap page-top lk-res gp" aria-labelledby="gp-name">
    <div class="lk-head">
      ${d.icon ? `<img class="lk-icon" src="${esc(d.icon)}" alt="" width="112" height="112">` : ""}
      <div class="lk-head-b">
        <h1 id="gp-name" class="g-title" dir="auto">${esc(g.name)}</h1>
        <p class="g-meta">${esc(who)}</p>
        <p class="g-links"><a class="link" href="${esc(g.url)}" target="_blank" rel="noopener">Open on Roblox<span class="sr-only"> (opens in a new tab)</span></a></p>
      </div>
    </div>

    <div class="lk-verdict v-go gp-value">
      <p class="lk-call-lbl">Estimated value</p>
      <p class="lk-call">${esc(value)}</p>
      <p class="lk-why">${esc("Likely " + money(m.fair[0]) + " to " + money(m.fair[2]) + ": about " + money(m.revenue[1]) + " a month in revenue × " + m.months + " months.")}</p>
      <p class="small">${esc(m.why.revenue + " " + m.why.months)}</p>
      <p class="small">${esc(m.confLabel + ". It's worked out from public numbers the same way as our board; real earnings decide a real price.")}</p>
    </div>

    <dl class="tiles lk-tiles">${tiles}</dl>

    ${cols}

    <section class="gp-more" aria-labelledby="gp-more-h">
      <h2 id="gp-more-h" class="lk-col-h">The full read</h2>
      <p>What to check before you buy or sell, its passes and products with their prices, who owns it, how many servers are running, its age rating and buyer signals, with our call on it.</p>
      <p><a class="button" href="/lookup?u=${g.uid}">See the full read free</a></p>
      <p class="small muted">Free for 24 hours, then 5 lookups a day with a free account.</p>
      <p class="small">Your game? <a class="link" href="/value">Value it with your real earnings</a> or <a class="link" href="/sell">tell us you're open to selling</a>.</p>
    </section>

    <section class="gp-share" aria-labelledby="gp-share-h">
      <h2 id="gp-share-h" class="lk-col-h">Share this page</h2>
      <div class="gp-share-row">
        <input id="gp-url" class="gp-url" type="text" readonly value="${esc(pageUrl)}" aria-label="Link to this page">
        <button class="button quiet" type="button" data-copy="gp-url">Copy link</button>
        <a class="button quiet" href="https://x.com/intent/post?text=${encodeURIComponent(shareText)}&amp;url=${encodeURIComponent(pageUrl)}" target="_blank" rel="noopener">Post on X<span class="sr-only"> (opens in a new tab)</span></a>
      </div>
      <p class="small muted gp-status" role="status"></p>
    </section>

    <p class="small muted lk-src">Players, visits and votes were read from Roblox's public data at ${esc(atText)}, and pages refresh within the hour. Trends come from our daily readings${d.dataDate ? ", the last on " + esc(day(d.dataDate + "T12:00:00Z")) : ""}. Visits a day and value are our estimates.</p>
  </article>

  <section class="sec wrap gp-again" aria-labelledby="gp-again-h">
    <h2 id="gp-again-h" class="lk-col-h"><label for="gp-q">Look up another game</label></h2>
    ${searchForm("gp-q", "")}
  </section>`;

  const author = o.name ? { "@type": o.type === "Group" ? "Organization" : "Person", name: o.name } : undefined;
  const page = shell({
    title: name + " stats: players, growth and value | Spawnbook",
    desc: name + (o.name ? " by " + clean(o.name) : "") + " has " + commas(g.players) + " playing now and about " + short(n.perDay) + " visits a day. See its player trend" + (sg.niche ? ", rank in " + sg.niche.genre : "") + " and estimated value.",
    ogTitle: name + ": " + commas(g.players) + " playing, worth " + valueLc,
    ogDesc: "About " + short(n.perDay) + " visits a day" + (pw ? ", players " + pct(pw.change) + " over " + pw.days + " days" : "") + ". Estimated value " + money(m.fair[0]) + " to " + money(m.fair[2]) + " from public numbers.",
    canonical: path, image, skip: "Skip to the game",
    jsonld: { "@context": "https://schema.org", "@type": "VideoGame", name, url: g.url, image: image || undefined, genre: genre || undefined, gamePlatform: "Roblox", author, datePublished: String(g.created || "").slice(0, 10) || undefined },
    body,
    script: `(function () {
  var st = document.querySelector(".gp-status");
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var i = document.getElementById(b.getAttribute("data-copy"));
      var done = function () { b.textContent = "Copied"; st.textContent = "Link copied."; setTimeout(function () { b.textContent = "Copy link"; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(i.value).then(done, function () { i.select(); });
      else { i.select(); try { document.execCommand("copy"); done(); } catch (e) {} }
    });
  });
})();`,
  });
  return { page, slug: path.split("/")[3] };
}

async function gamePage(env, url, pid, slug, onView) {
  const origin = url.origin;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://gpage.spawnbook.internal/v1/" + pid);
  let hit = cache ? await cache.match(key) : null;
  let text, want, name, uid;
  if (hit) {
    text = await hit.text();
    want = hit.headers.get("X-Slug");
    name = decodeURIComponent(hit.headers.get("X-Name") || "");
    uid = Number(hit.headers.get("X-Uid")) || 0;
  } else {
    uid = await universeOf(env, origin, pid);
    if (!uid) return findPage(env, origin, "", "Roblox doesn't have a public game at that link. It may be private or deleted.", 404);
    const r = await gameData(env, origin, uid);
    if (r.error) return findPage(env, origin, "", r.error === "notfound" ? "Roblox doesn't have a public game at that link. It may be private or deleted." : MSGS.roblox, r.status);
    // Another place in the same game: send people to the game's main page.
    if (r.body.game.pid !== pid) return moved(pagePath(r.body.game.pid, r.body.game.name));
    const out = renderGame(r.body, await thumbnail(uid));
    text = out.page; want = out.slug; name = r.body.game.name;
    if (cache) await cache.put(key, new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "max-age=" + PAGE_TTL, "X-Slug": want, "X-Name": encodeURIComponent(name), "X-Uid": String(uid) } }));
  }
  if (slug !== want) return moved("/g/" + pid + "/" + want);
  if (onView) onView(String(name).slice(0, 120) + " u " + uid);
  return html(text, 200, "public, max-age=300");
}

export async function publicGame(request, env, url, onView) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const parts = url.pathname.replace(/\/{2,}/g, "/").split("/").filter(Boolean);
  if (parts.length === 1) return findPage(env, url.origin, "", null, 200);
  if (parts.length === 2 && parts[1].toLowerCase() === "find") return find(env, url);
  if (parts.length <= 3 && /^\d{3,19}$/.test(parts[1])) {
    const pid = Number(parts[1]);
    if (Number.isSafeInteger(pid)) return gamePage(env, url, pid, parts[2] || "", onView);
  }
  return findPage(env, url.origin, "", "That isn't a game page. Look up a game by its link or name.", 404);
}

// ---------- /sitemap.xml ----------
const PUBLIC_PAGES = ["/", "/g", "/value", "/trends", "/track", "/subscribe", "/sell", "/connect"];
export async function sitemap(env, url) {
  const data = await ourData(env, url.origin);
  const hx = data.hx;
  const last = hx && hx.dates ? hx.dates[hx.dates.length - 1] : null;
  const urls = PUBLIC_PAGES.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`);
  if (hx && hx.games) {
    const seen = new Set();
    for (const u of Object.keys(hx.games)) {
      const g = hx.games[u];
      if (!g[1] || seen.has(g[1])) continue;
      seen.add(g[1]);
      urls.push(`<url><loc>${esc(ORIGIN + pagePath(g[1], g[0]))}</loc>${last ? `<lastmod>${last}</lastmod>` : ""}</url>`);
    }
  }
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

export const _test = { slugOf, clean, renderGame };

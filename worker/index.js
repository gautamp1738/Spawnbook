// Spawnbook's Cloudflare Worker. It serves the static site in public/ and adds accounts:
// today's board and its data need a signed-in visitor whose access hasn't run out. Everything
// else (the landing page, the valuation tool, pricing, the policies) stays public.
//
// Routes
//   POST /api/signup        the landing page's form: makes an account with a password and signs the
//                           visitor in. The account runs on the browser's free pass (below), or
//                           starts one: one free day either way. plan=dev (the free-plan form on
//                           /lookup) doesn't need a studio, and next= sends them back to the lookup
//   (no route)              the free pass: opening a board page without an account starts 24 hours
//                           of free access, kept in the signed sb_trial cookie
//   POST /api/signin        email and password, from /signin
//   POST /api/signout       ends this browser's session
//   POST /api/password      sets a password, either from a one-time link (/account#t=...) or,
//                           for a signed-in visitor, from the change-password form on /account
//   GET  /api/me            { access: "none" | "active" | "expired", until, email, hasPassword }
//   GET  /api/referrals     the signed-in visitor's referral link and how many people it brought in
//   GET  /api/teaser        today's top pick without its name, for the landing page
//   GET  /board             the full board, for signed-in visitors with access
//   GET  /data.js           the board's numbers, same rule
//   GET  /report            the weekly report and its archive, same rule
//   GET  /report.js         the report's numbers, same rule
//   GET  /track             the track record, public (its track.js names picks only after a week)
//   GET  /game, /market, /watchlist, /history.js
//                           game pages, genre trends and the watchlist, with their daily history;
//                           same rule as the board
//   GET  /api/watch         the signed-in member's watched games, with status and notes
//   POST /api/watch         { action: "add" | "update" | "remove" | "seen", ... } as JSON
//   GET  /api/live?u=1,2    current Roblox numbers for up to 100 games, cached for 5 minutes
//   GET  /lookup            look up any Roblox game: the full read, same access as the board, and
//                           FREE_LOOKUPS a day for any account whose access has ended (the free plan)
//   GET  /g, /g/find, /g/<place ID>/<name>
//                           public game pages, for anyone and for Google (worker/gpage.js)
//   GET  /sitemap.xml       the public pages and a page for every game in our daily record
//   POST /api/daily-email   { email, source } signs up for the daily top 5 by email (free for 7 days
//                           without an account); signed in, { action: "off" } stops it. GET: status
//   GET|POST /unsubscribe?t= the link in every daily email
//   GET|POST /api/discord   a member's Discord webhook for the daily top 5: save, test, remove
//   /admin/activity         what people do on the site: visits, free passes, pages, lookups, sign-ups
//   GET  /api/lookup?q=     a link, place ID or name (or ?u=<universe ID>): the game's public numbers
//                           and a plain-English read of them (worker/lookup.js), cached 10 minutes a game
//   GET  /leads             verified leads: any signed-in account, even after its access ends, so a
//                           free lead still shows
//   GET  /api/buybox        what the signed-in buyer buys (genres, players, budget...), for matching,
//                           and whether buy box alerts are on
//   POST /api/buybox        saves it, as JSON; { alerts: true | false } on its own switches the alerts
//   GET|POST /unsubscribe?t=&l=alerts  the link in every buy box alert
//   POST /api/find          the board's game finder: { kind: "find", genres, size, budget, skipWave,
//                           matches } when someone asks for matches, { kind: "draft", pid } when they
//                           open a first message to a game's owner. Recorded for /admin/activity
//   GET  /api/leads         the verified leads sent to the signed-in buyer
//   POST /api/leads         { id, status, note } as JSON: the buyer's own progress on a lead
//   POST /api/sell          the public "Open to selling?" form on /sell, from game owners. Answers
//                           with a private link (/sell#t=...) and a code for the game's description
//   GET  /api/sell/status?t=  where that owner is: code found in the description, recording sent
//   POST /api/sell/check    { t }: look for the code in the game's description on Roblox now
//   POST /api/sell/proof    { t, url }: the owner's Creator Dashboard recording, once the code checks out
//   POST /api/sell/upload/start, /chunk, /done
//                           the same recording, or screenshots, uploaded from the page in 1 MB pieces
//   GET  /api/file?f=       an uploaded file: for the admin, and for a buyer once the lead is sent to them
//   /admin                  accounts and access, behind the ADMIN_KEY secret (off until it's set)
//   /admin/leads            finding games for each buyer, asking owners, verifying and sending leads
//
// Once a day (the cron in wrangler.jsonc) the Worker also runs a check that adds new games for each
// buyer, flags leads whose game changed owner on Roblox, and emails a summary when Resend is set up
// (the RESEND_API_KEY secret, and optionally EMAIL_FROM). Then the daily top 5 goes out, and each
// member gets an email when a game on today's board fits their buy box (the buy box alerts).
//
// Accounts are kept in a Durable Object with SQLite storage (Store, below), which Cloudflare
// creates on deploy, so there's no database to set up. Passwords are stored only as salted
// PBKDF2 hashes, worked out inside the Durable Object, which has a much larger CPU allowance
// than the Worker itself.

import "../public/valuation.js";
import { lookup } from "./lookup.js";
import { publicGame, sitemap } from "./gpage.js";

const FREE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LINK_MS = 7 * DAY_MS; // how long a password link from the admin page works
const SESSION_COOKIE = "sb_session";
const SESSION_MAX_AGE = 60 * 24 * 60 * 60; // 60 days
const ADMIN_COOKIE = "sb_admin";
const REFERRAL_DAYS = 31; // the free month a member gets when someone they referred first pays
const PAID_DAYS = 31; // what "Record a payment" adds on the admin page
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalPath(url);
    let res;
    try {
      if (request.method === "GET" && path !== "/" && path !== "/g" && !path.startsWith("/g/") && isPagePath(path) && viaTag(url)) trackLanding(request, env, url, ctx, path);
      // Forms that change something must come from this site.
      if (request.method === "POST" && !sameOrigin(request, url)) res = new Response("Forbidden", { status: 403 });
      else if (path === "/api/signup") res = await signup(request, env, ctx);
      else if (path === "/api/signin") res = await signin(request, env);
      else if (path === "/api/signout") res = await signout(request, env);
      else if (path === "/auth/google") res = await googleStart(request, env, url);
      else if (path === "/auth/google/callback") res = await googleBack(request, env, url);
      else if (path === "/auth/google/finish") res = await googleFinish(request, env, ctx);
      else if (path === "/api/google-pending") res = await googlePending(request, env);
      else if (path === "/api/password") res = await password(request, env);
      else if (path === "/api/me") res = await me(request, env);
      else if (path === "/api/referrals") res = await referrals(request, env, url);
      else if (path === "/api/teaser") res = await teaser(env, url);
      else if (path === "/api/watch") res = await watch(request, env);
      else if (path === "/api/live") res = await live(request, env, url);
      else if (path === "/api/buybox") res = await buybox(request, env);
      else if (path === "/api/find") res = await findApi(request, env, ctx);
      else if (path === "/api/leads") res = await myLeads(request, env);
      else if (path === "/api/sell") res = await sellForm(request, env);
      else if (path.startsWith("/api/sell/")) res = await sellSteps(request, env, url, path);
      else if (path === "/api/file") res = await fileApi(request, env, url);
      else if (path === "/api/lookup") res = await lookupApi(request, env, url, ctx);
      else if (path === "/api/daily-email") res = await dailyEmailApi(request, env, url, ctx);
      else if (path === "/api/discord") res = await discordApi(request, env, url, ctx);
      else if (path === "/unsubscribe") res = await unsubscribe(request, env, url);
      else if (path === "/g" || path.startsWith("/g/")) res = await publicGame(request, env, url, (detail) => trackPage(request, env, url, ctx, detail));
      else if (path === "/sitemap.xml") res = await sitemap(env, url);
      else if (signedInPage(path)) res = await signedIn(request, env, url, signedInPage(path));
      else if (GATED_DATA.includes(path)) res = await gated(request, env, url, path, ctx);
      else if (gatedPage(path)) res = await gated(request, env, url, gatedPage(path), ctx);
      else if (path === "/admin" || path.startsWith("/admin/")) res = await admin(request, env, url, path);
      else {
        if (path === "/" && request.method === "GET") trackVisit(request, env, url, ctx);
        res = await env.ASSETS.fetch(request);
      }
    } catch (err) {
      console.error(err && err.stack || err);
      res = new Response("Something went wrong on our side. Try again in a minute.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return secure(res);
  },

  // Once a day (the cron in wrangler.jsonc), after the daily pull has published: find games for
  // each buyer, check leads' owners on Roblox, and put together the summary for the admin page and email.
  async scheduled(event, env, ctx) {
    const origin = "https://spawnbook.com";
    ctx.waitUntil(runDaily(env, origin).catch((e) => console.error("daily", e && e.stack || e))
      .then(() => sendDailyPicks(env, origin)).catch((e) => console.error("picks", e && e.stack || e))
      .then(() => sendBoxAlerts(env, origin)).catch((e) => console.error("alerts", e && e.stack || e)));
  },
};

// ---------- email (Resend) ----------
// Off until the RESEND_API_KEY secret is set in Cloudflare. EMAIL_FROM is the sender on a domain
// verified in Resend; it defaults to an address on mail.spawnbook.com.
const OWNER_EMAIL = "gautamuprasanna@gmail.com";
const emailOn = (env) => !!env.RESEND_API_KEY;
async function sendEmail(env, msg) {
  if (!emailOn(env)) return { ok: false, off: true };
  try {
    const r = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ from: env.EMAIL_FROM || "Spawnbook <leads@mail.spawnbook.com>", reply_to: OWNER_EMAIL }, msg)),
    });
    if (!r.ok) console.error("email", r.status, await r.text());
    return { ok: r.ok };
  } catch (e) {
    console.error("email", e && e.stack || e);
    return { ok: false };
  }
}

// The daily summary as a plain-text email.
function digestText(d, origin) {
  const admin = origin + "/admin/leads";
  const lead = (id) => admin + "?id=" + id + "#lead-" + id;
  const lines = ["Spawnbook leads for " + d.date, ""];
  if (d.found.length) {
    lines.push("New games for your buyers");
    for (const f of d.found) {
      lines.push("", "For " + f.email + ":");
      for (const it of f.items) lines.push("- " + it.name + ": " + commas(it.players) + " players" + (it.change != null ? ", " + (it.change > 0 ? "+" : "") + Math.round(it.change * 100) + "% in players" : "") + (it.genre ? ", " + it.genre : "") + (it.owner ? ". Run by " + it.owner + " on Roblox" : "") + ". " + lead(it.id));
    }
    lines.push("", "Open each one for a message to send its owner from X or Discord.", "");
  }
  if (d.offers.length) {
    lines.push("Owners who filled in the selling form");
    for (const o of d.offers) lines.push("- " + o.name + ": contact " + o.contact + (o.asking ? ", asking " + o.asking : "") + ". " + lead(o.id));
    lines.push("");
  }
  if (d.confirmed && d.confirmed.length) {
    lines.push("Owners who proved the game is theirs (their code is in its description)");
    for (const c of d.confirmed) lines.push("- " + c.name + (c.proof_at ? ", recording sent too" : ", recording not sent yet") + ". " + lead(c.id));
    lines.push("");
  }
  if (d.recordings && d.recordings.length) {
    lines.push("Dashboard recordings to watch");
    for (const c of d.recordings) lines.push("- " + c.name + ": " + c.proof + " " + lead(c.id));
    lines.push("");
  }
  if (d.changed.length) {
    lines.push("Games that changed owner on Roblox (they may have sold)");
    for (const c of d.changed) lines.push("- " + c.name + ": now " + c.now + ", was " + c.was + (c.sentTo.length ? ". You sent it to " + c.sentTo.join(", ") + ", so ask whether they bought it" : "") + ". " + lead(c.id));
    lines.push("");
  }
  if (d.updates.length) {
    lines.push("Buyers' updates");
    for (const u of d.updates) lines.push("- " + u.email + " marked " + u.name + " as " + (PICK_LABELS[u.status] || u.status) + ". " + lead(u.id));
    lines.push("");
  }
  if (d.willing || d.stale.length) {
    lines.push("Waiting on you");
    if (d.willing) lines.push("- " + d.willing + (d.willing === 1 ? " owner has" : " owners have") + " said they'd sell but isn't verified yet.");
    for (const s of d.stale) lines.push("- No answer from " + s.name + " for " + s.days + " days. Follow up? " + lead(s.id));
    lines.push("");
  }
  lines.push("All leads: " + admin);
  return lines.join("\n");
}

// ---------- activity ----------
// A light record of what people do, for /admin/activity: landing visits (with the site that sent
// them), free passes started, board pages opened, lookups and sign-ups. A visitor without an
// account shows as "pass" and the last digits of their pass, so one person's visits group together
// without naming them. Bots and link previews are left out.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|headless|lighthouse|monitor|uptime|scan/i;
function isBot(request) { return BOT_UA.test(request.headers.get("User-Agent") || ""); }
function track(env, ctx, type, who, detail, src) {
  const p = call(env, "track", { type, who: String(who || "").slice(0, 120), detail: String(detail || "").slice(0, 200), src: String(src || "").slice(0, 80) }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}
const passWho = (start) => "pass " + String(start || "").slice(-7);
// The other site a visitor came from, if any ("reddit.com"), from the Referer header.
function referrer(request, url) {
  try {
    const ref = request.headers.get("Referer");
    if (ref) { const h = new URL(ref).hostname.replace(/^www\./, ""); if (h && h !== url.hostname) return h; }
  } catch (e) { /* no usable referrer */ }
  return "";
}
// The tag on a link Gautam shares, like spawnbook.com/?via=discord. Discord, X and email apps
// usually send no Referer, so without a tag those visits can't be told apart from typed addresses.
function viaTag(url) {
  const v = String(url.searchParams.get("via") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return v ? "via " + v : "";
}
// Where a visit came from: the link's tag if it has one, otherwise the referring site.
function sourceOf(request, url) { return viaTag(url) || referrer(request, url); }
function visitorWho(request) {
  const raw = readCookie(request, TRIAL_COOKIE);
  const m = raw && /^(\d{13})\./.exec(raw);
  return m ? passWho(m[1]) : "new visitor";
}
function trackVisit(request, env, url, ctx) {
  if (isBot(request)) return;
  let from = sourceOf(request, url);
  if (url.searchParams.get("ref")) from = from ? from + ", referral link" : "referral link";
  track(env, ctx, "visit", visitorWho(request), from);
}
// A public game page opened. Accounts aren't looked up here, so these pages stay fast and cacheable.
function trackPage(request, env, url, ctx, detail) {
  if (isBot(request)) return;
  track(env, ctx, "page", visitorWho(request), detail, sourceOf(request, url));
}
// Any other page opened through a tagged link (/trends?via=email, /board?via=x). Untagged visits to
// these pages aren't recorded; the home page and public game pages record every visit.
function trackLanding(request, env, url, ctx, path) {
  if (isBot(request)) return;
  track(env, ctx, "land", visitorWho(request), path.replace(/\.html$/, ""), viaTag(url));
}
const isPagePath = (path) => !/^\/(api|admin)(\/|$)/.test(path) && !/\.(?!html$)[a-z0-9]+$/.test(path);

// ---------- the daily top 5, by email and in Discord ----------
// Every evening (the cron in wrangler.jsonc), after the daily pull, today's top 5 goes to everyone on
// the email list and to each member's Discord webhook. Someone without an account gets the emails
// free for FREE_EMAIL_DAYS, then one last email that says so. Emails need Resend (RESEND_API_KEY).
const FREE_EMAIL_DAYS = 7;
const DISCORD_HOOK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;
const ADDRESS = "3094 Pine Valley Road, San Ramon, CA 94583";
const trimNum = (v) => { const s = v >= 100 ? v.toFixed(0) : v.toFixed(1); return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };
const shortNum = (n) => { n = Number(n) || 0; return n >= 999.5e6 ? trimNum(n / 1e9) + "B" : n >= 999.5e3 ? trimNum(n / 1e6) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : n >= 1e3 ? trimNum(n / 1e3) + "K" : String(Math.round(n)); };
const usd = (x) => (!(x > 0) ? "$0" : x >= 999.5e6 ? "$" + trimNum(x / 1e9) + "B" : x >= 999.5e3 ? "$" + trimNum(x / 1e6) + "M" : x >= 1e3 ? "$" + Math.round(x / 1e3) + "K" : "$" + Math.round(x));
const cleanName = (n) => { let s = String(n || ""); try { s = s.replace(/\p{Extended_Pictographic}|️|‍|⃣/gu, ""); } catch (e) {} s = s.replace(/\[\s*\]|\(\s*\)/g, "").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]").replace(/\s{2,}/g, " ").trim(); return s || String(n || ""); };
const noYear = (d) => String(d || "").replace(/,\s*\d{4}$/, "");

// Today's top 5 from data.js, with the board's middle price estimate.
async function todaysPicks(env, origin) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/data.js", origin)));
  if (!asset.ok) return null;
  const text = await asset.text();
  const at = text.indexOf("window.BR =");
  if (at < 0) return null;
  const BR = JSON.parse(text.slice(at + 11).trim().replace(/;\s*$/, ""));
  const board = BR.BOARD || [];
  const earn = BR.META && BR.META.earn;
  const picks = board.slice().sort((a, b) => b[24] - a[24] || b[7] - a[7]).slice(0, 5).map((r) => {
    const v = globalThis.SBV.value(globalThis.SBV.boardInput(r, earn), earn);
    return { name: cleanName(r[1]), pid: r[0], uid: (r[26] && r[26].uid) || null, score: r[24], players: r[7], perDay: r[8], price: v.mid, genre: r[5] || r[4] || "", age: r[6] };
  });
  return { date: (BR.META && BR.META.snapshot) || "", picks, total: board.length };
}

function dailyEmail(today, origin, d, final) {
  const unsub = origin + "/unsubscribe?t=" + d.token;
  const until = new Date(d.until).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
  const lines = ["Hi,", "", (final ? "Here's your last free top 5" : "Here's today's top 5") + " from Spawnbook (" + noYear(today.date) + "): young Roblox games growing fast, scored out of 100.", ""];
  today.picks.forEach((p, i) => {
    lines.push((i + 1) + ". " + p.name + " (score " + p.score + ")");
    lines.push("   " + commas(p.players) + " playing, " + shortNum(p.perDay) + " visits a day, " + (p.genre ? p.genre + ", " : "") + p.age + " days old. Estimated price about " + usd(p.price) + ".");
    lines.push("   " + gameUrl(p.pid), "");
  });
  lines.push("The full board has all " + today.total + " games, with prices, red flags and how to reach each owner:", origin + "/board", "");
  if (!d.member) lines.push(final ? "That was the last of your free week. To keep the daily board, subscribe for $500 a month: " + origin + "/subscribe" : "These emails are free until " + until + ". To keep the full board every day, subscribe: " + origin + "/subscribe", "");
  lines.push("Gautam Prasanna", "Spawnbook, spawnbook.com", "", ADDRESS, "Unsubscribe: " + unsub);
  return {
    to: d.email,
    subject: final ? "Your last free top 5 from Spawnbook" : "Today's top 5 young Roblox games (" + noYear(today.date) + ")",
    text: lines.join("\n"),
    headers: { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

function discordPicks(today, origin) {
  return {
    username: "Spawnbook",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "Today's top 5 young Roblox games",
      url: origin + "/board",
      description: noYear(today.date) + ". Scored out of 100 on growth, stickiness, updates, originality, earnings and ease of buying.",
      color: 0xf6e016,
      fields: today.picks.map((p, i) => ({
        name: (i + 1) + ". " + p.name.slice(0, 200) + " (" + p.score + ")",
        value: commas(p.players) + " playing, " + shortNum(p.perDay) + " visits a day, about " + usd(p.price) + "\n[Open on Roblox](" + gameUrl(p.pid) + ")" + (p.uid ? " | [Look it up](" + origin + "/lookup?u=" + p.uid + ")" : ""),
      })),
      footer: { text: "All " + today.total + " games are on the board at spawnbook.com" },
    }],
  };
}

// Posts to a Discord webhook. DISCORD_API_URL stands in for https://discord.com in tests.
async function postDiscord(env, hook, payload) {
  const target = env.DISCORD_API_URL ? hook.replace(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com/, env.DISCORD_API_URL) : hook;
  try {
    const r = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    return { ok: r.ok, gone: r.status === 401 || r.status === 404, status: r.status };
  } catch (e) {
    return { ok: false, status: "network" };
  }
}

// Sends up to 100 emails in one call to Resend.
async function sendEmailBatch(env, msgs) {
  if (!emailOn(env) || !msgs.length) return { ok: false, off: !emailOn(env) };
  try {
    const from = env.EMAIL_FROM || "Spawnbook <leads@mail.spawnbook.com>";
    const r = await fetch((env.RESEND_API_URL || "https://api.resend.com/emails") + "/batch", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(msgs.map((m) => Object.assign({ from, reply_to: OWNER_EMAIL }, m))),
    });
    if (!r.ok) console.error("email batch", r.status, await r.text());
    return { ok: r.ok };
  } catch (e) {
    console.error("email batch", e && e.stack || e);
    return { ok: false };
  }
}

async function sendDailyPicks(env, origin, opts) {
  opts = opts || {};
  const today = await todaysPicks(env, origin);
  if (!today || !today.picks.length) return { skipped: "There's no board to send." };
  const last = await call(env, "kv-get", { k: "picks_sent" });
  if (last.v === today.date && !opts.force) return { skipped: "Today's picks (" + today.date + ") already went out." };
  const out = { date: today.date, at: Date.now(), emails: 0, finals: 0, discord: 0, discordFailed: 0, emailsOff: !emailOn(env) };

  const hooks = (await call(env, "discord-due", {})).rows || [];
  const results = [];
  for (const h of hooks) {
    const r = await postDiscord(env, h.url, discordPicks(today, origin));
    results.push({ email: h.email, ok: r.ok, gone: r.gone, err: r.ok ? null : "Discord answered " + r.status });
    if (r.ok) out.discord++; else out.discordFailed++;
  }
  if (results.length) await call(env, "discord-results", { rows: results });

  if (emailOn(env)) {
    const due = (await call(env, "daily-email-due", { date: today.date })).rows || [];
    const now = Date.now();
    const all = due.map((d) => { const final = !d.member && d.until <= now; return { email: d.email, final, msg: dailyEmail(today, origin, d, final) }; });
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100);
      const r = await sendEmailBatch(env, chunk.map((x) => x.msg));
      if (!r.ok) { out.emailError = true; continue; }
      await call(env, "daily-email-sent", { date: today.date, rows: chunk.map((x) => ({ email: x.email, final: x.final })) });
      out.emails += chunk.length;
      out.finals += chunk.filter((x) => x.final).length;
    }
  }
  await call(env, "kv-set", { k: "picks_sent", v: today.date });
  await call(env, "kv-set", { k: "picks_last", v: JSON.stringify(out) });
  return out;
}

// ---------- buy box alerts ----------
// Every evening, after the top 5 goes out, each member whose access is running gets an email when a
// game on today's board fits their buy box and hasn't been sent to them before. Nothing new, no email.
// They turn it off on /leads or with the link in the email. Needs Resend, like the other emails.
const ALERT_DETAIL = 5; // games described in full; the rest are named in one line
const ALERT_MAX = 15;   // games in one email at most

// Today's board from data.js, each game with the board's price estimate and monthly revenue.
async function boardToday(env, origin) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/data.js", origin)));
  if (!asset.ok) return null;
  const text = await asset.text();
  const at = text.indexOf("window.BR =");
  if (at < 0) return null;
  const BR = JSON.parse(text.slice(at + 11).trim().replace(/;\s*$/, ""));
  const earn = BR.META && BR.META.earn;
  const games = (BR.BOARD || []).map((r) => {
    const v = globalThis.SBV.value(globalThis.SBV.boardInput(r, earn), earn);
    const x = r[26] || {};
    return { pid: r[0], uid: Number(x.uid) || null, name: cleanName(r[1]), genre: r[4] || "", genre2: r[5] || "", age: r[6], players: r[7], perDay: r[8], wave: !!r[22], score: r[24], price: v.mid, rev: v.rev.mid };
  });
  return { date: (BR.META && BR.META.snapshot) || "", games };
}

// Does a board game fit a buy box? Total visits aren't on the board, so maxVisits isn't checked here
// (the daily leads check uses it). A box that asks for nothing in particular gets no alerts: every
// game would fit, and that's what the daily top 5 email is for.
function boxAsks(box) {
  return !!(box && ((box.genres && box.genres.length) || box.minPlayers || box.maxPlayers || box.maxAgeDays || box.minRevenue || box.maxPrice || /trend|brainrot/i.test(box.avoid || "")));
}
function boxFits(g, box) {
  if (box.genres && box.genres.length && !box.genres.includes(g.genre)) return false;
  if (box.minPlayers && g.players < box.minPlayers) return false;
  if (box.maxPlayers && g.players > box.maxPlayers) return false;
  if (box.maxAgeDays && g.age > box.maxAgeDays) return false;
  if (box.maxPrice && g.price > box.maxPrice) return false;
  if (box.minRevenue && g.rev < box.minRevenue) return false;
  if (g.wave && /trend|brainrot/i.test(box.avoid || "")) return false;
  return true;
}

function alertEmail(board, list, d, origin) {
  const unsub = origin + "/unsubscribe?t=" + d.token + "&l=alerts";
  const first = String(d.name || "").trim().split(/\s+/)[0];
  const n = list.length;
  const shown = list.slice(0, ALERT_DETAIL), rest = list.slice(ALERT_DETAIL);
  const lines = ["Hi " + (first || "there") + ",", "", (n === 1 ? "A game on today's Spawnbook board (" + noYear(board.date) + ") fits" : n + " games on today's Spawnbook board (" + noYear(board.date) + ") fit") + " the buy box on your account.", ""];
  shown.forEach((g, i) => {
    lines.push((i + 1) + ". " + g.name + " (score " + g.score + " of 100)");
    lines.push("   " + (g.genre2 || g.genre ? (g.genre2 || g.genre) + ", " : "") + commas(g.players) + " playing, " + g.age + " days old, " + shortNum(g.perDay) + " visits a day. Estimated price about " + usd(g.price) + ".");
    lines.push("   On Spawnbook: " + origin + "/game?pid=" + g.pid + "&via=alert");
    lines.push("   On Roblox: " + gameUrl(g.pid), "");
  });
  if (rest.length) lines.push((rest.length === 1 ? "One more fits too: " : rest.length + " more fit too: ") + rest.map((g) => g.name).join(", ") + ". They're on the board: " + origin + "/board?via=alert", "");
  lines.push("We send each game once, so these won't come again. To change what you buy, or turn these emails off, go to your Leads page: " + origin + "/leads", "");
  if (d.until - Date.now() < 3 * DAY_MS) {
    const until = new Date(d.until).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
    lines.push("Your access runs until " + until + ". To keep the board and these emails after that, subscribe: " + origin + "/subscribe", "");
  }
  lines.push("Gautam Prasanna", "Spawnbook, spawnbook.com", "", ADDRESS, "Stop these emails: " + unsub);
  return {
    to: d.email,
    subject: n === 1 ? "A game on today's board fits what you buy: " + list[0].name : n + " games on today's board fit what you buy",
    text: lines.join("\n"),
    headers: { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

async function sendBoxAlerts(env, origin, opts) {
  opts = opts || {};
  if (!emailOn(env)) return { off: true };
  const board = await boardToday(env, origin);
  if (!board || !board.games.length) return { skipped: "There's no board to match against." };
  const last = await call(env, "kv-get", { k: "alerts_sent" });
  if (last.v === board.date && !opts.force) return { skipped: "Today's buy box alerts (" + board.date + ") already went out." };
  const due = (await call(env, "alerts-due", { date: board.date })).rows || [];
  const out = { date: board.date, at: Date.now(), members: due.length, emails: 0, games: 0 };
  const quiet = [], all = [];
  for (const d of due) {
    let box;
    try { box = JSON.parse(d.box); } catch (e) { box = null; }
    const sent = new Set(d.sent || []), watched = new Set(d.watched || []);
    const list = boxAsks(box) ? board.games.filter((g) => boxFits(g, box) && !sent.has(g.pid) && !(g.uid && watched.has(g.uid))).sort((a, b) => b.score - a.score).slice(0, ALERT_MAX) : [];
    if (!list.length) { quiet.push({ email: d.email, pids: [] }); continue; }
    all.push({ email: d.email, pids: list.map((g) => g.pid), msg: alertEmail(board, list, d, origin) });
  }
  if (quiet.length) await call(env, "alerts-sent", { date: board.date, rows: quiet });
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const r = await sendEmailBatch(env, chunk.map((x) => x.msg));
    if (!r.ok) { out.emailError = true; continue; }
    await call(env, "alerts-sent", { date: board.date, rows: chunk.map((x) => ({ email: x.email, pids: x.pids })) });
    out.emails += chunk.length;
    out.games += chunk.reduce((s, x) => s + x.pids.length, 0);
  }
  await call(env, "kv-set", { k: "alerts_sent", v: board.date });
  await call(env, "kv-set", { k: "alerts_last", v: JSON.stringify(out) });
  return out;
}

// The sign-up box ("email me the daily top 5") on the landing page and board, and the switch on the
// account page. Answers JSON for the page's script; a plain form post is sent back to the landing page.
async function dailyEmailApi(request, env, url, ctx) {
  const s = await session(request, env);
  if (request.method === "GET") {
    if (!s) return json({ error: "signin" }, 401);
    const r = await call(env, "daily-email-get", { email: s.email });
    return json({ on: r.on, email: s.email, sending: emailOn(env) });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  let b = {};
  if ((request.headers.get("Content-Type") || "").includes("application/json")) b = await request.json().catch(() => ({}));
  else { const f = await request.formData(); b = { email: f.get("email"), source: f.get("source"), website: f.get("website") }; }
  const done = (data, status) => (wantsJson ? json(data, status) : redirect("/?emailed=" + (data.error ? "bad" : "1") + "#teaser"));
  if (b.website) return done({ ok: true });
  if (b.action === "off") {
    if (!s) return json({ error: "signin" }, 401);
    await call(env, "daily-email-off", { email: s.email });
    return json({ ok: true, on: false });
  }
  const email = String(b.email || (s ? s.email : "")).trim().toLowerCase().slice(0, 200);
  if (!validEmail(email)) return done({ error: "email" }, 400);
  const r = await call(env, "daily-email-add", { email, token: randomToken(), until: Date.now() + FREE_EMAIL_DAYS * DAY_MS, source: String(b.source || "").slice(0, 40) });
  if (r.limited) return done({ error: "busy" }, 429);
  if (r.fresh) {
    track(env, ctx, "email", email, String(b.source || ""));
    const member = !!(s && s.email === email && s.until > Date.now());
    const unsub = url.origin + "/unsubscribe?t=" + r.token;
    const p = sendEmail(env, {
      to: email,
      subject: "You're in: Spawnbook's daily top 5",
      text: ["Hi,", "", "Thanks for signing up. Every evening, Pacific time, you'll get Spawnbook's top 5 young Roblox games: the small games growing fastest, scored out of 100." + (member ? "" : " It's free for the next " + FREE_EMAIL_DAYS + " days."), "", "The full board is at " + url.origin + "/board", "", "Gautam Prasanna", "Spawnbook, spawnbook.com", "", ADDRESS, "Unsubscribe: " + unsub].join("\n"),
      headers: { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  return done({ ok: true, on: true, already: !!r.already, sending: emailOn(env) });
}

// The link in every daily email. Opening it asks first (so link scanners can't unsubscribe anyone);
// the button, and mail apps' one-click unsubscribe, post to it.
async function unsubscribe(request, env, url) {
  const t = String(url.searchParams.get("t") || "");
  const home = `<p><a class="button quiet" href="/">Go to Spawnbook</a></p>`;
  if (!/^[0-9a-f]{64}$/.test(t)) return page("Unsubscribe", `<h1 class="head">That link didn't work</h1><p>Use the unsubscribe link from the bottom of one of our emails, or reply to any email and we'll take you off the list.</p>${home}`);
  // The buy box alerts carry &l=alerts, and turn off only those.
  if (url.searchParams.get("l") === "alerts") {
    if (request.method === "POST") {
      const r = await call(env, "alerts-unsub", { token: t });
      return page("Unsubscribed", r.ok ? `<h1 class="head">Buy box emails are off</h1><p>We won't email you when a game fits what you buy. You can turn them back on from your <a class="link" href="/leads">Leads page</a>.</p>${home}` : `<h1 class="head">That link didn't work</h1><p>Reply to any of our emails and we'll turn them off for you.</p>${home}`);
    }
    return page("Unsubscribe", `<h1 class="head">Stop the buy box emails?</h1><p>You'll stop getting an email when a game on the board fits what you buy. The daily top 5, if you get it, isn't affected.</p><form method="post" action="/unsubscribe?t=${t}&amp;l=alerts"><button class="button" type="submit">Stop these emails</button></form>`);
  }
  if (request.method === "POST") {
    const r = await call(env, "daily-email-unsub", { token: t });
    return page("Unsubscribed", r.ok ? `<h1 class="head">You're unsubscribed</h1><p>We won't send you the daily top 5 again.</p>${home}` : `<h1 class="head">That link didn't work</h1><p>Reply to any of our emails and we'll take you off the list.</p>${home}`);
  }
  return page("Unsubscribe", `<h1 class="head">Stop the daily emails?</h1><p>You'll stop getting Spawnbook's daily top 5.</p><form method="post" action="/unsubscribe?t=${t}"><button class="button" type="submit">Unsubscribe</button></form>`);
}

// A member's Discord webhook. Saving one posts a short hello first, so a wrong link is caught now
// rather than tonight. The full link is never sent back to the page.
async function discordApi(request, env, url, ctx) {
  const s = await member(request, env);
  if (!s) return json({ error: "signin" }, 401);
  if (request.method === "GET") return json(await call(env, "discord-get", { email: s.email }));
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const b = await request.json().catch(() => ({}));
  if (b.action === "remove") {
    await call(env, "discord-set", { email: s.email, url: null });
    return json({ ok: true, set: false });
  }
  if (b.action === "save") {
    const hook = String(b.url || "").trim();
    if (!DISCORD_HOOK.test(hook)) return json({ error: "url" }, 400);
    const r = await postDiscord(env, hook, { username: "Spawnbook", allowed_mentions: { parse: [] }, content: "Connected. Spawnbook will post the daily top 5 young Roblox games here every evening, Pacific time." });
    if (!r.ok) return json({ error: r.gone ? "gone" : "post" }, 400);
    await call(env, "discord-set", { email: s.email, url: hook });
    track(env, ctx, "discord", s.email, "");
    return json({ ok: true, set: true });
  }
  if (b.action === "test") {
    const cur = await call(env, "discord-get", { email: s.email, full: true });
    if (!cur.url) return json({ error: "none" }, 400);
    const today = await todaysPicks(env, url.origin);
    if (!today) return json({ error: "board" }, 503);
    const r = await postDiscord(env, cur.url, discordPicks(today, url.origin));
    await call(env, "discord-results", { rows: [{ email: s.email, ok: r.ok, gone: r.gone, err: r.ok ? null : "Discord answered " + r.status }] });
    return r.ok ? json({ ok: true }) : json({ error: r.gone ? "gone" : "post" }, 400);
  }
  return json({ error: "action" }, 400);
}

// The daily run: the Store does the work (it has the larger CPU allowance), using today's history.
async function runDaily(env, origin) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/history.js", origin)));
  const history = asset.ok ? await asset.text() : "";
  const r = await call(env, "daily", { history, origin });
  // Pieces of uploads that never finished.
  const byLead = {};
  for (const f of r.staleFiles || []) (byLead[f.lead_id] = byLead[f.lead_id] || []).push(f.id);
  for (const id of Object.keys(byLead)) await filesCall(env, id, "file-drop", { ids: byLead[id] }).catch(() => {});
  if (r.digest && r.digest.any) {
    await sendEmail(env, { to: OWNER_EMAIL, subject: "Spawnbook leads: " + r.digest.headline, text: digestText(r.digest, origin) });
  }
  return r;
}

// The path as the asset server would see it: decoded, single slashes, lower case. Gate checks use
// this so odd spellings like //data.js or /Board can't slip past.
function normalPath(url) {
  let p = url.pathname;
  try { p = decodeURIComponent(p); } catch (e) {}
  return p.replace(/\/{2,}/g, "/").toLowerCase();
}

// Browsers send Origin with form posts. A post from another site is refused; one without an
// Origin header (old browsers, curl) is let through, since cookies are SameSite anyway.
function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

function secure(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function redirect(location, extraHeaders) {
  return new Response(null, { status: 303, headers: Object.assign({ Location: location, "Cache-Control": "no-store" }, extraHeaders || {}) });
}

function json(data, status, cache) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache || "no-store" } });
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionCookie(token) {
  return SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=" + SESSION_MAX_AGE + "; HttpOnly; Secure; SameSite=Lax";
}
const CLEAR_SESSION = SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const passwordProblem = (p) => (p.length < MIN_PASSWORD ? "short" : p.length > MAX_PASSWORD ? "long" : null);

// Where to send someone after they sign in: only our own pages, never another site.
function nextPath(value, until) {
  // The free plan's lookup and the public game pages work whatever the account's access.
  if (/^\/(?:lookup|g\/\d{3,19})(?:[/?][\w\-.~%=&/]*)?$/.test(value) && !value.includes("..")) return value;
  if (GATED_PAGES.includes(value)) return until <= Date.now() ? "/subscribe" : value;
  if (value === "/subscribe" || value === "/account" || SIGNED_IN_PAGES.includes(value)) return value;
  return until > Date.now() ? "/board" : "/subscribe";
}

// Pages for any signed-in account, whether or not its access has run out.
const SIGNED_IN_PAGES = ["/leads"];
function signedInPage(path) {
  for (const p of SIGNED_IN_PAGES) if (path === p || path.startsWith(p + ".") || path.startsWith(p + "/")) return p;
  return null;
}

// Pages and data files that need a signed-in visitor whose access hasn't run out.
const GATED_PAGES = ["/board", "/report", "/game", "/market", "/watchlist", "/lookup"];
const GATED_DATA = ["/data.js", "/report.js", "/history.js"];
// "/board", "/board.html", "/board/anything" all mean the board page.
function gatedPage(path) {
  for (const p of GATED_PAGES) if (path === p || path.startsWith(p + ".") || path.startsWith(p + "/")) return p;
  return null;
}

// ---------- the store ----------

function store(env) {
  return env.STORE.get(env.STORE.idFromName("main"));
}

// A lead's own object, which holds the pieces of the files its owner uploaded.
const filesStub = (env, leadId) => env.STORE.get(env.STORE.idFromName("files-" + Number(leadId)));
async function filesCall(env, leadId, op, payload) {
  const res = await filesStub(env, leadId).fetch("https://store/" + op, { method: "POST", body: JSON.stringify(payload || {}) });
  if (!res.ok) throw new Error("Files " + op + " failed: " + res.status);
  return res.json();
}

async function call(env, op, payload) {
  const res = await store(env).fetch("https://store/" + op, { method: "POST", body: JSON.stringify(payload || {}) });
  if (!res.ok) throw new Error("Store " + op + " failed: " + res.status);
  return res.json();
}

// Who is this visitor? Returns null when they aren't signed in.
async function session(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const s = await call(env, "session", { token });
  return s.email ? Object.assign(s, { token }) : null;
}

// ---------- the free 24-hour pass ----------
// Anyone who opens a board page without an account gets 24 hours of access, no sign-up needed. The
// pass is a cookie holding when it started, signed with a key kept in the Store, so it can't be
// edited to last longer. It's remembered for 30 days, so the same browser gets one free day.
// Clearing cookies starts a new one; that's accepted, the same as signing up with a second email.
const TRIAL_COOKIE = "sb_trial";
const TRIAL_REMEMBER = 30 * DAY_MS;
let trialKey = null;

async function trialSig(env, start) {
  if (!trialKey) {
    const { secret } = await call(env, "trial-secret", {});
    trialKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const mac = await crypto.subtle.sign("HMAC", trialKey, new TextEncoder().encode("spawnbook-trial:" + start));
  return Array.from(new Uint8Array(mac).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The visitor's pass, or null when they have none (or it was tampered with).
async function readTrial(request, env) {
  const raw = readCookie(request, TRIAL_COOKIE);
  const m = raw && /^(\d{13})\.([0-9a-f]{32})$/.exec(raw);
  if (!m) return null;
  const start = Number(m[1]), now = Date.now();
  if (start > now + 60e3 || now - start > TRIAL_REMEMBER) return null;
  if ((await trialSig(env, start)) !== m[2]) return null;
  return { start, until: start + FREE_MS, active: now < start + FREE_MS };
}

async function trialCookie(env, start) {
  return TRIAL_COOKIE + "=" + start + "." + (await trialSig(env, start)) + "; Path=/; Max-Age=" + Math.round(TRIAL_REMEMBER / 1000) + "; HttpOnly; Secure; SameSite=Lax";
}

// ---------- accounts ----------

async function signup(request, env, ctx) {
  if (request.method !== "POST") return redirect("/#signup");
  const form = await request.formData();
  const get = (k) => String(form.get(k) || "").trim();
  // The free-plan form on /lookup: no studio needed, and errors go back to the lookup.
  const dev = get("plan") === "dev";
  const next = get("next").slice(0, 300);
  const nextOk = nextPath(next, Date.now()) === next;
  const back = (code) => (dev && nextOk ? redirect(next + (next.includes("?") ? "&" : "?") + "se=" + code + "#free") : redirect("/?e=" + code + "#signup"));

  // Bots fill in every field, including the hidden one people never see.
  if (get("website")) return redirect("/");

  const name = get("name").slice(0, 120);
  const email = get("email").toLowerCase().slice(0, 200);
  const company = get("company").slice(0, 160);
  const role = (get("role") || (dev ? "I make Roblox games" : "")).slice(0, 60);
  const pw = String(form.get("password") || "");
  const ref = get("ref").toLowerCase();
  if (!name || !email || (!company && !dev)) return back("missing");
  if (!validEmail(email)) return back("email");
  const bad = passwordProblem(pw);
  if (bad) return back("password-" + bad);
  if (get("agree") !== "yes") return back("agree");

  // An account runs on the same free day as the browser's pass: it doesn't add another one.
  const t = await readTrial(request, env);
  const now = Date.now();
  const until = t ? t.until : now + FREE_MS;
  const token = randomToken();
  const r = await call(env, "signup", { email, name, company, role, password: pw, token, until, ref: /^[a-z0-9]{6,16}$/.test(ref) ? ref : null });
  if (r.exists) return redirect("/signin?e=exists" + (dev && nextOk ? "&next=" + encodeURIComponent(next) : ""));
  track(env, ctx, "signup", email, company || (dev ? "free plan" : ""));
  const headers = new Headers({ Location: dev && nextOk ? next : nextPath("", r.until), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie(token));
  if (!t) headers.append("Set-Cookie", await trialCookie(env, now));
  return new Response(null, { status: 303, headers });
}

async function signin(request, env) {
  if (request.method !== "POST") return redirect("/signin");
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase().slice(0, 200);
  const pw = String(form.get("password") || "");
  const next = String(form.get("next") || "");
  const back = (code) => redirect("/signin?e=" + code + (next ? "&next=" + encodeURIComponent(next) : ""));
  if (!email || !pw) return back("missing");

  const token = randomToken();
  const r = await call(env, "signin", { email, password: pw.slice(0, MAX_PASSWORD), token });
  if (!r.ok) return back(r.reason || "bad");
  return redirect(nextPath(next, r.until), { "Set-Cookie": sessionCookie(token) });
}

// ---------- Sign in with Google ----------
// Off until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in Cloudflare; until then the
// buttons stay hidden. Accounts are keyed by email, so Google's verified email is the link: an
// email that already has an account signs straight in, and a new one gets a short "finish your
// account" step for the studio name and the terms. Google never sees anything but the sign-in.
const OAUTH_COOKIE = "sb_oauth";
const GNEW_COOKIE = "sb_gnew";
const GOOGLE_PENDING_MS = 15 * 60 * 1000;
// A real client ID is "<project number>-<letters>.apps.googleusercontent.com". One that's been
// pasted with only its end (or with spaces) would send people to Google's "client not found"
// page, so the button stays hidden until it looks right, and the admin page says why.
// Client IDs and secrets never contain spaces or quotes, so any pasted along (or an invisible
// character copied from a web page) are dropped.
const cleanKey = (v) => String(v || "").replace(/[\s"'`\u200B-\u200D\u2060\uFEFF]/g, "");
const googleId = (env) => cleanKey(env.GOOGLE_CLIENT_ID).toLowerCase();
const googleSecret = (env) => cleanKey(env.GOOGLE_CLIENT_SECRET);
const googleIdOk = (env) => /^\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(googleId(env));
const googleOn = (env) => googleIdOk(env) && googleSecret(env).length >= 10;
function googleStatus(env) {
  if (!env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_SECRET) return "Continue with Google is off until the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets are added in Cloudflare.";
  if (!googleIdOk(env)) return "<strong>Continue with Google is hidden: the GOOGLE_CLIENT_ID secret doesn't look like a whole client ID.</strong> It should look like 123456789012-abc123.apps.googleusercontent.com" + (googleId(env).endsWith(".apps.googleusercontent.com") && !/^\d/.test(googleId(env)) ? ", but the part before .apps.googleusercontent.com is missing. Copy it again with the copy button next to Client ID in Google Cloud" : "") + ".";
  if (!(googleSecret(env).length >= 10)) return "<strong>Continue with Google is hidden: the GOOGLE_CLIENT_SECRET secret is missing or too short.</strong>";
  return "Continue with Google is on.";
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CLEAR_OAUTH = OAUTH_COOKIE + "=; Path=/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
const CLEAR_GNEW = GNEW_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

function jwtClaims(jwt) {
  try {
    const part = String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(part + "===".slice((part.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch (e) { return null; }
}

// /auth/google?next=/board&ref=abc123: off to Google's account picker.
async function googleStart(request, env, url) {
  if (!googleOn(env)) return redirect("/signin?e=google-off");
  const next = String(url.searchParams.get("next") || "").slice(0, 300);
  const ref = String(url.searchParams.get("ref") || "").toLowerCase();
  const state = randomToken().slice(0, 32);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const keep = [state, verifier, next, /^[a-z0-9]{6,16}$/.test(ref) ? ref : ""].map(encodeURIComponent).join("|");
  const q = new URLSearchParams({
    client_id: googleId(env), redirect_uri: url.origin + "/auth/google/callback", response_type: "code",
    scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account"
  });
  return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q, { "Set-Cookie": OAUTH_COOKIE + "=" + keep + "; Path=/auth/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax" });
}

// Google sends them back here with a one-time code.
async function googleBack(request, env, url) {
  const fail = (code) => redirect("/signin?e=" + code, { "Set-Cookie": CLEAR_OAUTH });
  if (!googleOn(env)) return fail("google-off");
  if (url.searchParams.get("error")) return fail("google-cancel");
  const [state, verifier, next, ref] = String(readCookie(request, OAUTH_COOKIE) || "").split("|").map((s) => { try { return decodeURIComponent(s); } catch (e) { return ""; } });
  if (!state || !verifier || url.searchParams.get("state") !== state) return fail("google-state");
  const code = url.searchParams.get("code");
  if (!code) return fail("google");
  let tok;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: googleId(env), client_secret: googleSecret(env), redirect_uri: url.origin + "/auth/google/callback", grant_type: "authorization_code", code_verifier: verifier })
    });
    tok = await r.json();
    if (!r.ok || !tok.id_token) return fail("google");
  } catch (e) { return fail("google"); }
  // The ID token came straight from Google over HTTPS in exchange for our secret, so its claims
  // can be trusted without checking the signature (OpenID Connect Core 3.1.3.7). The audience,
  // issuer and expiry still have to match.
  const c = jwtClaims(tok.id_token);
  if (!c || !c.sub || c.aud !== googleId(env) || !["accounts.google.com", "https://accounts.google.com"].includes(c.iss) || !(c.exp * 1000 > Date.now())) return fail("google");
  const email = String(c.email || "").toLowerCase().slice(0, 200);
  if (c.email_verified !== true || !validEmail(email)) return fail("google-email");

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", CLEAR_OAUTH);
  const token = randomToken();
  const r = await call(env, "google-signin", { email, sub: String(c.sub), token });
  if (r.ok) {
    headers.set("Location", nextPath(next || "", r.until));
    headers.append("Set-Cookie", sessionCookie(token));
    return new Response(null, { status: 303, headers });
  }
  // A new email: hold what Google told us for 15 minutes while they finish the account.
  const pend = randomToken();
  await call(env, "google-pending", { hash: await sha256(pend), email, sub: String(c.sub), name: String(c.name || "").slice(0, 120), next: (next || "").slice(0, 300), ref: ref || "", expires: Date.now() + GOOGLE_PENDING_MS });
  headers.set("Location", "/signin?g=new");
  headers.append("Set-Cookie", GNEW_COOKIE + "=" + pend + "; Path=/; Max-Age=" + GOOGLE_PENDING_MS / 1000 + "; HttpOnly; Secure; SameSite=Lax");
  return new Response(null, { status: 303, headers });
}

// The "finish your account" form fills in the name and email Google gave.
async function googlePending(request, env) {
  const pend = readCookie(request, GNEW_COOKIE);
  if (!pend || !/^[0-9a-f]{64}$/.test(pend)) return json({ pending: false });
  const r = await call(env, "google-pending-get", { hash: await sha256(pend) });
  return json(r.email ? { pending: true, email: r.email, name: r.name || "", dev: /^\/(lookup|value|sell)\b/.test(r.next || "") } : { pending: false });
}

async function googleFinish(request, env, ctx) {
  if (request.method !== "POST") return redirect("/signin?g=new");
  const pend = readCookie(request, GNEW_COOKIE);
  if (!pend || !/^[0-9a-f]{64}$/.test(pend)) return redirect("/signin?e=google-expired");
  const form = await request.formData();
  const get = (k) => String(form.get(k) || "").trim();
  if (get("website")) return redirect("/");
  const back = (code) => redirect("/signin?g=new&e=" + code);
  const name = get("name").slice(0, 120);
  const company = get("company").slice(0, 160);
  const role = get("role").slice(0, 60);
  const dev = role === "I make Roblox games";
  if (!name || (!company && !dev)) return back("missing");
  if (get("agree") !== "yes") return back("agree");

  // Same free day as the browser's pass, the same as signing up with a password.
  const t = await readTrial(request, env);
  const now = Date.now();
  const token = randomToken();
  const r = await call(env, "google-finish", { hash: await sha256(pend), name, company, role, token, until: t ? t.until : now + FREE_MS });
  if (!r.ok) return redirect("/signin?e=google-expired", { "Set-Cookie": CLEAR_GNEW });
  if (r.created) track(env, ctx, "signup", r.email, company || (dev ? "free plan" : ""));
  const headers = new Headers({ Location: nextPath(r.next || "", r.until), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie(token));
  headers.append("Set-Cookie", CLEAR_GNEW);
  if (!t) headers.append("Set-Cookie", await trialCookie(env, now));
  return new Response(null, { status: 303, headers });
}

async function signout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) await call(env, "signout", { token });
  return redirect("/signin?out=1", { "Set-Cookie": CLEAR_SESSION });
}

// One endpoint for all three password forms:
//   a one-time link        { t, password }             signs in and ends every other session
//   a signed-in visitor    { current, password }        current is needed only if a password is set
async function password(request, env) {
  if (request.method !== "POST") return redirect("/account");
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  const t = String(form.get("t") || "").trim().toLowerCase();
  const back = (code) => redirect("/account?e=" + code);

  const bad = passwordProblem(pw);
  if (t) {
    if (!/^[0-9a-f]{64}$/.test(t)) return back("link");
    if (bad) return redirect("/account?e=password-" + bad + "#t=" + t);
    const token = randomToken();
    const r = await call(env, "set-by-link", { linkHash: await sha256(t), password: pw, token });
    if (!r.ok) return back("link");
    return redirect(nextPath("", r.until), { "Set-Cookie": sessionCookie(token) });
  }

  const s = await session(request, env);
  if (!s) return redirect("/signin?next=/account");
  if (bad) return back("password-" + bad);
  const r = await call(env, "set-by-session", { token: s.token, current: String(form.get("current") || "").slice(0, MAX_PASSWORD), password: pw });
  if (!r.ok) return back(r.reason || "current");
  return redirect("/account?done=1");
}

async function me(request, env) {
  const s = await session(request, env);
  if (!s) {
    // No account: say whether they have a free pass, and how long it has left.
    const t = await readTrial(request, env);
    return json({ access: "none", trial: t ? { active: t.active, start: t.start, until: t.until } : null, google: googleOn(env) });
  }
  return json({ access: s.until > Date.now() ? "active" : "expired", until: s.until, email: s.email, hasPassword: !!s.hasPassword, hasGoogle: !!s.hasGoogle, name: s.name || "", company: s.company || "", google: googleOn(env) });
}

// The visitor's own referral link. Counts only: who signed up through it stays private.
async function referrals(request, env, url) {
  const s = await session(request, env);
  if (!s) return json({ error: "signin" }, 401);
  const r = await call(env, "referrals", { token: s.token });
  if (!r.code) return json({ error: "signin" }, 401);
  return json({ link: url.origin + "/?ref=" + r.code, code: r.code, signedUp: r.signedUp, paying: r.paying, monthsEarned: r.monthsEarned, days: REFERRAL_DAYS });
}

// ---------- watchlist ----------

const STATUSES = ["watching", "contacted", "talking", "passed", "bought"];
const MAX_WATCH = 300;

async function member(request, env) {
  const s = await session(request, env);
  return s && s.until > Date.now() ? s : null;
}

async function watch(request, env) {
  // An account whose access ended hears that, not "create a free account".
  const s = await session(request, env);
  if (!s) return json({ error: "signin" }, 401);
  if (!(s.until > Date.now())) return json({ error: "expired" }, 403);
  if (request.method === "GET") return json(await call(env, "watch-list", { email: s.email }));
  if (request.method !== "POST") return json({ error: "method" }, 405);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad" }, 400); }
  const int = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (b.action === "seen") {
    const seen = {};
    for (const [k, v] of Object.entries(b.seen || {}).slice(0, MAX_WATCH)) if (int(k) && Number.isFinite(Number(v))) seen[int(k)] = Math.max(0, Math.round(Number(v)));
    return json(await call(env, "watch-seen", { email: s.email, seen }));
  }
  const uid = int(b.uid);
  if (!uid) return json({ error: "bad" }, 400);
  if (b.action === "remove") return json(await call(env, "watch-remove", { email: s.email, uid }));
  if (b.action !== "add" && b.action !== "update") return json({ error: "bad" }, 400);
  const row = { email: s.email, uid, pid: int(b.pid), name: String(b.name || "").slice(0, 120), max: MAX_WATCH };
  if (b.status != null) { if (!STATUSES.includes(b.status)) return json({ error: "bad" }, 400); row.status = b.status; }
  if (b.note != null) row.note = String(b.note).slice(0, 2000);
  const r = await call(env, b.action === "add" ? "watch-add" : "watch-update", row);
  return json(r, r.error ? 400 : 200);
}

// Current numbers straight from Roblox for the watchlist and game pages. The daily history only
// updates once a day; this fills in "right now". Answers are cached for five minutes per set of games.
async function live(request, env, url) {
  const s = await member(request, env);
  if (!s) {
    const t = await readTrial(request, env);
    if (!t || !t.active) return json({ error: "signin" }, 401);
  }
  const ids = Array.from(new Set(String(url.searchParams.get("u") || "").split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))).sort((a, b) => a - b).slice(0, 100);
  if (!ids.length) return json({ at: Date.now(), games: {} });
  const key = new Request("https://live.spawnbook.internal/" + ids.join(","));
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) { const hit = await cache.match(key); if (hit) return new Response(hit.body, hit); }
  const games = {};
  try {
    const opts = { headers: { Accept: "application/json" } };
    const [g, v] = await Promise.all([
      fetch("https://games.roblox.com/v1/games?universeIds=" + ids.join(","), opts),
      fetch("https://games.roblox.com/v1/games/votes?universeIds=" + ids.join(","), opts),
    ]);
    const gj = g.ok ? await g.json() : { data: [] };
    const vj = v.ok ? await v.json() : { data: [] };
    const votes = {};
    for (const x of vj.data || []) votes[x.id] = x;
    for (const x of gj.data || []) {
      const vv = votes[x.id] || {};
      games[x.id] = { players: x.playing, visits: x.visits, up: vv.upVotes || 0, down: vv.downVotes || 0, name: x.name, pid: x.rootPlaceId, updated: x.updated, created: x.created, maxPlayers: x.maxPlayers, favorites: x.favoritedCount };
    }
  } catch (e) {
    return json({ at: Date.now(), games: {}, error: "roblox" });
  }
  const res = json({ at: Date.now(), games }, 200, "private, max-age=300");
  if (cache && Object.keys(games).length) await cache.put(key, new Response(JSON.stringify({ at: Date.now(), games }), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "max-age=300" } }));
  return res;
}

// Look up any Roblox game: as many as they like with the board's access (an active account, or a
// free pass that's still running), or FREE_LOOKUPS different games a day (UTC) on the free plan, for
// any account whose access has ended. Opening a game again the same day doesn't count twice. Free
// lookups don't show board ranks or today's top games. The work is in worker/lookup.js.
const FREE_LOOKUPS = 5;
async function lookupApi(request, env, url, ctx) {
  const s = await session(request, env);
  let who, free = false;
  if (s) {
    who = s.email;
    free = s.until <= Date.now();
  } else {
    const t = await readTrial(request, env);
    if (!t || !t.active) return json({ error: "account", max: FREE_LOOKUPS }, 401);
    who = passWho(t.start);
  }
  const examples = url.searchParams.has("examples");
  if (!free) return lookup(env, url, (g) => { if (!examples) track(env, ctx, "lookup", who, String(g.name || "").slice(0, 120) + " u " + g.uid); });

  const today = new Date().toISOString().slice(0, 10);
  const used = examples ? [] : (await call(env, "free-used", { who, day: today })).uids || [];
  return lookup(env, url, (g, body) => {
    if (!used.includes(g.uid)) {
      used.push(g.uid);
      const p = call(env, "free-add", { who, day: today, uid: g.uid }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    }
    body.free = { left: Math.max(0, FREE_LOOKUPS - used.length), max: FREE_LOOKUPS };
    track(env, ctx, "lookup", who, String(g.name || "").slice(0, 120) + " u " + g.uid, "free plan");
  }, { free: true, max: FREE_LOOKUPS, allow: (uid) => used.length < FREE_LOOKUPS || used.includes(uid) });
}

// ---------- verified leads ----------
//
// A lead is a game whose owner has told us they'd sell. It moves through LEAD_STATUSES on the admin
// page; once we've seen the owner's own Creator Dashboard and they've agreed we can share their
// contact, it's "verified" and can be sent to buyers whose buy box it fits. Buyers see only the
// leads sent to them, on /leads.

const GENRES = ["Action", "Adventure", "Entertainment", "Obby & Platformer", "Party & Casual", "Puzzle", "Roleplay & Avatar Sim", "RPG", "Shooter", "Shopping", "Simulation", "Social", "Sports & Racing", "Strategy", "Survival"];
const LEAD_STATUSES = { found: "Found", asked: "Asked the owner", willing: "Owner would sell", verified: "Verified", declined: "Not selling", sold: "Sold" };
const PICK_STATUSES = ["new", "interested", "talking", "passed", "bought"];
const PICK_LABELS = { new: "New", interested: "Interested", talking: "Talking to the owner", passed: "Passed", bought: "Bought it" };
// The daily run adds at most this many new games per buyer, and in total, so the list stays workable.
// Suggestions nobody has touched after AUTO_KEEP_DAYS are cleared out.
const AUTO_PER_BUYER = 3;
const AUTO_TOTAL = 15;
const AUTO_KEEP_DAYS = 14;
const DEALS = { either: "All or part", all: "All of it", part: "Part of it", unsure: "Not sure yet" };
const AGES = { unknown: "Not confirmed yet", adult: "18 or older", guardian: "Under 18, with a parent or guardian involved" };
const ROLES = ["Owner", "Co-owner", "Group admin", "Developer on the team"];

const posInt = (v, max) => {
  const n = Math.round(Number(String(v == null ? "" : v).replace(/[,$\s]/g, "")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
};

function cleanBox(b) {
  const genres = Array.isArray(b.genres) ? b.genres.filter((g) => GENRES.includes(g)) : [];
  return {
    genres: Array.from(new Set(genres)),
    minPlayers: posInt(b.minPlayers, 1e7),
    maxPlayers: posInt(b.maxPlayers, 1e7),
    maxVisits: posInt(b.maxVisits, 1e11),
    maxAgeDays: posInt(b.maxAgeDays, 5000),
    minRevenue: posInt(b.minRevenue, 1e9),
    maxPrice: posInt(b.maxPrice, 1e10),
    deal: DEALS[b.deal] ? b.deal : "either",
    avoid: String(b.avoid || "").trim().slice(0, 300),
    notes: String(b.notes || "").trim().slice(0, 1000),
  };
}

async function buybox(request, env) {
  const s = await session(request, env);
  if (!s) return json({ error: "signin" }, 401);
  if (request.method === "GET") return json(await call(env, "buybox-get", { email: s.email }));
  if (request.method !== "POST") return json({ error: "method" }, 405);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad" }, 400); }
  b = b || {};
  // { alerts: true | false } on its own is the Leads page's email switch, and leaves the box alone.
  const onlyAlerts = typeof b.alerts === "boolean" && Object.keys(b).length === 1;
  return json(await call(env, "buybox-set", { email: s.email, box: onlyAlerts ? null : JSON.stringify(cleanBox(b)), alerts: typeof b.alerts === "boolean" ? b.alerts : undefined }));
}

// The board's game finder: someone asked for matches, or opened a first message to an owner. Only
// visitors who can see the board (an account with access, or a free pass that's running) are
// recorded, under the same name as their other activity.
const FIND_SIZES = { any: "any size", seed: "under 3K players", break: "3K to 10K players", chart: "10K+ players" };
async function findApi(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (isBot(request)) return json({ ok: true });
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad" }, 400); }
  b = b || {};
  const s = await session(request, env);
  let who = null;
  if (s && s.until > Date.now()) who = s.email;
  else if (!s) { const t = await readTrial(request, env); if (t && t.active) who = passWho(t.start); }
  if (!who) return json({ error: "access" }, 403);
  if (b.kind === "draft") {
    const pid = posInt(b.pid, Number.MAX_SAFE_INTEGER);
    if (!pid) return json({ error: "bad" }, 400);
    track(env, ctx, "draft", who, "game pid " + pid);
    return json({ ok: true });
  }
  if (b.kind !== "find") return json({ error: "bad" }, 400);
  const genres = Array.isArray(b.genres) ? Array.from(new Set(b.genres.filter((g) => GENRES.includes(g)))) : [];
  const budget = posInt(b.budget, 1e9);
  const parts = [genres.length ? genres.join(", ") : "any genre", FIND_SIZES[b.size] || "any size", budget ? "up to $" + Math.round(budget / 1000) + "K" : "no price limit"];
  if (b.skipWave === true) parts.push("no trend games");
  const n = Math.max(0, Math.min(500, Math.round(Number(b.matches) || 0)));
  track(env, ctx, "find", who, parts.join("; "), n ? n + (n === 1 ? " match" : " matches") : "no exact match");
  return json({ ok: true });
}

async function myLeads(request, env) {
  const s = await session(request, env);
  if (!s) return json({ error: "signin" }, 401);
  if (request.method === "GET") return json(await call(env, "my-leads", { email: s.email }));
  if (request.method !== "POST") return json({ error: "method" }, 405);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad" }, 400); }
  const id = posInt(b && b.id, Number.MAX_SAFE_INTEGER);
  if (!id) return json({ error: "bad" }, 400);
  const row = { email: s.email, id };
  if (b.status != null) { if (!PICK_STATUSES.includes(b.status)) return json({ error: "bad" }, 400); row.status = b.status; }
  if (b.note != null) row.note = String(b.note).slice(0, 2000);
  const r = await call(env, "my-lead-update", row);
  return json(r, r.error ? 404 : 200);
}

// A page that needs a signed-in account but not current access.
async function signedIn(request, env, url, assetPath) {
  const s = await session(request, env);
  if (!s) return redirect("/signin?next=" + assetPath);
  const asset = await env.ASSETS.fetch(new Request(new URL(assetPath, url), { headers: request.headers }));
  const res = new Response(asset.body, asset);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
}

// "https://www.roblox.com/games/123/Name", "roblox.com/games/123", "...?placeId=123" or just "123".
function placeIdFrom(text) {
  const t = String(text || "").trim();
  const m = /roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{3,19})/i.exec(t) || /[?&]placeId=(\d{3,19})/i.exec(t) || /^(\d{3,19})$/.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

const ROBLOX = { headers: { Accept: "application/json" } };
const withTimeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});

async function placeToUniverse(pid) {
  const r = await fetch("https://apis.roblox.com/universes/v1/places/" + pid + "/universe", Object.assign({}, ROBLOX, withTimeout(8000)));
  if (r.status === 400 || r.status === 404) return 0;
  if (!r.ok) throw new Error("roblox " + r.status);
  const j = await r.json();
  return Number(j && j.universeId) || 0;
}

// Name, place, players, visits, launch date and current owner for up to a few hundred games.
async function robloxGames(uids) {
  const out = {};
  const ids = Array.from(new Set(uids.filter((n) => Number.isSafeInteger(n) && n > 0)));
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const r = await fetch("https://games.roblox.com/v1/games?universeIds=" + chunk.join(","), Object.assign({}, ROBLOX, withTimeout(8000)));
      if (!r.ok) continue;
      const j = await r.json();
      for (const x of j.data || []) {
        const c = x.creator || {};
        out[x.id] = { name: x.name, pid: x.rootPlaceId, players: x.playing, visits: x.visits, created: x.created, creator: { id: c.id, name: c.name, type: c.type } };
      }
    } catch (e) { /* leave these out; callers show what they have */ }
  }
  return out;
}

// The Roblox account that actually controls a game: the creator itself for a solo game, or the
// group's owner. Roblox shows Discord and X links only to signed-in visitors, so this is the most
// we can look up on our own.
async function ownerOf(type, id, name) {
  if (!id) return null;
  if (type === "User") return { id: Number(id), name: String(name || "") };
  try {
    const r = await fetch("https://groups.roblox.com/v1/groups/" + id, Object.assign({}, ROBLOX, withTimeout(8000)));
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.owner ? { id: Number(j.owner.userId), name: String(j.owner.username || "") } : null;
  } catch (e) {
    return null;
  }
}

// The public form for owners who'd consider selling. It saves what they send as a lead with
// status "Owner would sell"; nothing is shared with a buyer until we've checked it and they say yes.
async function sellForm(request, env) {
  if (request.method !== "POST") return redirect("/sell");
  const form = await request.formData();
  const get = (k) => String(form.get(k) || "").trim();
  // The page sends the form in the background and asks for JSON, so a mistake keeps what they typed.
  // Without JavaScript it's a normal form post, answered with a redirect.
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  const back = (code) => (wantsJson ? json({ error: code }, 400) : redirect("/sell?e=" + code + "#offer"));
  const done = () => (wantsJson ? json({ ok: true }) : redirect("/sell?sent=1#offer"));
  if (get("website")) return done();

  const pid = placeIdFrom(get("link"));
  const contact = get("contact").slice(0, 200);
  const role = ROLES.includes(get("role")) ? get("role") : "Owner";
  const deal = DEALS[get("deal")] ? get("deal") : "unsure";
  const asking = get("asking").slice(0, 80);
  const notes = get("notes").slice(0, 1500);
  const age = get("age") === "adult" || get("age") === "guardian" ? get("age") : "";
  if (!pid) return back("link");
  if (!contact) return back("contact");
  if (!age) return back("age");
  if (get("agree") !== "yes") return back("agree");

  let uid;
  try { uid = await placeToUniverse(pid); } catch (e) { return back("roblox"); }
  if (!uid) return back("game");
  const info = (await robloxGames([uid]))[uid] || {};
  const c = info.creator || {};
  const owner = await ownerOf(c.type, c.id, c.name);
  const name = String(info.name || "").slice(0, 120);
  const token = randomToken(), code = verifyCode();
  const r = await call(env, "offer", {
    uid, pid: info.pid || pid, name, creator: String(c.name || "").slice(0, 120), ctype: c.type || null, cid: Number(c.id) || null,
    owner_user: owner ? owner.name : null, owner_user_id: owner ? owner.id : null,
    contact, age, deal, asking: asking ? asking : "",
    offer: JSON.stringify({ contact, role, deal, asking, notes, age }),
    token, code,
  });
  if (r.limited) return back("busy");
  // Sent for this game in the last 10 minutes already: no second link.
  if (!r.fresh) return wantsJson ? json({ ok: true, recent: true }) : redirect("/sell?sent=1#offer");
  const origin = new URL(request.url).origin;
  const mine = origin + "/sell#t=" + token;
  const link = origin + "/admin/leads?id=" + r.id + "#lead-" + r.id;
  await sendEmail(env, {
    to: OWNER_EMAIL,
    subject: "Open to selling: " + (name || "a Roblox game"),
    text: "Someone filled in the selling form.\n\nGame: " + (name || "Unknown") + " (" + gameUrl(info.pid || pid) + ")\nPlayers now: " + commas(info.players) + "\nContact: " + contact + "\nRole: " + role + "\nWould sell: " + DEALS[deal] + "\nAsking: " + (asking || "Not given") + "\nAge: " + AGES[age] + "\nNotes: " + (notes || "None") + "\n\nWe've asked them to put " + code + " in the game's description to show it's theirs, then add a screenshot or recording of their Creator Dashboard on the page. You'll get an email when each one comes in. Their lead:\n" + link,
  });
  // An owner who gave an email gets their link and code too, so closing the page doesn't lose them.
  if (validEmail(contact.toLowerCase())) {
    await sendEmail(env, {
      to: contact,
      subject: "Show " + (name || "your game") + " is yours: your Spawnbook code",
      text: ["Hi,", "", "Thanks for telling us about " + (name || "your game") + ". Buyers only see games whose owner we've confirmed, so there are two quick steps:", "",
        "1. Put this code anywhere in your game's description on Roblox and save: " + code, "   You can take it out again once we've seen it.",
        "2. Add a screenshot (or a short screen recording) of your Creator Dashboard showing the last 30 days of Robux and players. You upload it right on the page.", "",
        "Do both from your private link: " + mine, "",
        "We only pass your contact and numbers to a buyer after you say yes. If you didn't fill in our form, ignore this email.", "",
        "Gautam Prasanna", "Spawnbook, spawnbook.com"].join("\n"),
    });
  }
  return wantsJson ? json({ ok: true, t: token, code }) : redirect("/sell?sent=1#t=" + token);
}

// Owners' uploads: screen recordings and screenshots, sent from the browser in 1 MB pieces.
const FILE_CHUNK = 1024 * 1024;
// Cloudflare's free plan allows 1 GB per object and 5 GB across the account, so keep uploads modest.
const FILE_MAX = 150 * 1024 * 1024;       // one file
const FILE_MAX_TOTAL = 250 * 1024 * 1024; // all of one lead's files
const FILE_MAX_COUNT = 8;
const FILE_TYPES = /^(video\/(mp4|quicktime|webm|x-matroska|3gpp|x-msvideo|mpeg)|image\/(png|jpeg|webp|gif|heic|heif))$/;

// An uploaded file, read back in its pieces. Open to the admin, and to a buyer the lead was sent to
// once it's verified; anyone else gets a plain 404. Ranges work, so videos play and seek in Safari.
async function fileApi(request, env, url) {
  const nope = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const f = Number(url.searchParams.get("f"));
  if (request.method !== "GET" && request.method !== "HEAD") return nope();
  if (!Number.isSafeInteger(f) || f <= 0) return nope();
  const admin = await isAdmin(request, env);
  const s = admin ? null : await session(request, env);
  const { file, sent } = await call(env, "file-meta", { f, email: s ? s.email : null });
  if (!file || !file.done || !FILE_TYPES.test(file.type)) return nope();
  if (!admin && !(s && sent && file.lead_status === "verified")) return nope();
  const size = file.size;
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (m && (m[1] || m[2])) {
    if (m[1] === "") start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    status = 206;
  }
  const headers = {
    "Content-Type": file.type, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes",
    "Content-Disposition": "inline; filename=\"" + String(file.name).replace(/[^\w.\- ]/g, "_") + "\"",
    "Cache-Control": "private, no-store",
  };
  if (status === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const st = filesStub(env, file.lead_id);
  let i = Math.floor(start / FILE_CHUNK);
  const last = Math.floor(end / FILE_CHUNK);
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i > last) { ctrl.close(); return; }
      const r = await st.fetch("https://store/file-read?f=" + f + "&i=" + i);
      if (!r.ok) { ctrl.error(new Error("missing piece")); return; }
      const buf = new Uint8Array(await r.arrayBuffer());
      const base = i * FILE_CHUNK;
      ctrl.enqueue(buf.subarray(Math.max(start - base, 0), Math.min(end - base + 1, buf.length)));
      i++;
    },
  });
  return new Response(body, { status, headers });
}

// A code for an owner to paste into their game's description. Letters only, without ones that pass
// for digits, so Roblox's text filter doesn't turn it into ####.
function verifyCode() {
  const A = "ACDEFGHJKMNPQRTUVWXY";
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return "SB-" + Array.from(b, (x) => A[x % A.length]).join("");
}
const codeIn = (text, code) => String(text || "").toUpperCase().replace(/[^A-Z]/g, "").includes(String(code || "").toUpperCase().replace(/[^A-Z]/g, ""));

// The owner's private steps after the form: check the code, then send the recording.
async function sellSteps(request, env, url, path) {
  // A piece of an upload: raw bytes, with the link and file in the address.
  if (path === "/api/sell/upload/chunk") {
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const t = url.searchParams.get("t") || "", f = url.searchParams.get("f") || "", i = url.searchParams.get("i") || "";
    if (!/^[0-9a-f]{64}$/.test(t) || !/^\d{1,9}$/.test(f) || !/^\d{1,4}$/.test(i)) return json({ error: "file" }, 400);
    if (Number(request.headers.get("Content-Length") || 0) > FILE_CHUNK) return json({ error: "size" }, 413);
    const okd = await call(env, "file-ok", { token: t, f: Number(f), i: Number(i) });
    if (!okd.lead_id) return json({ error: "file" }, 400);
    const r = await filesStub(env, okd.lead_id).fetch("https://store/file-put?f=" + f + "&i=" + i, { method: "POST", body: await request.arrayBuffer() });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  let b = {};
  if (request.method === "POST") b = await request.json().catch(() => ({}));
  const t = String(request.method === "POST" ? b.t || "" : url.searchParams.get("t") || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return json({ error: "link" }, 404);
  const { lead } = await call(env, "seller-get", { token: t });
  if (!lead) return json({ error: "link" }, 404);
  const state = (extra) => json(Object.assign({ name: lead.name, pid: lead.pid, code: lead.verify_code, confirmed: lead.owner_verified_at || null, proof: !!(lead.proof && lead.proof_at), proofAt: lead.proof_at || null }, extra || {}));
  if (path === "/api/sell/status" && request.method === "GET") return state();
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const origin = url.origin;
  const adminLink = origin + "/admin/leads?id=" + lead.id + "#lead-" + lead.id;

  if (path === "/api/sell/check") {
    if (lead.owner_verified_at) return state();
    if (lead.check_at && Date.now() - lead.check_at < 10e3) return state({ error: "wait" });
    let g = null;
    try {
      const r = await fetch("https://games.roblox.com/v1/games?universeIds=" + Number(lead.uid), Object.assign({}, ROBLOX, withTimeout(8000)));
      if (r.ok) g = ((await r.json()).data || [])[0] || null;
    } catch (e) { g = null; }
    if (!g) { await call(env, "seller-checked", { token: t, found: false }); return state({ error: "roblox" }); }
    // The code only counts while the game has the owner it had when they filled in the form.
    if (lead.creator_id && g.creator && Number(g.creator.id) !== Number(lead.creator_id)) { await call(env, "seller-checked", { token: t, found: false }); return state({ error: "owner" }); }
    const found = codeIn(g.description, lead.verify_code);
    const r = await call(env, "seller-checked", { token: t, found });
    if (!found) return state({ error: "missing" });
    await sendEmail(env, { to: OWNER_EMAIL, subject: "Owner confirmed: " + (lead.name || "a game"), text: "The owner of " + (lead.name || "a game") + " (" + gameUrl(lead.pid) + ") put " + lead.verify_code + " in its description, so whoever filled in the form controls the game on Roblox.\n\nNext they'll send their Creator Dashboard recording. Their lead:\n" + adminLink });
    return json({ name: lead.name, pid: lead.pid, code: lead.verify_code, confirmed: r.at, proof: !!(lead.proof && lead.proof_at), proofAt: lead.proof_at || null });
  }

  if (path === "/api/sell/upload/start") {
    const name = String(b.name || "file").replace(/[\u0000-\u001f"\\/]/g, "").slice(0, 120) || "file";
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(name) || [])[1];
    const byExt = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", "3gp": "video/3gpp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
    const type = FILE_TYPES.test(String(b.type || "")) ? String(b.type) : byExt[String(ext || "").toLowerCase()] || "";
    const size = Number(b.size);
    if (!type) return state({ error: "type" });
    if (!Number.isSafeInteger(size) || size <= 0) return state({ error: "type" });
    if (size > FILE_MAX) return state({ error: "big" });
    const r = await call(env, "file-start", { token: t, name, type, size });
    if (r.error) return state({ error: r.error });
    return json({ f: r.f, chunk: FILE_CHUNK });
  }

  if (path === "/api/sell/upload/done") {
    const f = Number(b.f);
    if (!Number.isSafeInteger(f) || f <= 0) return state({ error: "file" });
    const { lead_id } = await call(env, "file-lead", { token: t, f });
    if (!lead_id) return state({ error: "file" });
    const got = await filesCall(env, lead_id, "file-count", { f });
    const r = await call(env, "file-done", { token: t, f, link: origin + "/api/file?f=" + f, got: { n: Number(got.n), bytes: Number(got.bytes) } });
    if (r.error) return state({ error: r.error });
    // One email for the batch, when the page sends its last file.
    if (b.last) await sendEmail(env, { to: OWNER_EMAIL, subject: "Dashboard files: " + (lead.name || "a game"), text: "The confirmed owner of " + (lead.name || "a game") + " uploaded " + (r.files === 1 ? "a file" : r.files + " files") + " from their Creator Dashboard.\n\nOpen them on their lead, check Robux and players against the public numbers, fill in what you checked and mark it Verified:\n" + adminLink });
    return json({ name: lead.name, pid: lead.pid, code: lead.verify_code, confirmed: lead.owner_verified_at, proof: true, proofAt: Date.now(), files: r.files });
  }

  if (path === "/api/sell/proof") {
    if (!lead.owner_verified_at) return state({ error: "first" });
    const link = String(b.url || "").trim();
    let u = null;
    try { u = new URL(link); } catch (e) { u = null; }
    if (!u || u.protocol !== "https:" || link.length > 500) return state({ error: "url" });
    await call(env, "seller-proof", { token: t, url: link });
    await sendEmail(env, { to: OWNER_EMAIL, subject: "Dashboard recording: " + (lead.name || "a game"), text: "The confirmed owner of " + (lead.name || "a game") + " sent their Creator Dashboard recording:\n" + link + "\n\nWatch it, check Robux and players against the public numbers, fill in what you checked and mark it Verified:\n" + adminLink });
    return json({ name: lead.name, pid: lead.pid, code: lead.verify_code, confirmed: lead.owner_verified_at, proof: true, proofAt: Date.now() });
  }
  return json({ error: "path" }, 404);
}

// ---------- the board ----------

async function gated(request, env, url, assetPath, ctx) {
  const s = await session(request, env);
  const isData = assetPath.endsWith(".js");
  let passStart = null;
  const shut = (to) => (isData
    ? new Response("/* Open spawnbook.com to see today's board. */\n", { status: 401, headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } })
    : redirect(to));
  let setCookie = null;
  // The lookup page stays open after access ends: it offers the free plan instead.
  const freeOk = assetPath === "/lookup";
  if (s) {
    // An account decides on its own: a used-up account doesn't get a new free pass.
    if (s.until <= Date.now() && !freeOk) return shut("/subscribe");
  } else {
    const t = await readTrial(request, env);
    if (t && !t.active && !freeOk) return shut("/subscribe?over=1");
    if (t) passStart = t.start;
    else {
      // No account and no pass yet: opening a board page starts the free 24 hours.
      if (isData) return shut("/");
      passStart = Date.now();
      setCookie = await trialCookie(env, passStart);
    }
  }
  if (!isData && !isBot(request)) {
    const page = assetPath.slice(1);
    const id = page === "game" ? (url.searchParams.get("pid") ? " pid " + url.searchParams.get("pid") : url.searchParams.get("u") ? " u " + url.searchParams.get("u") : "") : "";
    track(env, ctx, setCookie ? "pass" : "view", s ? s.email : passWho(passStart), page + id);
  }
  const asset = await env.ASSETS.fetch(new Request(new URL(assetPath, url), { headers: request.headers }));
  const res = new Response(asset.body, asset);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Robots-Tag", "noindex");
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

// Today's top pick, minus its name, so the landing page can show what's behind the sign-up.
async function teaser(env, url) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/data.js", url)));
  if (!asset.ok) return json({ top: null }, 200, "public, max-age=300");
  const text = await asset.text();
  const at = text.indexOf("window.BR =");
  if (at < 0) return json({ top: null }, 200, "public, max-age=300");
  const BR = JSON.parse(text.slice(at + "window.BR =".length).trim().replace(/;\s*$/, ""));
  const board = (BR.BOARD || []).slice().sort((a, b) => b[24] - a[24] || b[7] - a[7]);
  const top = board[0];
  return json({
    date: BR.META && BR.META.snapshot,
    count: board.length,
    top: top ? { score: top[24], age: top[6], players: top[7], visitsPerDay: top[8] } : null,
  }, 200, "public, max-age=300");
}

// ---------- admin ----------

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(title, body, script) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Spawnbook</title><link rel="stylesheet" href="/site.css"><style>
.admin-nav { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; font-weight: 600; }
.admin-nav [aria-current] { text-decoration: none; }
.admin h3 { margin-top: 0.75rem; }
.admin .steps { display: grid; gap: 0.4rem; padding-left: 1.25rem; max-width: 72ch; list-style: decimal; }
.admin .table-box .button.quiet, .admin details.lead-row .button.quiet, .admin .today .button.quiet { background: var(--bg); }
.admin .msg { background: var(--pale); padding: 0.8rem 1rem; font-weight: 600; margin: 0; }
.admin .today { background: var(--surface); padding: 1rem 1.25rem; display: grid; gap: 0.75rem; }
.admin .today h3 { margin-top: 0.25rem; font-size: var(--step-body); }
.admin ul.dlist { display: grid; gap: 0.3rem; padding-left: 1.25rem; list-style: disc; font-size: var(--step-small); }
.admin .flag { background: var(--accent); color: var(--accent-ink); padding: 0.05rem 0.4rem; font-weight: 600; }
.admin details.lead-row { background: var(--surface); padding: 0.9rem 1.1rem; }
.admin details.lead-row + details.lead-row { margin-top: 0.5rem; }
.admin details.lead-row > summary { cursor: pointer; font-weight: 600; }
.admin details.lead-row > summary .l-meta { display: block; font-weight: 400; color: var(--muted); font-size: var(--step-small); }
.admin .l-body { display: grid; gap: 1.25rem; margin-top: 1rem; }
.admin .l-body .form { background: var(--bg); margin: 0; }
.admin .l-body h4 { font-size: var(--step-body); }
.admin .offer dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.25rem 1rem; font-size: var(--step-small); }
.admin .offer dt { font-weight: 600; }
.admin ul.sends { display: grid; gap: 0.5rem; font-size: var(--step-small); }
.admin select { min-height: 2.5rem; padding: 0 0.5rem; border: 2px solid var(--field); background: var(--bg); max-width: 100%; }
.admin .sub { display: block; color: var(--muted); }
.admin { padding-block: 2rem 4rem; display: grid; gap: 1.5rem; grid-template-columns: minmax(0, 1fr); }
.admin > *, .admin .l-body > * { min-width: 0; }
.admin table { font-size: var(--step-small); }
.admin td, .admin th { padding: 0.6rem 0.75rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--surface-2); }
.admin form.inline { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.admin input[type=number] { width: 4.5rem; min-height: 2.5rem; padding: 0 0.5rem; border: 2px solid var(--field); background: var(--bg); }
.admin .button { min-height: 2.5rem; padding: 0 1rem; }
.admin input[type=password] { min-height: 3rem; padding: 0 0.75rem; border: 2px solid var(--field); background: var(--bg); width: min(100%, 22rem); }
.admin .add { max-width: 48rem; }
.admin .two { display: grid; gap: 1.5rem 2.5rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); }
.admin .two h2 { margin-bottom: 0.75rem; }
.admin .linkbox { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--step-small); background: var(--surface); padding: 1rem; overflow-wrap: anywhere; user-select: all; }
</style></head><body><main class="wrap admin">${body}</main>${script ? "<script>" + script + "</script>" : ""}</body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

async function isAdmin(request, env) {
  const c = readCookie(request, ADMIN_COOKIE);
  return !!c && c === (await sha256("spawnbook-admin:" + env.ADMIN_KEY));
}

// Makes a one-time password link for an account and shows it once, for the admin to send.
async function linkPage(env, url, email, intro) {
  const t = randomToken();
  const r = await call(env, "make-link", { email, linkHash: await sha256(t), expires: Date.now() + LINK_MS });
  if (!r.ok) return page("No such account", `<h1 class="head">No such account</h1><p>There's no account for ${esc(email)}.</p><p><a class="button quiet" href="/admin">Back to accounts</a></p>`);
  const link = url.origin + "/account#t=" + t;
  return page("Password link", `<h1 class="head">Password link</h1><p>${intro}</p><p>Send this link to <strong>${esc(email)}</strong>. It works once, for 7 days, and lets them choose their own password. It won't be shown again, so copy it now.</p><p class="linkbox">${esc(link)}</p><p><a class="button" href="mailto:${esc(email)}?subject=${encodeURIComponent("Your Spawnbook sign-in")}&body=${encodeURIComponent("Hi,\n\nUse this link to choose your password for Spawnbook. It works once, for the next 7 days:\n\n" + link + "\n\nAfter that, sign in any time at " + url.origin + "/signin with your email and that password.\n\nGautam")}">Email it to them</a> <a class="button quiet" href="/admin">Back to accounts</a></p>`);
}

async function admin(request, env, url, path) {
  if (!env.ADMIN_KEY) {
    return page("Admin", `<h1 class="head">Admin is off</h1><p>To turn this page on, add a secret named ADMIN_KEY to the spawnbook Worker in Cloudflare (Settings, then Variables and Secrets). Its value is the password for this page.</p>`);
  }

  if (path === "/admin/login" && request.method === "POST") {
    const form = await request.formData();
    const given = String(form.get("key") || "");
    const ok = (await sha256("spawnbook-admin:" + given)) === (await sha256("spawnbook-admin:" + env.ADMIN_KEY));
    if (!ok) return redirect("/admin?bad=1");
    const cookie = ADMIN_COOKIE + "=" + (await sha256("spawnbook-admin:" + env.ADMIN_KEY)) + "; Path=/admin; Max-Age=" + 7 * 24 * 60 * 60 + "; HttpOnly; Secure; SameSite=Strict";
    return redirect("/admin", { "Set-Cookie": cookie });
  }

  if (!(await isAdmin(request, env))) {
    const bad = url.searchParams.get("bad") ? `<p class="err" role="alert">That password didn't match.</p>` : "";
    return page("Admin sign-in", `<h1 class="head">Accounts</h1><form method="post" action="/admin/login" class="stack"><label for="k">Admin password</label><input type="password" id="k" name="key" autocomplete="current-password" required><div><button class="button" type="submit">Sign in</button></div>${bad}</form>`);
  }

  if (path === "/admin/leads" || path.startsWith("/admin/leads/")) return adminLeads(request, env, url, path);
  if (path === "/admin/activity" || path === "/admin/picks/send" || path === "/admin/alerts/send") return adminActivity(request, env, url, path);

  if (path === "/admin/access" && request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").toLowerCase();
    const days = Math.max(0, Math.min(3660, Number(form.get("days")) || 0));
    await call(env, "access", { email, until: Date.now() + days * DAY_MS });
    return redirect("/admin");
  }

  if (path === "/admin/paid" && request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").toLowerCase();
    const r = await call(env, "paid", { email, days: PAID_DAYS, referralDays: REFERRAL_DAYS });
    if (!r.ok) return page("No such account", `<h1 class="head">No such account</h1><p>There's no account for ${esc(email)}.</p><p><a class="button quiet" href="/admin">Back to accounts</a></p>`);
    const day = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" });
    let msg = `<p>Recorded a payment for <strong>${esc(email)}</strong>. Their access now runs until ${esc(day(r.until))}.</p>`;
    if (r.credited) msg += `<p><strong>${esc(r.credited.email)}</strong> referred them, and this was their first payment, so ${esc(r.credited.email)} got a free month: their access now runs until ${esc(day(r.credited.until))}. If they pay monthly, skip their next charge.</p>`;
    else if (r.referredBy && r.alreadyCredited) msg += `<p>They were referred by ${esc(r.referredBy)}, who already got their free month for this person.</p>`;
    else if (r.referredBy) msg += `<p>They were referred by ${esc(r.referredBy)}, but that account no longer exists, so no free month was given.</p>`;
    return page("Payment recorded", `<h1 class="head">Payment recorded</h1>${msg}<p><a class="button quiet" href="/admin">Back to accounts</a></p>`);
  }

  if (path === "/admin/delete" && request.method === "POST") {
    const form = await request.formData();
    await call(env, "delete", { email: String(form.get("email") || "").toLowerCase() });
    return redirect("/admin");
  }

  if (path === "/admin/link" && request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").toLowerCase();
    return linkPage(env, url, email, "This replaces any earlier link for this account. Their current password keeps working until they use it.");
  }

  if (path === "/admin/create" && request.method === "POST") {
    const form = await request.formData();
    const get = (k) => String(form.get(k) || "").trim();
    const email = get("email").toLowerCase().slice(0, 200);
    const name = get("name").slice(0, 120);
    const company = get("company").slice(0, 160);
    const days = Math.max(0, Math.min(3660, Number(get("days")) || 0));
    if (!validEmail(email) || !name || !company) return redirect("/admin?add=bad");
    const r = await call(env, "create", { email, name, company, role: "Added by Spawnbook", until: Date.now() + days * DAY_MS });
    return linkPage(env, url, email, r.existed ? "That email already had an account, so its access is now " + days + " days from today." : "The account is made, with " + days + " days of access.");
  }

  const { rows, credits } = await call(env, "list", {});

  if (path === "/admin/signups.csv") {
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const iso = (t) => (t ? new Date(t).toISOString() : "");
    const lines = [["signed_up", "name", "email", "studio_or_fund", "role", "access_until", "last_seen", "has_password", "referred_by", "first_paid"].join(",")]
      .concat(rows.map((r) => [iso(r.created_at), r.name, r.email, r.company, r.role, iso(r.access_until), iso(r.last_seen), r.has_pw ? "yes" : "no", r.referred_by || "", iso(r.paid_at)].map(cell).join(",")));
    return new Response(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="spawnbook-signups.csv"', "Cache-Control": "no-store" },
    });
  }

  const now = Date.now();
  const when = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const body = rows.map((r) => {
    const status = r.access_until > now ? "Until " + when(r.access_until) : "Ended " + when(r.access_until);
    const id = esc(r.email);
    const paid = r.paid_at ? "First paid " + new Date(r.paid_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }) : "Not yet";
    return `<tr><td>${esc(when(r.created_at))}</td><td>${esc(r.name)}</td><td><a class="link" href="mailto:${id}">${id}</a></td><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(status)}</td><td>${r.has_pw ? "Set" : "Not set"}</td><td>${r.referred_by ? esc(r.referred_by) + (r.ref_credited ? " (free month given)" : "") : ""}</td><td>${esc(paid)}</td>
<td><form class="inline" method="post" action="/admin/paid"><input type="hidden" name="email" value="${id}"><button class="button" type="submit">Record a payment</button></form></td>
<td><form class="inline" method="post" action="/admin/access"><input type="hidden" name="email" value="${id}"><label class="sr-only" for="d-${id}">Days of access for ${id}</label><input type="number" min="0" max="3660" id="d-${id}" name="days" value="31"><button class="button quiet" type="submit">Set days from now</button></form></td>
<td><form class="inline" method="post" action="/admin/link"><input type="hidden" name="email" value="${id}"><button class="button quiet" type="submit">Make a link</button></form></td>
<td><form class="inline" method="post" action="/admin/delete"><input type="hidden" name="email" value="${id}"><button class="button quiet" type="submit">Delete</button></form></td></tr>`;
  }).join("");
  const table = rows.length
    ? `<div class="table-box"><table><thead><tr><th>Signed up (Pacific)</th><th>Name</th><th>Email</th><th>Studio or fund</th><th>Role</th><th>Access</th><th>Password</th><th>Referred by</th><th>Paid</th><th>Payment</th><th>Set access</th><th>Password link</th><th>Remove</th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<p>No accounts yet.</p>`;
  const addErr = url.searchParams.get("add") === "bad" ? `<p class="err" role="alert">Fill in a name, a valid email and a studio or fund.</p>` : "";
  const add = `<form class="form add" method="post" action="/admin/create"><h2>Add an account</h2><p class="small muted">For a subscriber who pays before signing up. You'll get a link to send them so they can choose a password.</p><div class="fields">
<div class="field"><label for="a-name">Name</label><input id="a-name" name="name" maxlength="120" required></div>
<div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" maxlength="200" required></div>
<div class="field"><label for="a-co">Studio or fund</label><input id="a-co" name="company" maxlength="160" required></div>
<div class="field"><label for="a-days">Days of access</label><input id="a-days" name="days" type="number" min="0" max="3660" value="31"></div>
</div><div class="form-row"><button class="button" type="submit">Add account</button></div>${addErr}</form>`;
  const creditList = credits && credits.length
    ? `<h2>Free months given for referrals</h2><ul>${credits.map((c) => `<li>${esc(when(c.at))}: ${esc(c.referrer)} referred ${esc(c.referred)}, ${c.days} days added</li>`).join("")}</ul>`
    : "";
  return page("Accounts", `${adminNav("accounts")}<h1 class="head">Accounts</h1><p>${rows.length} ${rows.length === 1 ? "account" : "accounts"}. When someone pays, click <strong>Record a payment</strong>: it adds ${PAID_DAYS} days to their access, and on their first payment, whoever referred them gets a free month (${REFERRAL_DAYS} days) automatically. Use <strong>Set days from now</strong> to correct someone's access, or 0 to end it. If someone forgets their password, make a link and send it to them. Delete removes a person completely, for example when they ask you to delete their data.</p><p><a class="button quiet" href="/admin/signups.csv">Download as a spreadsheet (CSV)</a></p>${table}${creditList}${add}`);
}

// ---------- admin: activity ----------
const ACT_TYPES = ["visit", "page", "pass", "view", "lookup", "find", "draft", "signup", "email", "discord"];
async function adminActivity(request, env, url, path) {
  if (path === "/admin/picks/send" && request.method === "POST") {
    const r = await sendDailyPicks(env, url.origin);
    const msg = r.skipped ? r.skipped : "Sent " + r.date + "'s top 5: " + r.discord + " Discord " + (r.discord === 1 ? "channel" : "channels") + (r.discordFailed ? " (" + r.discordFailed + " failed)" : "") + ", " + (r.emailsOff ? "no emails (Resend isn't connected yet)" : r.emails + " " + (r.emails === 1 ? "email" : "emails") + (r.emailError ? ", and some emails failed" : "")) + ".";
    return redirect("/admin/activity?sent=" + encodeURIComponent(msg) + "#picks");
  }
  if (path === "/admin/alerts/send" && request.method === "POST") {
    const r = await sendBoxAlerts(env, url.origin);
    const msg = r.off ? "No alerts sent: emails are off until Resend is connected." : r.skipped ? r.skipped : "Buy box alerts for " + r.date + ": " + r.emails + " " + (r.emails === 1 ? "email" : "emails") + " with " + r.games + " " + (r.games === 1 ? "game" : "games") + ", out of " + r.members + " " + (r.members === 1 ? "member" : "members") + " checked" + (r.emailError ? ". Some emails failed" : "") + ".";
    return redirect("/admin/activity?asent=" + encodeURIComponent(msg) + "#alerts");
  }
  const a = await call(env, "activity", { days: 14 });
  // Game names for game pages opened, from today's history file.
  const names = {};
  try {
    const h = await env.ASSETS.fetch(new Request(new URL("/history.js", url.origin)));
    const t = h.ok ? await h.text() : "";
    const at = t.indexOf("window.HX =");
    if (at >= 0) {
      const HX = JSON.parse(t.slice(at + 11).trim().replace(/;\s*$/, ""));
      for (const u of Object.keys(HX.games || {})) { names["u " + u] = HX.games[u][0]; names["pid " + HX.games[u][1]] = HX.games[u][0]; }
    }
  } catch (e) { /* names are a nicety */ }
  const gameName = (detail) => {
    const m = /^game ((?:pid|u) \d+)$/.exec(detail || "");
    if (m) return names[m[1]] ? cleanName(names[m[1]]) : "a game (" + m[1] + ")";
    const l = /^(.*) u (\d+)$/.exec(detail || "");
    return l ? cleanName(l[1]) : detail;
  };
  const when = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const day = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

  // Last 7 days at a glance.
  const wk = {};
  for (const r of a.week) wk[r.type] = r;
  const tile = (label, n, sub) => `<div class="tile"><dt>${esc(label)}</dt><dd>${commas(n)}</dd>${sub ? `<p class="tile-sub">${esc(sub)}</p>` : ""}</div>`;
  const tiles = `<dl class="tiles">${[
    tile("Home page visits", (wk.visit || {}).n || 0, "Not unique people: first-time visitors can't be told apart"),
    tile("Public game pages opened", (wk.page || {}).n || 0, commas((wk.page || {}).u || 0) + " visitors"),
    tile("Free passes started", (wk.pass || {}).u || 0),
    tile("People who opened the board", a.boardWeek),
    tile("Lookups", (wk.lookup || {}).n || 0, commas((wk.lookup || {}).u || 0) + " people"),
    tile("Used the game finder", (wk.find || {}).u || 0, commas((wk.find || {}).n || 0) + ((wk.find || {}).n === 1 ? " search" : " searches")),
    tile("Wrote a message to an owner", (wk.draft || {}).u || 0, commas((wk.draft || {}).n || 0) + ((wk.draft || {}).n === 1 ? " message opened" : " messages opened")),
    tile("Accounts made", (wk.signup || {}).n || 0),
    tile("Email sign-ups", (wk.email || {}).n || 0),
    tile("Discord connected", (wk.discord || {}).n || 0),
  ].join("")}</dl>`;

  // Day by day.
  const byDay = {};
  for (const r of a.daily) (byDay[r.day] = byDay[r.day] || {})[r.type] = r;
  for (const r of a.boardDaily) (byDay[r.day] = byDay[r.day] || {}).board = r.u;
  const days = Object.keys(byDay).sort().reverse();
  const cell = (d, t, key) => commas(((byDay[d] || {})[t] || {})[key || "n"] || 0);
  const dayRows = days.map((d) => `<tr><th scope="row">${esc(day(d))}</th><td>${cell(d, "visit")}</td><td>${cell(d, "page")}</td><td>${cell(d, "pass")}</td><td>${commas(byDay[d].board || 0)}</td><td>${cell(d, "lookup")}</td><td>${cell(d, "signup")}</td><td>${cell(d, "email")}</td></tr>`).join("");
  const dayTable = days.length
    ? `<div class="table-box"><table><thead><tr><th scope="col">Day (Pacific)</th><th scope="col">Home page visits</th><th scope="col">Game pages</th><th scope="col">Free passes</th><th scope="col">Opened the board</th><th scope="col">Lookups</th><th scope="col">Accounts</th><th scope="col">Email sign-ups</th></tr></thead><tbody>${dayRows}</tbody></table></div>`
    : `<p>Nothing yet. Activity starts recording from today.</p>`;

  // "via x" is a tagged link; the rest are referring sites. Visits with neither are counted too, since
  // that's where clicks from Discord, X and email apps land when the link has no tag.
  const TAGS = { x: "X", discord: "Discord", email: "email", form: "contact forms", reddit: "Reddit", devforum: "the DevForum", linkedin: "LinkedIn" };
  const sourceName = (s) => {
    if (!s) return "No source (typed in, a bookmark, or an untagged link opened in an app like Discord, X or Gmail)";
    const m = /^via ([a-z0-9_-]+)(.*)$/.exec(s);
    if (m) return "Your " + (TAGS[m[1]] || m[1]) + " links (?via=" + m[1] + ")" + m[2];
    return s === "t.co" ? "t.co (links on X)" : s;
  };
  const fromList = a.from.length ? `<ul class="dlist">${a.from.map((r) => `<li>${esc(sourceName(r.detail))}: ${commas(r.n)}</li>`).join("")}</ul>` : `<p class="small muted">No visits in the past week.</p>`;
  const taggedList = a.tagged.length
    ? `<ul class="dlist">${a.tagged.map((r) => `<li>${esc(sourceName(r.tag))}: ${commas(r.n)} ${r.n === 1 ? "visit" : "visits"}<span class="sub">Landed on ${esc(String(r.pages || "").split(",").join(", "))}</span></li>`).join("")}</ul>`
    : `<p class="small muted">No visits from tagged links yet.</p>`;
  const tagHelp = `<p class="small">Add <strong>?via=</strong> and a word to every link you share, so visits from apps that hide where they came from still show up here: spawnbook.com/?via=x on X, https://spawnbook.com/?via=discord on Discord (Discord only makes links clickable with https://), spawnbook.com/?via=email in emails. It works on any page, like spawnbook.com/trends?via=reddit. The tag only labels the visit; it doesn't identify anyone.</p>`;
  const gameList = a.games.length ? `<ul class="dlist">${a.games.map((r) => `<li>${esc(gameName(r.detail.replace(/^game /, "game ")))}: ${commas(r.n)} ${r.n === 1 ? "time" : "times"}${r.u > 1 ? " by " + r.u + " people" : ""}</li>`).join("")}</ul>` : `<p class="small muted">No game pages opened or lookups in the past week.</p>`;

  // The daily top 5.
  const last = a.lastPicks ? JSON.parse(a.lastPicks) : null;
  const sentMsg = url.searchParams.get("sent") ? `<p class="msg" role="status">${esc(url.searchParams.get("sent"))}</p>` : "";
  const now = Date.now();
  const state = (r) => r.state === "off" ? "Unsubscribed" : r.state === "ended" ? "Free week over" : r.access_until > now ? "On (member)" : "On, free until " + shortDay(r.until);
  const on = a.emails.filter((r) => r.state === "on").length;
  const emailRows = a.emails.map((r) => `<tr><td><a class="link" href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td>${esc(when(r.created_at))}</td><td>${esc(r.source || "")}</td><td>${esc(state(r))}</td><td>${commas(r.sends)}</td></tr>`).join("");
  const emailTable = a.emails.length
    ? `<div class="table-box"><table><thead><tr><th scope="col">Email</th><th scope="col">Signed up (Pacific)</th><th scope="col">From</th><th scope="col">Status</th><th scope="col">Emails sent</th></tr></thead><tbody>${emailRows}</tbody></table></div>`
    : `<p>Nobody on the list yet.</p>`;
  const hookRows = a.discord.map((r) => `<li>${esc(r.email)}: ${r.access_until > now ? "" : "access ended, so nothing is posted. "}${r.discord_at ? (r.discord_err ? "last try " + esc(when(r.discord_at)) + " failed (" + esc(r.discord_err) + ")" : "last posted " + esc(when(r.discord_at))) : "nothing posted yet"}</li>`).join("");
  const picks = `<section class="today" id="picks" aria-labelledby="pk-h"><h2 id="pk-h">Daily top 5 by email and Discord</h2>
<p>${emailOn(env) ? "Emails are on." : "<strong>Emails are off until Resend is connected</strong> (the RESEND_API_KEY secret and the mail.spawnbook.com DNS records). Sign-ups are saved and will start getting emails once it is."} Discord posts work now. Both go out every evening after the daily pull.</p>
<p>${googleStatus(env)}</p>
<p>${last ? "Last sent: " + esc(last.date) + ", " + last.discord + " Discord " + (last.discord === 1 ? "channel" : "channels") + ", " + (last.emailsOff ? "emails off" : last.emails + " emails") + "." : "Nothing sent yet."} ${on} on the email list, ${a.discord.length} Discord ${a.discord.length === 1 ? "channel" : "channels"}.</p>
<form method="post" action="/admin/picks/send"><button class="button quiet" type="submit">Send today's top 5 now</button></form>${sentMsg}
<h3>Email list</h3>${emailTable}
<h3>Discord</h3>${a.discord.length ? `<ul class="dlist">${hookRows}</ul>` : "<p>No member has connected Discord yet.</p>"}</section>`;
  const al = a.lastAlerts ? JSON.parse(a.lastAlerts) : null;
  const asentMsg = url.searchParams.get("asent") ? `<p class="msg" role="status">${esc(url.searchParams.get("asent"))}</p>` : "";
  const alerts = `<section class="today" id="alerts" aria-labelledby="al-h"><h2 id="al-h">Buy box alerts</h2>
<p>Every evening, after the top 5, each member whose access is running gets an email when a game on today's board fits their buy box and hasn't been sent to them before. Games on their watchlist are skipped, and no email goes out when nothing new fits. ${a.alertsOn} ${a.alertsOn === 1 ? "member has" : "members have"} a buy box with alerts on.${emailOn(env) ? "" : " <strong>Nothing is sent until Resend is connected.</strong>"}</p>
<p>${al ? "Last run: " + esc(al.date) + ", " + al.emails + " " + (al.emails === 1 ? "email" : "emails") + " with " + al.games + " " + (al.games === 1 ? "game" : "games") + ", " + al.members + " " + (al.members === 1 ? "member" : "members") + " checked" + (al.emailError ? ", and some emails failed" : "") + "." : "Nothing sent yet."} Clicks from these emails show above as tagged links (?via=alert).</p>
<form method="post" action="/admin/alerts/send"><button class="button quiet" type="submit">Send today's buy box alerts now</button></form>${asentMsg}</section>`;

  // " from x.com", or " through a ?via=discord link" for a tagged one.
  const fromText = (s) => { const m = /^via ([a-z0-9_-]+)(.*)$/.exec(s || ""); return m ? " through a ?via=" + m[1] + " link" + m[2] : s ? " from " + s : ""; };
  const label = (r) => {
    if (r.type === "visit") return "Opened the home page" + fromText(r.detail);
    if (r.type === "pass") return "Started a free pass on the " + (r.detail.startsWith("game") ? "page for " + gameName(r.detail) : r.detail + " page");
    if (r.type === "view") return "Opened " + (r.detail.startsWith("game") ? "the page for " + gameName(r.detail) : "the " + r.detail + " page");
    if (r.type === "lookup") return "Looked up " + gameName(r.detail) + (r.src === "free plan" ? " (free plan)" : "");
    if (r.type === "find") return "Used the game finder: " + r.detail + (r.src ? " (" + r.src + ")" : "");
    if (r.type === "draft") return "Opened a first message to the owner of " + gameName(r.detail);
    if (r.type === "page") return "Opened the public page for " + gameName(r.detail) + fromText(r.src);
    if (r.type === "land") return "Opened " + r.detail + fromText(r.src);
    if (r.type === "signup") return "Made an account" + (r.detail ? " (" + r.detail + ")" : "");
    if (r.type === "email") return "Signed up for the daily email" + (r.detail ? " on the " + r.detail : "");
    if (r.type === "discord") return "Connected Discord";
    return r.type + " " + r.detail;
  };
  const recent = a.recent.length
    ? `<div class="table-box"><table><thead><tr><th scope="col">When (Pacific)</th><th scope="col">Who</th><th scope="col">What</th></tr></thead><tbody>${a.recent.map((r) => `<tr><td>${esc(when(r.at))}</td><td>${esc(r.who)}</td><td>${esc(label(r))}</td></tr>`).join("")}</tbody></table></div>`
    : `<p>Nothing yet.</p>`;

  return page("Activity", `${adminNav("activity")}<h1 class="head">Activity</h1>
<p>What people do on Spawnbook, so you can tell whether outreach and posts bring anyone in. "Where visitors came from" counts the home page, public game pages and any page opened through a tagged link (?via=). "pass" and a number is one visitor without an account; accounts show their email. Bots and link previews are left out. Records are kept 120 days.</p>
<h2>Last 7 days</h2>${tiles}
<h2>Day by day</h2>${dayTable}
<div class="two"><section><h2>Where visitors came from</h2><p class="small muted">Last 7 days: home page and public game page visits, plus any page opened through a tagged link.</p>${fromList}</section><section><h2>Games people looked at</h2>${gameList}</section></div>
<h2>Your tagged links, last 30 days</h2>${taggedList}${tagHelp}
${picks}
${alerts}
<h2>Latest activity</h2>${recent}`);
}

// ---------- admin: verified leads ----------

const adminNav = (here) => `<nav class="admin-nav" aria-label="Admin"><a class="link" href="/admin"${here === "accounts" ? ' aria-current="page"' : ""}>Accounts</a><a class="link" href="/admin/activity"${here === "activity" ? ' aria-current="page"' : ""}>Activity</a><a class="link" href="/admin/leads"${here === "leads" ? ' aria-current="page"' : ""}>Verified leads</a></nav>`;
const commas = (n) => (n == null || !Number.isFinite(Number(n)) ? "–" : Math.round(Number(n)).toLocaleString("en-US"));
const shortDay = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
const gameUrl = (pid) => "https://www.roblox.com/games/" + pid;
const creatorUrl = (type, id) => (!id ? "" : type === "Group" ? "https://www.roblox.com/communities/" + id : "https://www.roblox.com/users/" + id + "/profile");
const safeUrl = (v) => (/^https:\/\/[^\s"'<>]+$/i.test(v) ? v.slice(0, 500) : "");
const options = (map, chosen) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${k === chosen ? " selected" : ""}>${esc(v)}</option>`).join("");

function boxSummary(b) {
  if (!b) return "";
  const parts = [];
  parts.push(b.genres && b.genres.length ? b.genres.join(", ") : "Any genre");
  if (b.minPlayers || b.maxPlayers) parts.push((b.minPlayers ? commas(b.minPlayers) : "0") + (b.maxPlayers ? " to " + commas(b.maxPlayers) : " or more") + " players online");
  if (b.maxVisits) parts.push("up to " + commas(b.maxVisits) + " visits");
  if (b.maxAgeDays) parts.push("up to " + commas(b.maxAgeDays) + " days old");
  if (b.minRevenue) parts.push("at least $" + commas(b.minRevenue) + " a month");
  if (b.maxPrice) parts.push("budget up to $" + commas(b.maxPrice));
  parts.push(DEALS[b.deal] || DEALS.either);
  if (b.avoid) parts.push("avoid: " + b.avoid);
  return parts.join("; ");
}

function ownerMessage(name) {
  return `Hi! I'm Gautam from Spawnbook (spawnbook.com). We follow new Roblox games every day, and ${name || "your game"} stood out.

Studios are buying games like yours right now, and I connect owners with them. Would you consider selling all or part of it? If so, roughly what price?

If you're open to it, two things would let me pass it to a buyer:
1. A short screen recording of your Creator Dashboard for the game, showing the last 30 days of Robux earned and concurrent players.
2. Your OK to share your contact and those numbers with that buyer.

No pressure either way, and there's no fee for you. If you're under 18, a parent or guardian would need to be part of any sale.`;
}

// Games from the daily history that fit a buyer's box, fastest-growing first.
function matchGames(HX, box) {
  const last = HX.dates.length - 1;
  const lastDate = HX.dates[last];
  const out = [];
  for (const [uid, g] of Object.entries(HX.games || {})) {
    const r = g[8] || [];
    const now = r[r.length - 1];
    if (!now || now[0] < last - 1) continue; // no recent reading
    const players = now[1], visits = now[2];
    if (box.minPlayers && players < box.minPlayers) continue;
    if (box.maxPlayers && players > box.maxPlayers) continue;
    if (box.maxVisits && visits > box.maxVisits) continue;
    if (box.genres && box.genres.length && !box.genres.includes(g[2])) continue;
    const age = g[7] ? Math.max(0, Math.round((Date.parse(lastDate) - Date.parse(g[7])) / DAY_MS)) : null;
    if (box.maxAgeDays && age != null && age > box.maxAgeDays) continue;
    // Change against the reading closest to a week back, or the oldest one if the record is shorter.
    let back = null;
    for (const x of r) { if (x[0] <= now[0] - 7) back = x; }
    if (!back && r[0] && r[0][0] <= now[0] - 3) back = r[0];
    const change = back && back[1] > 0 ? (players - back[1]) / back[1] : null;
    const peak = r.reduce((m, x) => Math.max(m, x[1] || 0), 0);
    out.push({ uid: Number(uid), name: g[0], pid: g[1], genre: g[2], genre2: g[3], creator: g[4], ctype: g[5], cid: g[6], age, players, visits, change, since: back ? HX.dates[back[0]] : null, signals: sellSignals({ players, peak, change, age, ctype: g[5] }) });
  }
  out.sort((a, b) => (b.change == null ? -9 : b.change) - (a.change == null ? -9 : a.change) || b.players - a.players);
  return out.slice(0, 60);
}

// Why an owner might sell: signs that cashing out could appeal to them. None of these says the game
// is bad; they're a way to choose whom to ask first.
function sellSignals(g) {
  const out = [];
  if (g.peak > 0 && g.players / g.peak <= 0.7) out.push("players down " + Math.round((1 - g.players / g.peak) * 100) + "% from their peak");
  if (g.change != null && g.change <= -0.15) out.push("lost " + Math.round(-g.change * 100) + "% of players in a week");
  else if (g.age != null && g.age >= 45 && g.change != null && Math.abs(g.change) < 0.1) out.push("growth has stalled");
  if (g.ctype === "User") out.push("solo developer");
  return out;
}
const signalsOf = (l) => { try { return l.sell_signals ? JSON.parse(l.sell_signals) : []; } catch (e) { return []; } };

const LEAD_SCRIPT = `
document.querySelectorAll("[data-copy]").forEach(function (b) {
  b.addEventListener("click", function () {
    var t = document.getElementById(b.getAttribute("data-copy")), s = b.parentNode.querySelector(".status");
    function sel() { t.focus(); t.select(); if (s) s.textContent = "Selected. Press Ctrl+C or Cmd+C to copy."; }
    try { navigator.clipboard.writeText(t.value).then(function () { if (s) s.textContent = "Copied."; }, sel); } catch (e) { sel(); }
  });
});
function openHash() { var m = /^#(lead-\\d+)$/.exec(location.hash); var d = m && document.getElementById(m[1]); if (d && d.tagName === "DETAILS") { d.open = true; d.scrollIntoView(); } }
window.addEventListener("hashchange", openHash); openHash();`;

async function adminLeads(request, env, url, path) {
  const form = request.method === "POST" ? await request.formData() : null;
  const get = (k) => String((form && form.get(k)) || "").trim();
  const forEmail = () => (validEmail(get("for").toLowerCase()) ? get("for").toLowerCase() : null);

  if (path === "/admin/leads/add" && form) {
    const pid = placeIdFrom(get("link"));
    if (!pid) return redirect("/admin/leads?e=link#add");
    let uid;
    try { uid = await placeToUniverse(pid); } catch (e) { return redirect("/admin/leads?e=roblox#add"); }
    if (!uid) return redirect("/admin/leads?e=game#add");
    const info = (await robloxGames([uid]))[uid] || {};
    const c = info.creator || {};
    const owner = await ownerOf(c.type, c.id, c.name);
    const r = await call(env, "lead-upsert", { uid, pid: info.pid || pid, name: String(info.name || "Game " + pid).slice(0, 120), creator: String(c.name || "").slice(0, 120), ctype: c.type || null, cid: Number(c.id) || null, owner_user: owner ? owner.name : null, owner_user_id: owner ? owner.id : null, for_email: forEmail() });
    return redirect("/admin/leads?id=" + r.id + "#lead-" + r.id);
  }

  if (path === "/admin/leads/new" && form) {
    const uid = posInt(get("uid"), Number.MAX_SAFE_INTEGER);
    if (!uid) return redirect("/admin/leads");
    const ctype = get("ctype") === "Group" ? "Group" : get("ctype") === "User" ? "User" : null;
    const cid = posInt(get("cid"), Number.MAX_SAFE_INTEGER);
    const owner = await ownerOf(ctype, cid, get("creator"));
    const r = await call(env, "lead-upsert", { uid, pid: posInt(get("pid"), Number.MAX_SAFE_INTEGER), name: get("name").slice(0, 120), creator: get("creator").slice(0, 120), ctype, cid, owner_user: owner ? owner.name : null, owner_user_id: owner ? owner.id : null, for_email: forEmail() });
    return redirect("/admin/leads?id=" + r.id + "#lead-" + r.id);
  }

  if (path === "/admin/leads/save" && form) {
    const id = posInt(get("id"), Number.MAX_SAFE_INTEGER);
    if (!id) return redirect("/admin/leads");
    const row = {
      id,
      status: LEAD_STATUSES[get("status")] ? get("status") : "found",
      contact: get("contact").slice(0, 200),
      contact_ok: get("contact_ok") === "yes" ? 1 : 0,
      owner_age: AGES[get("owner_age")] ? get("owner_age") : "unknown",
      asking: get("asking").slice(0, 80),
      deal: DEALS[get("deal")] ? get("deal") : "",
      revenue: posInt(get("revenue"), 1e12),
      peak: posInt(get("peak"), 1e8),
      proof: safeUrl(get("proof")),
      checked: get("checked").slice(0, 1500),
      notes: get("notes").slice(0, 4000),
    };
    const miss = [];
    if (get("proof") && !row.proof) miss.push("proof");
    if (row.status === "verified") {
      if (!row.contact) miss.push("contact");
      if (!row.contact_ok) miss.push("ok");
      if (row.owner_age === "unknown") miss.push("age");
      if (!row.revenue) miss.push("revenue");
      if (!row.checked) miss.push("checked");
      if (miss.length && miss.join() !== "proof") row.status = "willing";
    }
    const r = await call(env, "lead-save", row);
    if (r.error) return redirect("/admin/leads");
    return redirect("/admin/leads?id=" + id + (miss.length ? "&miss=" + miss.join(",") : "&saved=1") + "#lead-" + id);
  }

  if (path === "/admin/leads/send" && form) {
    const id = posInt(get("id"), Number.MAX_SAFE_INTEGER);
    const email = get("email").toLowerCase();
    const r = await call(env, "lead-send", { id, email });
    if (r.error) return redirect("/admin/leads?id=" + id + "&e=" + r.error + "#lead-" + id);
    const link = url.origin + "/leads";
    const first = String(r.buyer || "").trim().split(/\s+/)[0];
    const subject = "A verified lead from Spawnbook: " + r.name;
    const body = "Hi" + (first ? " " + first : "") + ",\n\nThere's a new verified lead on your Spawnbook account: " + r.name + ". The owner has said they'd consider selling, I've seen their Creator Dashboard numbers, and their contact is on the page:\n\n" + link + "\n\nGautam\nSpawnbook";
    const sent = await sendEmail(env, { to: email, subject, text: body });
    const note = sent.ok
      ? `<p>We emailed them to say it's there.</p><p><a class="button quiet" href="/admin/leads?id=${id}#lead-${id}">Back to the lead</a></p>`
      : `<p>${sent.off ? "Emails are off until Resend is connected" : "The email to them didn't go through"}, so let them know yourself.</p><p><a class="button" href="mailto:${esc(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">Email them about it</a> <a class="button quiet" href="/admin/leads?id=${id}#lead-${id}">Back to the lead</a></p>`;
    return page("Lead sent", `${adminNav("leads")}<h1 class="head">Lead sent</h1><p><strong>${esc(r.name)}</strong> is now on <strong>${esc(email)}</strong>'s Leads page.</p>${note}`);
  }

  if (path === "/admin/leads/unsend" && form) {
    const id = posInt(get("id"), Number.MAX_SAFE_INTEGER);
    await call(env, "lead-unsend", { id, email: get("email").toLowerCase() });
    return redirect("/admin/leads?id=" + id + "#lead-" + id);
  }

  if (path === "/admin/leads/delete" && form) {
    const id = posInt(get("id"), Number.MAX_SAFE_INTEGER);
    if (get("sure") !== "yes") return redirect("/admin/leads?id=" + id + "&e=sure#lead-" + id);
    await call(env, "lead-delete", { id });
    await filesCall(env, id, "file-drop", { all: true }).catch(() => {});
    return redirect("/admin/leads?deleted=1");
  }

  if (path === "/admin/leads/run" && form) {
    await runDaily(env, url.origin);
    return redirect("/admin/leads?ran=1#today");
  }

  if (path === "/admin/leads/match") return matchPage(env, url);
  return leadsPage(env, url);
}

async function matchPage(env, url) {
  const email = String(url.searchParams.get("email") || "").toLowerCase();
  const { box } = await call(env, "buybox-get", { email });
  const back = `<p><a class="button quiet" href="/admin/leads">Back to leads</a></p>`;
  if (!box) return page("Find games", `${adminNav("leads")}<h1 class="head">Find games</h1><p>${esc(email)} hasn't said what they buy yet. They can fill it in on their Leads page.</p>${back}`);
  const asset = await env.ASSETS.fetch(new Request(new URL("/history.js", url)));
  const text = asset.ok ? await asset.text() : "";
  const at = text.indexOf("{", text.indexOf("window.HX"));
  let HX = null;
  try { HX = at > 0 ? JSON.parse(text.slice(at).trim().replace(/;\s*$/, "")) : null; } catch (e) { HX = null; }
  if (!HX) return page("Find games", `${adminNav("leads")}<h1 class="head">Find games</h1><p>The daily history didn't load. Try again after the next daily update.</p>${back}`);
  const { leads, sends } = await call(env, "lead-list", {});
  const byUid = {};
  for (const l of leads) byUid[l.uid] = l;
  const sentHere = new Set(sends.filter((s) => s.email === email).map((s) => s.lead_id));
  const found = matchGames(HX, box);
  const rows = found.map((g) => {
    const l = byUid[g.uid];
    const action = l
      ? `<a class="link" href="/admin/leads?id=${l.id}#lead-${l.id}">${sentHere.has(l.id) ? "Sent to them" : "Already a lead: " + esc(LEAD_STATUSES[l.status])}</a>`
      : `<form class="inline" method="post" action="/admin/leads/new"><input type="hidden" name="uid" value="${g.uid}"><input type="hidden" name="pid" value="${esc(g.pid)}"><input type="hidden" name="name" value="${esc(g.name)}"><input type="hidden" name="creator" value="${esc(g.creator)}"><input type="hidden" name="ctype" value="${esc(g.ctype)}"><input type="hidden" name="cid" value="${esc(g.cid)}"><input type="hidden" name="for" value="${esc(email)}"><button class="button" type="submit">Start a lead</button></form>`;
    const ch = g.change == null ? "–" : (g.change > 0 ? "+" : "") + Math.round(g.change * 100) + "%";
    const owner = creatorUrl(g.ctype, g.cid);
    return `<tr><td><a class="link" href="${esc(gameUrl(g.pid))}" target="_blank" rel="noopener">${esc(g.name)}</a><span class="sub">${esc(g.genre2 || g.genre || "")}</span></td><td>${g.age == null ? "–" : commas(g.age) + " days"}</td><td class="r">${commas(g.players)}</td><td class="r">${esc(ch)}${g.since ? `<span class="sub">since ${esc(shortDay(Date.parse(g.since) + 12 * 3600e3))}</span>` : ""}</td><td class="r">${commas(g.visits)}</td><td>${owner ? `<a class="link" href="${esc(owner)}" target="_blank" rel="noopener">${esc(g.creator || "Owner")}</a>` : esc(g.creator || "")}<span class="sub">${esc(g.ctype || "")}</span></td><td>${g.signals.length ? esc(g.signals.join(", ")) : "–"}</td><td>${action}</td></tr>`;
  }).join("");
  const table = found.length
    ? `<div class="table-box"><table><thead><tr><th>Game</th><th>Age</th><th>Players at the last reading</th><th>Change in players</th><th>Visits</th><th>Owner on Roblox</th><th>Might sell because</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p>No game in today's history fits this yet. The history covers games that have reached 300 players or been on the board, so very small games won't show up here. Add those by link on the leads page.</p>`;
  return page("Find games", `${adminNav("leads")}<h1 class="head">Games for ${esc(email)}</h1><p><strong>What they buy:</strong> ${esc(boxSummary(box))}.${box.notes ? " " + esc(box.notes) : ""}</p><p class="small muted">From the daily reading on ${esc(shortDay(Date.parse(HX.dates[HX.dates.length - 1]) + 12 * 3600e3))}, fastest-growing first. Revenue isn't public, so check it against their minimum when the owner sends their dashboard. Start a lead to get a message you can send the owner.</p>${table}${back}`);
}

async function leadsPage(env, url) {
  const d = await call(env, "lead-list", {});
  let today = null;
  try { today = d.digest ? JSON.parse(d.digest) : null; } catch (e) {}
  const live = await robloxGames(d.leads.map((l) => l.uid));
  const sendsBy = {};
  for (const s of d.sends) (sendsBy[s.lead_id] = sendsBy[s.lead_id] || []).push(s);
  const filesBy = {};
  for (const f of d.files || []) (filesBy[f.lead_id] = filesBy[f.lead_id] || []).push(f);
  const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const openId = Number(url.searchParams.get("id")) || 0;
  const q = (k) => url.searchParams.get(k) || "";

  const MISS = { contact: "the owner's contact", ok: "the owner's OK to share it", age: "the owner's age", revenue: "Robux earned in the last 30 days", checked: "what you checked", proof: "a proof link that starts with https://" };
  let msg = "";
  if (q("saved")) msg = `<p class="msg" role="status">Saved.</p>`;
  if (q("miss")) {
    const list = q("miss").split(",").map((k) => MISS[k]).filter(Boolean);
    msg = `<p class="msg" role="alert">Saved, but ${q("miss").split(",").some((k) => k !== "proof") ? "it isn't verified yet. To mark it Verified, fill in " : "fix "}${esc(list.join(", "))}.</p>`;
  }
  const E = { link: "That doesn't look like a Roblox game link.", game: "Roblox doesn't know that game. Check the link.", roblox: "Roblox didn't answer. Try again in a minute.", unverified: "Only a verified lead can be sent.", account: "There's no account with that email.", sure: "Tick the box to confirm you want to delete it." };
  if (E[q("e")]) msg = `<p class="msg" role="alert">${esc(E[q("e")])}</p>`;
  if (q("deleted")) msg = `<p class="msg" role="status">Deleted.</p>`;

  // Today's summary from the daily check.
  const leadLink = (id, name) => `<a class="link" href="/admin/leads?id=${id}#lead-${id}">${esc(name || "Game")}</a>`;
  let todayBlock = "";
  if (today) {
    const parts = [];
    if (today.found.length) parts.push(`<h3>New games for your buyers</h3><ul class="dlist">${today.found.map((f) => `<li>For ${esc(f.email)}: ${f.items.map((it) => leadLink(it.id, it.name) + " (" + commas(it.players) + " players)").join(", ")}</li>`).join("")}</ul>`);
    if (today.offers.length) parts.push(`<h3>Owners who filled in the selling form</h3><ul class="dlist">${today.offers.map((o) => `<li>${leadLink(o.id, o.name)}: ${esc(o.contact)}${o.asking ? ", asking " + esc(o.asking) : ""}</li>`).join("")}</ul>`);
    if (today.confirmed && today.confirmed.length) parts.push(`<h3>Owners who proved it's their game</h3><ul class="dlist">${today.confirmed.map((c) => `<li>${leadLink(c.id, c.name)}${c.proof_at ? ", recording sent" : ", recording not sent yet"}</li>`).join("")}</ul>`);
    if (today.recordings && today.recordings.length) parts.push(`<h3>Dashboard recordings to watch</h3><ul class="dlist">${today.recordings.map((c) => `<li>${leadLink(c.id, c.name)}</li>`).join("")}</ul>`);
    if (today.changed.length) parts.push(`<h3>Changed owner on Roblox</h3><ul class="dlist">${today.changed.map((c) => `<li>${leadLink(c.id, c.name)}: now ${esc(c.now)}, was ${esc(c.was)}${c.sentTo.length ? ". Sent to " + esc(c.sentTo.join(", ")) + ", so ask whether they bought it" : ""}</li>`).join("")}</ul>`);
    if (today.updates.length) parts.push(`<h3>Buyers' updates</h3><ul class="dlist">${today.updates.map((u) => `<li>${esc(u.email)} marked ${leadLink(u.id, u.name)} as ${esc(PICK_LABELS[u.status] || u.status)}</li>`).join("")}</ul>`);
    if (today.willing || today.stale.length) parts.push(`<h3>Waiting on you</h3><ul class="dlist">${today.willing ? `<li>${today.willing} ${today.willing === 1 ? "owner has" : "owners have"} said they'd sell but ${today.willing === 1 ? "isn't" : "aren't"} verified yet</li>` : ""}${today.stale.map((st) => `<li>No answer from ${leadLink(st.id, st.name)} for ${st.days} days. Follow up?</li>`).join("")}</ul>`);
    if (!today.history) parts.unshift(`<p class="msg">The daily history didn't load, so this check couldn't look for new games.</p>`);
    todayBlock = parts.length ? parts.join("") : `<p>Nothing new in the last check.</p>`;
  }
  const emailLine = emailOn(env)
    ? "The summary is emailed to you after each daily check, buyers are emailed when you send them a lead, and you're emailed when an owner fills in the selling form."
    : "Emails are off until Resend is connected (the RESEND_API_KEY secret in Cloudflare), so check this page instead.";
  const today_ = `<section class="today" id="today" aria-labelledby="today-h"><h2 id="today-h">Today's summary</h2><p class="small muted">${today ? "From the daily check on " + esc(today.date) + " at " + esc(new Date(today.at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" })) + " Pacific. It runs every evening after the daily pull, finds up to " + AUTO_PER_BUYER + " new games for each buyer and checks your leads' owners on Roblox. " : "The daily check runs every evening after the daily pull. "}${esc(emailLine)}</p>${q("ran") ? `<p class="msg" role="status">Done. Here's what it found.</p>` : ""}${todayBlock}<form class="inline" method="post" action="/admin/leads/run"><button class="button quiet" type="submit">Run the daily check now</button></form></section>`;

  const accounts = d.accounts || [];
  const boxes = d.boxes || [];
  const buyerRows = boxes.map((b) => {
    let box = null;
    try { box = JSON.parse(b.box); } catch (e) {}
    return `<tr><td>${esc(b.email)}<span class="sub">${esc(b.company || "")}</span></td><td>${esc(boxSummary(box))}${box && box.notes ? `<span class="sub">${esc(box.notes)}</span>` : ""}</td><td class="r">${b.sent}</td><td>${esc(shortDay(b.updated_at))}</td><td><a class="button quiet" href="/admin/leads/match?email=${encodeURIComponent(b.email)}">Find games</a></td></tr>`;
  }).join("");
  const buyers = boxes.length
    ? `<div class="table-box"><table><thead><tr><th>Buyer</th><th>What they buy</th><th>Leads sent</th><th>Updated</th><th><span class="sr-only">Find games</span></th></tr></thead><tbody>${buyerRows}</tbody></table></div>`
    : `<p>Nobody has said what they buy yet. Buyers fill it in on their <a class="link" href="/leads">Leads page</a>, so point them there after they sign up.</p>`;

  const buyerOptions = (exclude) => {
    const withBox = new Set(boxes.map((b) => b.email));
    const list = accounts.filter((a) => !exclude.has(a.email)).sort((a, b) => (withBox.has(b.email) ? 1 : 0) - (withBox.has(a.email) ? 1 : 0));
    return list.map((a) => `<option value="${esc(a.email)}">${esc(a.email)}${a.company ? " (" + esc(a.company) + ")" : ""}${withBox.has(a.email) ? "" : ", no buy box yet"}</option>`).join("");
  };

  const leadBlock = (l) => {
    const now = live[l.uid];
    const sends = sendsBy[l.id] || [];
    const owner = creatorUrl(l.creator_type, l.creator_id);
    let nowOwner = null;
    try { nowOwner = l.owner_now ? JSON.parse(l.owner_now) : null; } catch (e) {}
    if (now && now.creator && now.creator.id && l.creator_id && Number(now.creator.id) !== Number(l.creator_id)) nowOwner = now.creator;
    const changed = !!nowOwner && Number(nowOwner.id) !== Number(l.creator_id);
    let offer = null;
    try { offer = l.offer ? JSON.parse(l.offer) : null; } catch (e) {}
    const meta = [
      l.creator ? "Owner: " + l.creator : "",
      now ? commas(now.players) + " players now" : "",
      l.for_email ? "found for " + l.for_email : "",
      sends.length ? "sent to " + sends.length : "",
      l.source === "owner" ? "the owner came to us" : "",
      l.auto ? "found by the daily check" : "",
      signalsOf(l).length ? "might sell: " + signalsOf(l).join(", ") : "",
    ].filter(Boolean).join(", ");
    const files = filesBy[l.id] || [];
    const recording = (l.proof && l.proof_at && /^https:\/\//i.test(l.proof)) || files.length > 0;
    const fileList = files.length ? `<li><strong>Files from their Creator Dashboard, sent ${esc(shortDay(l.proof_at || files[0].created_at))}:</strong> ${files.map((x) => `<a class="link" href="/api/file?f=${x.id}" target="_blank" rel="noopener">${esc(x.name)}</a> (${/^video/.test(x.type) ? "video" : "picture"}, ${mb(x.size)})`).join(", ")}. Check Robux and players against the public numbers, fill in what you checked below and mark it Verified. The first file is the lead's proof link, so the buyer can open it once you send the lead.</li>` : "";
    const proofBlock = l.verify_code
      ? `<div class="offer"><h4>Owner's proof</h4><ul class="dlist">${l.owner_verified_at ? `<li><strong>Owner confirmed ${esc(shortDay(l.owner_verified_at))}:</strong> the code ${esc(l.verify_code)} was in the game's description on Roblox, so whoever filled in the form controls the game. They can take the code out now.</li>` : `<li>Waiting for the owner to put <strong>${esc(l.verify_code)}</strong> in the game's description. They do it from the private link we gave them${validEmail(String(l.contact || "").toLowerCase()) ? " and emailed them" : ""}.</li>`}${fileList}${recording && !files.length ? `<li><strong>Dashboard recording, sent ${esc(shortDay(l.proof_at))}:</strong> <a class="link" href="${esc(l.proof)}" target="_blank" rel="noopener">open it</a>. Check Robux and players against the public numbers, fill in what you checked below and mark it Verified. It's also in the proof link, so the buyer can watch it once you send the lead.</li>` : !recording && l.owner_verified_at ? `<li>No dashboard recording yet.</li>` : ""}</ul></div>`
      : "";
    const offerBlock = offer ? `<div class="offer"><h4>What the owner sent us${l.offered_at ? " on " + esc(shortDay(l.offered_at)) : ""}</h4><dl><dt>Contact</dt><dd>${esc(offer.contact)}</dd><dt>Role</dt><dd>${esc(offer.role)}</dd><dt>Would sell</dt><dd>${esc(DEALS[offer.deal] || "")}</dd><dt>Asking</dt><dd>${esc(offer.asking || "Not given")}</dd><dt>Age</dt><dd>${esc(AGES[offer.age] || "")}</dd><dt>Notes</dt><dd>${esc(offer.notes || "None")}</dd></dl><p class="small muted">They haven't agreed to share their contact with a specific buyer yet. Ask before you send it.</p></div>` : "";
    const sendList = sends.length
      ? `<ul class="sends">${sends.map((s) => `<li><strong>${esc(s.email)}</strong>, sent ${esc(shortDay(s.sent_at))}. Their status: ${esc(s.status)}${s.note ? `. Their note: ${esc(s.note)}` : ""}<form class="inline" method="post" action="/admin/leads/unsend"><input type="hidden" name="id" value="${l.id}"><input type="hidden" name="email" value="${esc(s.email)}"><button class="linkbutton small" type="submit">Take it back</button></form></li>`).join("")}</ul>`
      : "";
    const already = new Set(sends.map((s) => s.email));
    const sendForm = l.status === "verified"
      ? `<form class="inline" method="post" action="/admin/leads/send"><input type="hidden" name="id" value="${l.id}"><label class="sr-only" for="to-${l.id}">Buyer</label><select id="to-${l.id}" name="email" required>${buyerOptions(already)}</select><button class="button" type="submit">Send</button></form>`
      : `<p class="small muted">Mark it Verified to send it.</p>`;
    const f = (k) => esc(l[k] == null ? "" : l[k]);
    return `<details class="lead-row" id="lead-${l.id}"${l.id === openId ? " open" : ""}><summary>${esc(l.name || "Game " + l.pid)}${changed ? ` <span class="flag">Owner changed</span>` : ""}${l.source === "owner" && l.status === "willing" && !l.contact_ok ? ` <span class="flag">New from the selling form</span>` : ""}${recording && l.status !== "verified" ? ` <span class="flag">Recording to watch</span>` : l.owner_verified_at && l.status !== "verified" ? ` <span class="flag">Owner confirmed</span>` : ""}<span class="l-meta">${esc(meta)}</span></summary><div class="l-body">
<p class="small"><a class="link" href="${esc(gameUrl(l.pid))}" target="_blank" rel="noopener">Game on Roblox</a>${owner ? ` and its owner, <a class="link" href="${esc(owner)}" target="_blank" rel="noopener">${esc(l.creator || "on Roblox")}</a> (${esc(l.creator_type || "")})` : ""}. ${now ? commas(now.players) + " players and " + commas(now.visits) + " visits right now." : ""} Added ${esc(shortDay(l.created_at))}.${l.verified_at ? " Verified " + esc(shortDay(l.verified_at)) + "." : ""}</p>
${l.owner_user && l.owner_user_id ? `<p class="small">Run on Roblox by <a class="link" href="https://www.roblox.com/users/${esc(l.owner_user_id)}/profile" target="_blank" rel="noopener">${esc(l.owner_user)}</a>${l.creator_type === "Group" ? ", who owns the group" : ""}. <a class="link" href="https://x.com/search?q=${encodeURIComponent(l.owner_user)}&amp;f=user" target="_blank" rel="noopener">Search X for that name</a>: it's a search, not a confirmed account, so check it's really them. If you're signed in to Roblox, the game page also shows any Discord or X link they've added.</p>` : ""}
${changed ? `<p class="msg">Roblox now shows <strong>${esc(nowOwner.name)}</strong> (${esc(nowOwner.type)}) as the owner, not ${esc(l.creator)}. If you sent this lead to someone, the game may have sold. Ask them.</p>` : ""}
${offerBlock}
${proofBlock}
<div class="out"><label class="small" for="msg-${l.id}">Message for the owner. Send it from X or Discord, not Roblox chat: messaging strangers about money there can get your Roblox account flagged. Look for their Discord or X on the game page or the group.</label><textarea id="msg-${l.id}" readonly rows="10">${esc(ownerMessage(l.name))}</textarea><div class="rowline"><button class="button quiet" type="button" data-copy="msg-${l.id}">Copy message</button><span class="status" aria-live="polite"></span></div></div>
<form class="form" method="post" action="/admin/leads/save"><input type="hidden" name="id" value="${l.id}">
<h4>What the owner told you</h4>
<div class="fields">
<div class="field"><label for="st-${l.id}">Status</label><select id="st-${l.id}" name="status">${options(LEAD_STATUSES, l.status)}</select></div>
<div class="field"><label for="ct-${l.id}">Owner's contact <span class="opt">(Discord, X or email)</span></label><input id="ct-${l.id}" name="contact" maxlength="200" value="${f("contact")}"></div>
<label class="consent full" for="ok-${l.id}"><input type="checkbox" id="ok-${l.id}" name="contact_ok" value="yes"${l.contact_ok ? " checked" : ""}><span>The owner said I can share their contact and numbers with a buyer.</span></label>
<div class="field"><label for="ag-${l.id}">Owner's age</label><select id="ag-${l.id}" name="owner_age">${options(AGES, l.owner_age)}</select></div>
<div class="field"><label for="dl-${l.id}">What they'd sell</label><select id="dl-${l.id}" name="deal"><option value="">Not asked yet</option>${options(DEALS, l.deal)}</select></div>
<div class="field"><label for="as-${l.id}">Asking price <span class="opt">(for example $15,000, or open to offers)</span></label><input id="as-${l.id}" name="asking" maxlength="80" value="${f("asking")}"></div>
<div class="field"><label for="rv-${l.id}">Robux earned, last 30 days <span class="opt">(from their dashboard)</span></label><input id="rv-${l.id}" name="revenue" inputmode="numeric" value="${f("revenue")}"></div>
<div class="field"><label for="pk-${l.id}">Peak players, last 30 days</label><input id="pk-${l.id}" name="peak" inputmode="numeric" value="${f("peak")}"></div>
<div class="field"><label for="pf-${l.id}">Proof link the buyer can open <span class="opt">(optional, https://)</span></label><input id="pf-${l.id}" name="proof" type="url" maxlength="500" value="${f("proof")}"></div>
<div class="field full"><label for="ck-${l.id}">What you checked <span class="opt">(the buyer sees this)</span></label><textarea id="ck-${l.id}" name="checked" rows="3" maxlength="1500" placeholder="Watched a screen recording of their Creator Dashboard on Nov 2. Robux and players match Roblox's public numbers.">${f("checked")}</textarea></div>
<div class="field full"><label for="nt-${l.id}">Private notes <span class="opt">(only you see these)</span></label><textarea id="nt-${l.id}" name="notes" rows="3" maxlength="4000">${f("notes")}</textarea></div>
</div>
<p class="small muted">To mark it Verified you need their contact, their OK to share it, their age, Robux earned and what you checked. Under 18 only counts with a parent or guardian involved.</p>
<div class="form-row"><button class="button" type="submit">Save</button></div></form>
<div><h4>Send to a buyer</h4>${sendForm}${sendList}</div>
<form class="inline" method="post" action="/admin/leads/delete"><input type="hidden" name="id" value="${l.id}"><label class="check"><input type="checkbox" name="sure" value="yes"> Yes, delete this lead</label><button class="button quiet" type="submit">Delete</button></form>
</div></details>`;
  };

  const order = ["willing", "asked", "found", "verified", "sold", "declined"];
  const rank = (l) => (l.proof_at ? 2 : 0) + (l.owner_verified_at ? 1 : 0);
  const groups = order.map((st) => {
    const list = d.leads.filter((l) => l.status === st)
      .sort((a, b) => rank(b) - rank(a) || (st === "found" ? signalsOf(b).length - signalsOf(a).length : 0) || b.updated_at - a.updated_at);
    return list.length ? `<h3>${esc(LEAD_STATUSES[st])} (${list.length})</h3>${list.map(leadBlock).join("")}` : "";
  }).join("");
  const add = `<form class="form add" id="add" method="post" action="/admin/leads/add"><h2 class="form-h">Add a game by its link</h2><div class="fields"><div class="field"><label for="ad-link">Roblox game link</label><input id="ad-link" name="link" required placeholder="https://www.roblox.com/games/…"></div><div class="field"><label for="ad-for">Found for <span class="opt">(optional)</span></label><select id="ad-for" name="for"><option value="">Nobody in particular</option>${boxes.map((b) => `<option value="${esc(b.email)}">${esc(b.email)}</option>`).join("")}</select></div></div><div class="form-row"><button class="button" type="submit">Add game</button></div></form>`;

  return page("Verified leads", `${adminNav("leads")}<h1 class="head">Verified leads</h1>
<p>Find games for each buyer, ask the owners, check their numbers, then send the lead. A buyer sees only the leads you send them, on their <a class="link" href="/leads">Leads page</a>.</p>
<ol class="steps small">
<li><strong>Find.</strong> Every evening the daily check adds up to ${AUTO_PER_BUYER} new games for each buyer, and owners who fill in the selling form at /sell show up on their own. You can also click Find games next to a buyer, or add a game by its link.</li>
<li><strong>Ask.</strong> Open the lead, copy the message and send it to the owner from X or Discord.</li>
<li><strong>Check.</strong> Owners who come through /sell prove it's their game themselves: they put a code in its description, which the site checks on Roblox, then send a recording of their Creator Dashboard. Those leads go to the top, marked Owner confirmed or Recording to watch. Compare the recording with the public numbers, fill in what they told you and set the status to Verified. Found games are listed with the likeliest sellers first (players falling, growth stalled, solo developer).</li>
<li><strong>Send.</strong> Pick the buyer and click Send. Once Resend is connected, they're emailed automatically. If Roblox later shows a new owner for a lead's game, it's flagged here and in the summary.</li>
</ol>
${msg}
${today_}
<h2>Buyers</h2>${buyers}
${add}
<h2>Leads</h2>${groups || "<p>No leads yet.</p>"}`, LEAD_SCRIPT);
}

// ---------- Durable Object: accounts, sessions and password links ----------

const PBKDF2_ITERATIONS = 100000; // the most the Workers runtime allows
const LOCK_AFTER = 8; // wrong passwords for one email
const LOCK_MS = 15 * 60 * 1000;

// The site owner's account, made once on first start. Its one-time password link was handed to
// the owner directly; only a SHA-256 hash of it is kept here, so this file can't be used to sign in.
const OWNER = {
  seed: "owner-2026-10-25",
  email: "gautamuprasanna@gmail.com",
  name: "Gautam Prasanna",
  company: "Spawnbook",
  role: "Owner",
  until: Date.UTC(2100, 0, 1),
  linkHash: "23d0e713f13fcf2a8cfbcbd9c7be2eb1fe57ca62059ca3e43294e14490ffbe4a",
  linkExpires: Date.UTC(2026, 10, 30, 8),
};

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(pw, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(pw, salt, PBKDF2_ITERATIONS);
  return "pbkdf2-sha256$" + PBKDF2_ITERATIONS + "$" + b64(salt) + "$" + b64(bits);
}

async function checkPassword(pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const want = unb64(parts[3]);
  const got = new Uint8Array(await pbkdf2(pw, unb64(parts[2]), Number(parts[1])));
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export class Store {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS signups (email TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL, access_until INTEGER NOT NULL, last_seen INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL)");
    try { this.sql.exec("ALTER TABLE signups ADD COLUMN pw TEXT"); } catch (e) { /* already there */ }
    this.sql.exec("CREATE TABLE IF NOT EXISTS links (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS fails (email TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL)");
    try { this.sql.exec("ALTER TABLE signups ADD COLUMN google_sub TEXT"); } catch (e) { /* already there */ }
    this.sql.exec("CREATE TABLE IF NOT EXISTS google_pending (hash TEXT PRIMARY KEY, email TEXT NOT NULL, sub TEXT NOT NULL, name TEXT, next TEXT, ref TEXT, expires INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seeds (name TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // Referrals: each account gets a code; a sign-up through it remembers who referred them, and
    // that person's first payment gives the referrer a free month (one credit row per referral).
    for (const col of ["ref_code TEXT", "referred_by TEXT", "paid_at INTEGER", "ref_credited INTEGER"]) {
      try { this.sql.exec("ALTER TABLE signups ADD COLUMN " + col); } catch (e) { /* already there */ }
    }
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS signups_ref_code ON signups (ref_code)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS credits (referrer TEXT NOT NULL, referred TEXT NOT NULL, at INTEGER NOT NULL, days INTEGER NOT NULL)");
    // Watchlist: each member's starred games, with a deal status and private notes. "seen" is the
    // player count the member last saw, for "since you last looked".
    this.sql.exec("CREATE TABLE IF NOT EXISTS watch (email TEXT NOT NULL, uid INTEGER NOT NULL, pid INTEGER, name TEXT, status TEXT NOT NULL DEFAULT 'watching', note TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seen_players INTEGER, seen_at INTEGER, PRIMARY KEY (email, uid))");
    // Verified leads. buybox: what each buyer buys. leads: one row per game we're working on, with
    // what its owner told us (offer holds what they sent through /sell). lead_sends: which buyers
    // got which lead, with the buyer's own status and note.
    this.sql.exec("CREATE TABLE IF NOT EXISTS buybox (email TEXT PRIMARY KEY, box TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, uid INTEGER NOT NULL UNIQUE, pid INTEGER, name TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', creator_type TEXT, creator_id INTEGER, source TEXT NOT NULL DEFAULT 'scouted', status TEXT NOT NULL DEFAULT 'found', for_email TEXT, contact TEXT NOT NULL DEFAULT '', contact_ok INTEGER NOT NULL DEFAULT 0, owner_age TEXT NOT NULL DEFAULT 'unknown', asking TEXT NOT NULL DEFAULT '', deal TEXT NOT NULL DEFAULT '', revenue INTEGER, peak INTEGER, proof TEXT NOT NULL DEFAULT '', checked TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', offer TEXT, offered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, verified_at INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS lead_sends (lead_id INTEGER NOT NULL, email TEXT NOT NULL, sent_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY (lead_id, email))");
    // Added with the daily check: whether the check found it, who runs the game on Roblox, and when
    // Roblox started showing a different owner. kv keeps the time and summary of the last check.
    for (const col of ["auto INTEGER NOT NULL DEFAULT 0", "owner_user TEXT", "owner_user_id INTEGER", "owner_now TEXT", "owner_changed_at INTEGER"]) {
      try { this.sql.exec("ALTER TABLE leads ADD COLUMN " + col); } catch (e) { /* already there */ }
    }
    // Owners proving it's their game from /sell: seller_token is their private link, verify_code the
    // code they put in the game's description, owner_verified_at when we saw it there, proof_at when
    // they sent their dashboard recording (kept in proof). sell_signals: why an owner the daily check
    // found might sell (a JSON list), so the likeliest are asked first.
    for (const col of ["seller_token TEXT", "verify_code TEXT", "owner_verified_at INTEGER", "proof_at INTEGER", "check_at INTEGER", "sell_signals TEXT"]) {
      try { this.sql.exec("ALTER TABLE leads ADD COLUMN " + col); } catch (e) { /* already there */ }
    }
    // Screen recordings and screenshots an owner uploads from /sell, kept here in 1 MB pieces (a row
    // holds up to 2 MB), so there's no separate file store to set up. done = every piece arrived.
    this.sql.exec("CREATE TABLE IF NOT EXISTS lead_files (id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS lead_file_chunks (file_id INTEGER NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file_id, i))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // Activity: one row per thing someone did (landing visit, free pass started, page opened, lookup,
    // sign-up), kept 120 days, for the admin activity page. "who" is an account's email, or "pass"
    // and a number for a visitor without an account.
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_day ON events (day)");
    // src: the other site a visitor came from, for public game pages.
    try { this.sql.exec("ALTER TABLE events ADD COLUMN src TEXT NOT NULL DEFAULT ''"); } catch (e) { /* already there */ }
    // The free plan: which games each account looked up on each day (UTC), kept a week.
    this.sql.exec("CREATE TABLE IF NOT EXISTS free_lookups (who TEXT NOT NULL, day TEXT NOT NULL, uid INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (who, day, uid))");
    // The daily top 5 by email. state: on, ended (a non-member's free week ran out) or off
    // (unsubscribed). Members with access get it for as long as they're members.
    this.sql.exec("CREATE TABLE IF NOT EXISTS daily_emails (email TEXT PRIMARY KEY, created_at INTEGER NOT NULL, until INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'on', last_sent TEXT, sends INTEGER NOT NULL DEFAULT 0)");
    // The daily top 5 in Discord: a member's webhook, and how the last post went.
    for (const col of ["discord TEXT", "discord_at INTEGER", "discord_err TEXT"]) {
      try { this.sql.exec("ALTER TABLE signups ADD COLUMN " + col); } catch (e) { /* already there */ }
    }
    // Buy box alerts: an email when a game on the board fits what a member buys. state is on or off;
    // a member with a buy box and no row yet counts as on. alert_sent keeps every game already
    // emailed to each member, so a game that stays on the board isn't sent twice.
    this.sql.exec("CREATE TABLE IF NOT EXISTS alerts (email TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'on', token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_sent TEXT, sends INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS alert_sent (email TEXT NOT NULL, pid INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (email, pid))");
    this.seedOwner();
  }

  // One piece of an owner's upload. Pieces live in a separate object for each lead ("files-<lead>"),
  // so uploads never use up the main object's space. The Worker checks the owner's link against the
  // main object first; nothing else can reach a Durable Object.
  async filePut(u, request) {
    const f = Number(u.searchParams.get("f")), i = Number(u.searchParams.get("i"));
    if (!Number.isSafeInteger(f) || f <= 0 || !Number.isInteger(i) || i < 0) return new Response(JSON.stringify({ error: "file" }), { status: 400 });
    const data = new Uint8Array(await request.arrayBuffer());
    if (!data.length || data.length > FILE_CHUNK) return new Response(JSON.stringify({ error: "size" }), { status: 400 });
    this.sql.exec("INSERT OR REPLACE INTO lead_file_chunks (file_id, i, data) VALUES (?, ?, ?)", f, i, data);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
  fileRead(u) {
    const r = this.sql.exec("SELECT data FROM lead_file_chunks WHERE file_id = ? AND i = ?", Number(u.searchParams.get("f")), Number(u.searchParams.get("i"))).toArray()[0];
    if (!r) return new Response("", { status: 404 });
    return new Response(r.data, { headers: { "Content-Type": "application/octet-stream" } });
  }

  // A member's alerts row, made (switched on) if there isn't one yet. Returns its unsubscribe token.
  alertRow(email) {
    const r = this.sql.exec("SELECT token FROM alerts WHERE email = ?", email).toArray()[0];
    if (r) return r.token;
    const token = randomToken();
    this.sql.exec("INSERT INTO alerts (email, token, created_at) VALUES (?, ?, ?)", email, token, Date.now());
    return token;
  }
  alertsOn(email) {
    const r = this.sql.exec("SELECT state FROM alerts WHERE email = ?", email).toArray()[0];
    return !r || r.state === "on";
  }

  seedOwner() {
    if (this.sql.exec("SELECT name FROM seeds WHERE name = ?", OWNER.seed).toArray().length) return;
    const now = Date.now();
    const row = this.sql.exec("SELECT access_until FROM signups WHERE email = ?", OWNER.email).toArray()[0];
    if (row) this.sql.exec("UPDATE signups SET access_until = ? WHERE email = ?", Math.max(row.access_until, OWNER.until), OWNER.email);
    else this.sql.exec("INSERT INTO signups (email, name, company, role, created_at, access_until, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)", OWNER.email, OWNER.name, OWNER.company, OWNER.role, now, OWNER.until, null);
    this.sql.exec("DELETE FROM links WHERE hash = ?", OWNER.linkHash);
    this.sql.exec("INSERT INTO links (hash, email, expires) VALUES (?, ?, ?)", OWNER.linkHash, OWNER.email, OWNER.linkExpires);
    this.sql.exec("INSERT INTO seeds (name, at) VALUES (?, ?)", OWNER.seed, now);
  }

  account(email) {
    return this.sql.exec("SELECT email, access_until, pw, ref_code, referred_by, paid_at, ref_credited FROM signups WHERE email = ?", email).toArray()[0];
  }

  // A short code that reads cleanly in a link: no 0/o, 1/l/i.
  refCode(email) {
    const acct = this.account(email);
    if (!acct) return null;
    if (acct.ref_code) return acct.ref_code;
    const abc = "23456789abcdefghjkmnpqrstuvwxyz";
    for (let tries = 0; tries < 20; tries++) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const code = Array.from(bytes, (b) => abc[b % abc.length]).join("");
      if (this.sql.exec("SELECT email FROM signups WHERE ref_code = ?", code).toArray().length) continue;
      this.sql.exec("UPDATE signups SET ref_code = ? WHERE email = ?", code, email);
      return code;
    }
    throw new Error("Couldn't make a referral code");
  }

  newSession(token, email, now) {
    this.sql.exec("INSERT INTO sessions (token, email, created_at) VALUES (?, ?, ?)", token, email, now);
    this.sql.exec("UPDATE signups SET last_seen = ? WHERE email = ?", now, email);
  }

  async fetch(request) {
    const u = new URL(request.url);
    const op = u.pathname.slice(1);
    // Pieces of an uploaded file go in and out as raw bytes, not JSON.
    if (op === "file-put") return this.filePut(u, request);
    if (op === "file-read") return this.fileRead(u);
    const p = await request.json();
    const now = Date.now();
    const reply = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

    if (op === "signup") {
      // An email that already has an account has to sign in; signing up again never signs anyone in.
      // The hash is worked out first so the check and the insert run with nothing in between.
      if (this.account(p.email)) return reply({ exists: true });
      const pw = await hashPassword(p.password);
      if (this.account(p.email)) return reply({ exists: true });
      const referrer = p.ref ? this.sql.exec("SELECT email FROM signups WHERE ref_code = ?", p.ref).toArray()[0] : null;
      const referredBy = referrer && referrer.email !== p.email ? referrer.email : null;
      this.sql.exec("INSERT INTO signups (email, name, company, role, created_at, access_until, last_seen, pw, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", p.email, p.name, p.company, p.role || "", now, p.until, now, pw, referredBy);
      this.newSession(p.token, p.email, now);
      return reply({ until: p.until });
    }

    if (op === "signin") {
      const f = this.sql.exec("SELECT count, first_at FROM fails WHERE email = ?", p.email).toArray()[0];
      const fresh = f && now - f.first_at < LOCK_MS;
      if (fresh && f.count >= LOCK_AFTER) return reply({ ok: false, reason: "locked" });
      const acct = this.account(p.email);
      if (acct && !acct.pw) return reply({ ok: false, reason: "nopw" });
      const ok = !!acct && (await checkPassword(p.password, acct.pw));
      if (!ok) {
        const f2 = this.sql.exec("SELECT first_at FROM fails WHERE email = ?", p.email).toArray()[0];
        if (f2 && now - f2.first_at < LOCK_MS) this.sql.exec("UPDATE fails SET count = count + 1 WHERE email = ?", p.email);
        else this.sql.exec("INSERT OR REPLACE INTO fails (email, count, first_at) VALUES (?, 1, ?)", p.email, now);
        return reply({ ok: false, reason: "bad" });
      }
      this.sql.exec("DELETE FROM fails WHERE email = ?", p.email);
      this.newSession(p.token, p.email, now);
      return reply({ ok: true, until: acct.access_until });
    }

    if (op === "signout") {
      this.sql.exec("DELETE FROM sessions WHERE token = ?", p.token);
      return reply({ ok: true });
    }

    if (op === "session") {
      const row = this.sql.exec("SELECT u.email AS email, u.access_until AS until, u.pw AS pw, u.google_sub AS gsub, u.name AS name, u.company AS company FROM sessions s JOIN signups u ON u.email = s.email WHERE s.token = ?", p.token).toArray()[0];
      if (!row) return reply({ email: null });
      this.sql.exec("UPDATE signups SET last_seen = ? WHERE email = ?", now, row.email);
      return reply({ email: row.email, until: row.until, hasPassword: !!row.pw, hasGoogle: !!row.gsub, name: row.name || "", company: row.company || "" });
    }

    // Sign in with Google. An email that already has an account signs in and remembers its Google
    // account; a new email waits in google_pending until the finish form is sent.
    if (op === "google-signin") {
      const acct = this.account(p.email);
      if (!acct) return reply({ ok: false });
      this.sql.exec("UPDATE signups SET google_sub = ? WHERE email = ?", p.sub, p.email);
      this.sql.exec("DELETE FROM fails WHERE email = ?", p.email);
      this.newSession(p.token, p.email, now);
      return reply({ ok: true, until: acct.access_until });
    }

    if (op === "google-pending") {
      this.sql.exec("DELETE FROM google_pending WHERE expires <= ?", now);
      this.sql.exec("INSERT OR REPLACE INTO google_pending (hash, email, sub, name, next, ref, expires) VALUES (?, ?, ?, ?, ?, ?, ?)", p.hash, p.email, p.sub, p.name || "", p.next || "", p.ref || "", p.expires);
      return reply({ ok: true });
    }

    if (op === "google-pending-get") {
      const row = this.sql.exec("SELECT email, name, next FROM google_pending WHERE hash = ? AND expires > ?", p.hash, now).toArray()[0];
      return reply(row || {});
    }

    if (op === "google-finish") {
      const g = this.sql.exec("SELECT email, sub, next, ref FROM google_pending WHERE hash = ? AND expires > ?", p.hash, now).toArray()[0];
      if (!g) return reply({ ok: false });
      this.sql.exec("DELETE FROM google_pending WHERE hash = ?", p.hash);
      const have = this.account(g.email);
      if (have) {
        // Made in another tab in the meantime: just sign in.
        this.sql.exec("UPDATE signups SET google_sub = ? WHERE email = ?", g.sub, g.email);
        this.newSession(p.token, g.email, now);
        return reply({ ok: true, created: false, email: g.email, until: have.access_until, next: g.next });
      }
      const referrer = g.ref ? this.sql.exec("SELECT email FROM signups WHERE ref_code = ?", g.ref).toArray()[0] : null;
      const referredBy = referrer && referrer.email !== g.email ? referrer.email : null;
      this.sql.exec("INSERT INTO signups (email, name, company, role, created_at, access_until, last_seen, pw, referred_by, google_sub) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)", g.email, p.name, p.company, p.role || "", now, p.until, now, referredBy, g.sub);
      this.newSession(p.token, g.email, now);
      return reply({ ok: true, created: true, email: g.email, until: p.until, next: g.next });
    }

    if (op === "set-by-link") {
      const link = this.sql.exec("SELECT email, expires FROM links WHERE hash = ?", p.linkHash).toArray()[0];
      if (!link || link.expires <= now) return reply({ ok: false });
      const acct = this.account(link.email);
      if (!acct) return reply({ ok: false });
      const pw = await hashPassword(p.password);
      this.sql.exec("UPDATE signups SET pw = ? WHERE email = ?", pw, link.email);
      this.sql.exec("DELETE FROM links WHERE email = ?", link.email);
      this.sql.exec("DELETE FROM sessions WHERE email = ?", link.email);
      this.sql.exec("DELETE FROM fails WHERE email = ?", link.email);
      this.newSession(p.token, link.email, now);
      return reply({ ok: true, until: acct.access_until });
    }

    if (op === "set-by-session") {
      const s = this.sql.exec("SELECT email FROM sessions WHERE token = ?", p.token).toArray()[0];
      const acct = s && this.account(s.email);
      if (!acct) return reply({ ok: false, reason: "signin" });
      if (acct.pw && !(await checkPassword(p.current || "", acct.pw))) return reply({ ok: false, reason: "current" });
      const pw = await hashPassword(p.password);
      this.sql.exec("UPDATE signups SET pw = ? WHERE email = ?", pw, acct.email);
      this.sql.exec("DELETE FROM sessions WHERE email = ? AND token != ?", acct.email, p.token);
      this.sql.exec("DELETE FROM links WHERE email = ?", acct.email);
      return reply({ ok: true });
    }

    if (op === "referrals") {
      const s = this.sql.exec("SELECT email FROM sessions WHERE token = ?", p.token).toArray()[0];
      if (!s) return reply({ code: null });
      const code = this.refCode(s.email);
      const signedUp = this.sql.exec("SELECT COUNT(*) AS n FROM signups WHERE referred_by = ?", s.email).toArray()[0].n;
      const paying = this.sql.exec("SELECT COUNT(*) AS n FROM signups WHERE referred_by = ? AND paid_at IS NOT NULL", s.email).toArray()[0].n;
      const monthsEarned = this.sql.exec("SELECT COUNT(*) AS n FROM credits WHERE referrer = ?", s.email).toArray()[0].n;
      return reply({ code, signedUp, paying, monthsEarned });
    }

    if (op === "paid") {
      const acct = this.account(p.email);
      if (!acct) return reply({ ok: false });
      const until = Math.max(now, acct.access_until) + p.days * DAY_MS;
      const firstPayment = !acct.paid_at;
      this.sql.exec("UPDATE signups SET access_until = ?, paid_at = COALESCE(paid_at, ?) WHERE email = ?", until, now, p.email);
      let credited = null;
      if (acct.referred_by && !acct.ref_credited) {
        const ref = this.account(acct.referred_by);
        if (ref) {
          const refUntil = Math.max(now, ref.access_until) + p.referralDays * DAY_MS;
          this.sql.exec("UPDATE signups SET access_until = ? WHERE email = ?", refUntil, ref.email);
          this.sql.exec("INSERT INTO credits (referrer, referred, at, days) VALUES (?, ?, ?, ?)", ref.email, p.email, now, p.referralDays);
          this.sql.exec("UPDATE signups SET ref_credited = 1 WHERE email = ?", p.email);
          credited = { email: ref.email, until: refUntil };
        }
      }
      return reply({ ok: true, until, firstPayment, referredBy: acct.referred_by || null, alreadyCredited: !!acct.ref_credited, credited });
    }

    if (op === "watch-list") {
      return reply({ rows: this.sql.exec("SELECT uid, pid, name, status, note, added_at, updated_at, seen_players, seen_at FROM watch WHERE email = ? ORDER BY added_at DESC", p.email).toArray() });
    }

    if (op === "watch-add") {
      const have = this.sql.exec("SELECT uid FROM watch WHERE email = ? AND uid = ?", p.email, p.uid).toArray()[0];
      if (!have) {
        const n = this.sql.exec("SELECT COUNT(*) AS n FROM watch WHERE email = ?", p.email).toArray()[0].n;
        if (n >= p.max) return reply({ error: "full", max: p.max });
        this.sql.exec("INSERT INTO watch (email, uid, pid, name, status, note, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", p.email, p.uid, p.pid, p.name, p.status || "watching", p.note || "", now, now);
      } else {
        if (p.status) this.sql.exec("UPDATE watch SET status = ?, updated_at = ? WHERE email = ? AND uid = ?", p.status, now, p.email, p.uid);
        if (p.note != null) this.sql.exec("UPDATE watch SET note = ?, updated_at = ? WHERE email = ? AND uid = ?", p.note, now, p.email, p.uid);
      }
      return reply({ ok: true, row: this.sql.exec("SELECT uid, pid, name, status, note, added_at, updated_at, seen_players, seen_at FROM watch WHERE email = ? AND uid = ?", p.email, p.uid).toArray()[0] });
    }

    if (op === "watch-update") {
      const have = this.sql.exec("SELECT uid FROM watch WHERE email = ? AND uid = ?", p.email, p.uid).toArray()[0];
      if (!have) return reply({ error: "missing" });
      if (p.status) this.sql.exec("UPDATE watch SET status = ?, updated_at = ? WHERE email = ? AND uid = ?", p.status, now, p.email, p.uid);
      if (p.note != null) this.sql.exec("UPDATE watch SET note = ?, updated_at = ? WHERE email = ? AND uid = ?", p.note, now, p.email, p.uid);
      return reply({ ok: true, row: this.sql.exec("SELECT uid, pid, name, status, note, added_at, updated_at, seen_players, seen_at FROM watch WHERE email = ? AND uid = ?", p.email, p.uid).toArray()[0] });
    }

    if (op === "watch-remove") {
      this.sql.exec("DELETE FROM watch WHERE email = ? AND uid = ?", p.email, p.uid);
      return reply({ ok: true });
    }

    if (op === "watch-seen") {
      for (const [uid, players] of Object.entries(p.seen || {})) this.sql.exec("UPDATE watch SET seen_players = ?, seen_at = ? WHERE email = ? AND uid = ?", players, now, p.email, Number(uid));
      return reply({ ok: true });
    }

    if (op === "trial-secret") {
      let row = this.sql.exec("SELECT v FROM kv WHERE k = 'trial_secret'").toArray()[0];
      if (!row) {
        this.sql.exec("INSERT OR IGNORE INTO kv (k, v) VALUES ('trial_secret', ?)", randomToken());
        row = this.sql.exec("SELECT v FROM kv WHERE k = 'trial_secret'").toArray()[0];
      }
      return reply({ secret: row.v });
    }

    if (op === "buybox-get") {
      const r = this.sql.exec("SELECT box, updated_at FROM buybox WHERE email = ?", p.email).toArray()[0];
      return reply({ box: r ? JSON.parse(r.box) : null, updated_at: r ? r.updated_at : null, alerts: this.alertsOn(p.email) });
    }

    if (op === "buybox-set") {
      if (p.box != null) this.sql.exec("INSERT OR REPLACE INTO buybox (email, box, updated_at) VALUES (?, ?, ?)", p.email, p.box, now);
      if (typeof p.alerts === "boolean") {
        this.alertRow(p.email);
        this.sql.exec("UPDATE alerts SET state = ? WHERE email = ?", p.alerts ? "on" : "off", p.email);
      }
      const r = this.sql.exec("SELECT box, updated_at FROM buybox WHERE email = ?", p.email).toArray()[0];
      return reply({ ok: true, box: r ? JSON.parse(r.box) : null, updated_at: r ? r.updated_at : null, alerts: this.alertsOn(p.email) });
    }

    // ---------- buy box alerts ----------
    // Members whose access is running and who have a buy box and haven't turned alerts off, with the
    // games already sent to each and the games on their watchlist (those aren't news to them).
    if (op === "alerts-due") {
      const rows = this.sql.exec("SELECT b.email AS email, b.box AS box, u.name AS name, u.access_until AS until FROM buybox b JOIN signups u ON u.email = b.email LEFT JOIN alerts a ON a.email = b.email WHERE u.access_until > ? AND (a.state IS NULL OR a.state = 'on') AND (a.last_sent IS NULL OR a.last_sent != ?)", now, String(p.date)).toArray();
      for (const r of rows) {
        r.token = this.alertRow(r.email);
        r.sent = this.sql.exec("SELECT pid FROM alert_sent WHERE email = ?", r.email).toArray().map((x) => Number(x.pid));
        r.watched = this.sql.exec("SELECT uid FROM watch WHERE email = ?", r.email).toArray().map((x) => Number(x.uid));
      }
      return reply({ rows });
    }
    // After a send: remember the games each member was sent. A member with nothing new still gets
    // last_sent, so tonight's run doesn't look at them again.
    if (op === "alerts-sent") {
      for (const r of p.rows || []) {
        this.alertRow(r.email);
        for (const pid of r.pids || []) this.sql.exec("INSERT OR IGNORE INTO alert_sent (email, pid, at) VALUES (?, ?, ?)", r.email, Number(pid), now);
        this.sql.exec("UPDATE alerts SET last_sent = ?, sends = sends + ? WHERE email = ?", String(p.date), r.pids && r.pids.length ? 1 : 0, r.email);
      }
      return reply({ ok: true });
    }
    if (op === "alerts-unsub") {
      const row = this.sql.exec("SELECT email FROM alerts WHERE token = ?", String(p.token)).toArray()[0];
      if (row) this.sql.exec("UPDATE alerts SET state = 'off' WHERE token = ?", String(p.token));
      return reply({ ok: !!row });
    }

    if (op === "lead-upsert") {
      const have = this.sql.exec("SELECT id FROM leads WHERE uid = ?", p.uid).toArray()[0];
      if (have) {
        if (p.for_email) this.sql.exec("UPDATE leads SET for_email = COALESCE(for_email, ?) WHERE id = ?", p.for_email, have.id);
        if (p.owner_user) this.sql.exec("UPDATE leads SET owner_user = COALESCE(owner_user, ?), owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?", p.owner_user, p.owner_user_id || null, have.id);
        return reply({ id: have.id, existed: true });
      }
      this.sql.exec("INSERT INTO leads (uid, pid, name, creator, creator_type, creator_id, owner_user, owner_user_id, source, status, for_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scouted', 'found', ?, ?, ?)", p.uid, p.pid || null, p.name || "", p.creator || "", p.ctype || null, p.cid || null, p.owner_user || null, p.owner_user_id || null, p.for_email || null, now, now);
      return reply({ id: this.sql.exec("SELECT id FROM leads WHERE uid = ?", p.uid).toArray()[0].id, existed: false });
    }

    if (op === "offer") {
      // A public form, so: at most 30 submissions an hour in total, and one per game every 10 minutes.
      const recent = this.sql.exec("SELECT COUNT(*) AS n FROM leads WHERE offered_at > ?", now - 3600e3).toArray()[0].n;
      if (recent >= 30) return reply({ limited: true });
      const have = this.sql.exec("SELECT id, offered_at FROM leads WHERE uid = ?", p.uid).toArray()[0];
      if (have && have.offered_at && now - have.offered_at < 10 * 60e3) return reply({ ok: true, id: have.id, fresh: false });
      if (!have) {
        this.sql.exec("INSERT INTO leads (uid, pid, name, creator, creator_type, creator_id, owner_user, owner_user_id, source, status, contact, owner_age, asking, deal, offer, offered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'willing', ?, ?, ?, ?, ?, ?, ?, ?)", p.uid, p.pid || null, p.name || "", p.creator || "", p.ctype || null, p.cid || null, p.owner_user || null, p.owner_user_id || null, p.contact, p.age, p.asking || "", p.deal || "", p.offer, now, now, now);
      } else {
        // Whoever sent the form last gets the link and code: an earlier confirmation was someone
        // else's (or theirs, with a code they've since lost), so it starts over.
        this.sql.exec("UPDATE leads SET owner_verified_at = NULL, check_at = NULL WHERE id = ?", have.id);
        this.sql.exec("UPDATE leads SET offer = ?, offered_at = ?, source = 'owner', auto = 0, status = CASE WHEN status IN ('found', 'asked', 'declined') THEN 'willing' ELSE status END, contact = CASE WHEN contact = '' THEN ? ELSE contact END, owner_age = CASE WHEN owner_age = 'unknown' THEN ? ELSE owner_age END, asking = CASE WHEN asking = '' THEN ? ELSE asking END, deal = CASE WHEN deal = '' THEN ? ELSE deal END, owner_user = COALESCE(owner_user, ?), owner_user_id = COALESCE(owner_user_id, ?), updated_at = ? WHERE id = ?", p.offer, now, p.contact, p.age, p.asking || "", p.deal || "", p.owner_user || null, p.owner_user_id || null, now, have.id);
      }
      const id = this.sql.exec("SELECT id FROM leads WHERE uid = ?", p.uid).toArray()[0].id;
      if (p.token && p.code) this.sql.exec("UPDATE leads SET seller_token = ?, verify_code = ? WHERE id = ?", p.token, p.code, id);
      return reply({ ok: true, fresh: true, id });
    }

    // ---------- an owner proving it's their game, from their private link ----------
    if (op === "seller-get") {
      const l = this.sql.exec("SELECT id, uid, pid, name, creator_id, verify_code, owner_verified_at, proof, proof_at, check_at FROM leads WHERE seller_token = ?", String(p.token)).toArray()[0];
      return reply({ lead: l || null });
    }
    if (op === "seller-checked") {
      this.sql.exec("UPDATE leads SET check_at = ? WHERE seller_token = ?", now, String(p.token));
      if (p.found) this.sql.exec("UPDATE leads SET owner_verified_at = COALESCE(owner_verified_at, ?), updated_at = ? WHERE seller_token = ?", now, now, String(p.token));
      return reply({ ok: true, at: (this.sql.exec("SELECT owner_verified_at FROM leads WHERE seller_token = ?", String(p.token)).toArray()[0] || {}).owner_verified_at || null });
    }
    // ---------- files an owner uploads ----------
    if (op === "file-start") {
      const l = this.sql.exec("SELECT id, owner_verified_at FROM leads WHERE seller_token = ?", String(p.token)).toArray()[0];
      if (!l) return reply({ error: "link" });
      if (!l.owner_verified_at) return reply({ error: "first" });
      const have = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM lead_files WHERE lead_id = ?", l.id).toArray()[0];
      if (have.n >= FILE_MAX_COUNT || have.bytes + p.size > FILE_MAX_TOTAL) return reply({ error: "full" });
      this.sql.exec("INSERT INTO lead_files (lead_id, name, type, size, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?)", l.id, String(p.name).slice(0, 120), String(p.type), Number(p.size), Math.ceil(Number(p.size) / FILE_CHUNK), now);
      return reply({ f: this.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0].id });
    }
    // Is this piece of this file the owner's to send? (Checked here; the piece itself goes to the
    // lead's files object.)
    if (op === "file-ok") {
      const f = this.sql.exec("SELECT f.id, f.lead_id, f.chunks, f.done FROM lead_files f JOIN leads l ON l.id = f.lead_id WHERE f.id = ? AND l.seller_token = ?", Number(p.f), String(p.token)).toArray()[0];
      if (!f || f.done || !(p.i >= 0 && p.i < f.chunks)) return reply({ error: "file" });
      return reply({ lead_id: f.lead_id });
    }
    if (op === "file-lead") {
      const f = this.sql.exec("SELECT f.id, f.lead_id FROM lead_files f JOIN leads l ON l.id = f.lead_id WHERE f.id = ? AND l.seller_token = ?", Number(p.f), String(p.token)).toArray()[0];
      return reply({ lead_id: f ? f.lead_id : null });
    }
    // In a lead's files object: how much of a file has arrived, and removing files.
    if (op === "file-count") {
      return reply(this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM lead_file_chunks WHERE file_id = ?", Number(p.f)).toArray()[0]);
    }
    if (op === "file-drop") {
      if (p.all) this.sql.exec("DELETE FROM lead_file_chunks");
      for (const id of p.ids || []) this.sql.exec("DELETE FROM lead_file_chunks WHERE file_id = ?", Number(id));
      return reply({ ok: true });
    }
    if (op === "file-done") {
      const f = this.sql.exec("SELECT f.id, f.lead_id, f.size, f.chunks, f.done FROM lead_files f JOIN leads l ON l.id = f.lead_id WHERE f.id = ? AND l.seller_token = ?", Number(p.f), String(p.token)).toArray()[0];
      if (!f) return reply({ error: "file" });
      const got = p.got || {};
      if (got.n !== f.chunks || got.bytes !== f.size) return reply({ error: "missing" });
      this.sql.exec("UPDATE lead_files SET done = 1 WHERE id = ?", f.id);
      // The first file becomes the lead's proof link, unless there's already a recording link.
      this.sql.exec("UPDATE leads SET proof = CASE WHEN proof = '' OR proof IS NULL THEN ? ELSE proof END, proof_at = ?, updated_at = ? WHERE id = ?", String(p.link), now, now, f.lead_id);
      return reply({ ok: true, files: this.sql.exec("SELECT COUNT(*) AS n FROM lead_files WHERE lead_id = ? AND done = 1", f.lead_id).toArray()[0].n });
    }
    if (op === "file-meta") {
      const f = this.sql.exec("SELECT f.id, f.lead_id, f.name, f.type, f.size, f.chunks, f.done, l.status AS lead_status FROM lead_files f JOIN leads l ON l.id = f.lead_id WHERE f.id = ?", Number(p.f)).toArray()[0];
      const sent = f && p.email ? !!this.sql.exec("SELECT 1 FROM lead_sends WHERE lead_id = ? AND email = ?", f.lead_id, String(p.email)).toArray()[0] : false;
      return reply({ file: f || null, sent });
    }

    if (op === "seller-proof") {
      this.sql.exec("UPDATE leads SET proof = ?, proof_at = ?, updated_at = ? WHERE seller_token = ? AND owner_verified_at IS NOT NULL", String(p.url), now, now, String(p.token));
      return reply({ ok: true });
    }

    if (op === "lead-list") {
      return reply({
        leads: this.sql.exec("SELECT * FROM leads ORDER BY updated_at DESC").toArray(),
        sends: this.sql.exec("SELECT lead_id, email, sent_at, status, note, updated_at FROM lead_sends ORDER BY sent_at DESC").toArray(),
        files: this.sql.exec("SELECT id, lead_id, name, type, size, created_at FROM lead_files WHERE done = 1 ORDER BY id").toArray(),
        accounts: this.sql.exec("SELECT email, name, company FROM signups ORDER BY created_at DESC").toArray(),
        boxes: this.sql.exec("SELECT b.email AS email, b.box AS box, b.updated_at AS updated_at, u.name AS name, u.company AS company, (SELECT COUNT(*) FROM lead_sends s WHERE s.email = b.email) AS sent FROM buybox b LEFT JOIN signups u ON u.email = b.email ORDER BY b.updated_at DESC").toArray(),
        digest: (this.sql.exec("SELECT v FROM kv WHERE k = 'digest'").toArray()[0] || {}).v || null,
      });
    }

    if (op === "lead-save") {
      if (!this.sql.exec("SELECT id FROM leads WHERE id = ?", p.id).toArray()[0]) return reply({ error: "missing" });
      this.sql.exec("UPDATE leads SET status = ?, contact = ?, contact_ok = ?, owner_age = ?, asking = ?, deal = ?, revenue = ?, peak = ?, proof = ?, checked = ?, notes = ?, updated_at = ?, verified_at = CASE WHEN ? = 'verified' THEN COALESCE(verified_at, ?) ELSE verified_at END WHERE id = ?",
        p.status, p.contact, p.contact_ok, p.owner_age, p.asking, p.deal, p.revenue, p.peak, p.proof, p.checked, p.notes, now, p.status, now, p.id);
      return reply({ ok: true });
    }

    if (op === "lead-send") {
      const lead = this.sql.exec("SELECT id, name, status FROM leads WHERE id = ?", p.id).toArray()[0];
      if (!lead || lead.status !== "verified") return reply({ error: "unverified" });
      if (!this.account(p.email)) return reply({ error: "account" });
      this.sql.exec("INSERT OR IGNORE INTO lead_sends (lead_id, email, sent_at, status, note, updated_at) VALUES (?, ?, ?, 'new', '', ?)", p.id, p.email, now, now);
      const buyer = this.sql.exec("SELECT name FROM signups WHERE email = ?", p.email).toArray()[0];
      return reply({ ok: true, name: lead.name, buyer: buyer ? buyer.name : "" });
    }

    if (op === "lead-unsend") {
      this.sql.exec("DELETE FROM lead_sends WHERE lead_id = ? AND email = ?", p.id, p.email);
      return reply({ ok: true });
    }

    if (op === "lead-delete") {
      this.sql.exec("DELETE FROM lead_files WHERE lead_id = ?", p.id);
      this.sql.exec("DELETE FROM lead_sends WHERE lead_id = ?", p.id);
      this.sql.exec("DELETE FROM leads WHERE id = ?", p.id);
      return reply({ ok: true });
    }

    // What a buyer sees: only leads sent to them, and the owner's contact only while the owner's OK stands.
    if (op === "my-leads") {
      return reply({
        rows: this.sql.exec("SELECT l.id AS id, l.uid AS uid, l.pid AS pid, l.name AS name, l.creator AS creator, l.creator_type AS creator_type, l.creator_id AS creator_id, l.status AS lead_status, CASE WHEN l.contact_ok = 1 THEN l.contact ELSE '' END AS contact, l.owner_age AS owner_age, l.asking AS asking, l.deal AS deal, l.revenue AS revenue, l.peak AS peak, l.proof AS proof, l.checked AS checked, l.verified_at AS verified_at, s.sent_at AS sent_at, s.status AS status, s.note AS note FROM lead_sends s JOIN leads l ON l.id = s.lead_id WHERE s.email = ? ORDER BY s.sent_at DESC", p.email).toArray(),
      });
    }

    if (op === "my-lead-update") {
      if (!this.sql.exec("SELECT lead_id FROM lead_sends WHERE email = ? AND lead_id = ?", p.email, p.id).toArray()[0]) return reply({ error: "missing" });
      if (p.status) this.sql.exec("UPDATE lead_sends SET status = ?, updated_at = ? WHERE email = ? AND lead_id = ?", p.status, now, p.email, p.id);
      if (p.note != null) this.sql.exec("UPDATE lead_sends SET note = ?, updated_at = ? WHERE email = ? AND lead_id = ?", p.note, now, p.email, p.id);
      return reply({ ok: true, row: this.sql.exec("SELECT lead_id AS id, status, note, updated_at FROM lead_sends WHERE email = ? AND lead_id = ?", p.email, p.id).toArray()[0] });
    }

    // The daily check: new games for each buyer, owner changes on Roblox, and a summary of what
    // happened since the last check.
    if (op === "daily") {
      let HX = null;
      const text = p.history || "";
      const at = text.indexOf("{", text.indexOf("window.HX"));
      try { HX = at > 0 ? JSON.parse(text.slice(at).trim().replace(/;\s*$/, "")) : null; } catch (e) { HX = null; }
      const lastRow = this.sql.exec("SELECT v FROM kv WHERE k = 'daily_at'").toArray()[0];
      const since = lastRow ? Number(lastRow.v) : now - DAY_MS;
      const d = { at: now, date: new Date(now).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }), history: !!HX, found: [], offers: [], changed: [], updates: [], stale: [], willing: 0 };

      // Uploads that never finished: forgotten here, and their pieces dropped by the Worker.
      const staleFiles = this.sql.exec("SELECT id, lead_id FROM lead_files WHERE done = 0 AND created_at < ?", now - DAY_MS).toArray();
      this.sql.exec("DELETE FROM lead_files WHERE done = 0 AND created_at < ?", now - DAY_MS);

      // Clear out the check's own suggestions that nobody has touched for a while.
      this.sql.exec("DELETE FROM leads WHERE auto = 1 AND status = 'found' AND updated_at < ? AND id NOT IN (SELECT lead_id FROM lead_sends)", now - AUTO_KEEP_DAYS * DAY_MS);

      // 1. New games for each buyer, skipping any game that's already a lead.
      if (HX) {
        const have = new Set(this.sql.exec("SELECT uid FROM leads").toArray().map((r) => Number(r.uid)));
        let total = 0;
        for (const b of this.sql.exec("SELECT email, box FROM buybox ORDER BY updated_at DESC").toArray()) {
          if (total >= AUTO_TOTAL) break;
          let box;
          try { box = JSON.parse(b.box); } catch (e) { continue; }
          const items = [];
          for (const g of matchGames(HX, box)) {
            if (items.length >= AUTO_PER_BUYER || total >= AUTO_TOTAL) break;
            if (have.has(g.uid)) continue;
            have.add(g.uid);
            total++;
            this.sql.exec("INSERT INTO leads (uid, pid, name, creator, creator_type, creator_id, source, status, for_email, auto, sell_signals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scouted', 'found', ?, 1, ?, ?, ?)", g.uid, g.pid || null, g.name || "", g.creator || "", g.ctype || null, g.cid || null, b.email, JSON.stringify(g.signals || []), now, now);
            const id = this.sql.exec("SELECT id FROM leads WHERE uid = ?", g.uid).toArray()[0].id;
            items.push({ id, name: g.name, players: g.players, change: g.change, genre: g.genre2 || g.genre, ctype: g.ctype, cid: g.cid, creator: g.creator });
          }
          if (items.length) d.found.push({ email: b.email, items });
        }
        // Who runs each new game on Roblox (for a group, its owner).
        for (const f of d.found) for (const it of f.items) {
          const o = await ownerOf(it.ctype, it.cid, it.creator);
          if (o && o.name) { this.sql.exec("UPDATE leads SET owner_user = ?, owner_user_id = ? WHERE id = ?", o.name, o.id || null, it.id); it.owner = o.name; }
          delete it.ctype; delete it.cid; delete it.creator;
        }
      }

      // 2. Did a game we're working on, or sent to someone, change hands?
      const watched = this.sql.exec("SELECT id, uid, name, creator, creator_id FROM leads WHERE owner_changed_at IS NULL AND creator_id IS NOT NULL AND (status IN ('asked', 'willing', 'verified') OR id IN (SELECT lead_id FROM lead_sends))").toArray();
      if (watched.length) {
        const live = await robloxGames(watched.map((l) => Number(l.uid)));
        for (const l of watched) {
          const g = live[l.uid];
          if (!g || !g.creator || !g.creator.id || Number(g.creator.id) === Number(l.creator_id)) continue;
          this.sql.exec("UPDATE leads SET owner_changed_at = ?, owner_now = ? WHERE id = ?", now, JSON.stringify(g.creator), l.id);
          const sentTo = this.sql.exec("SELECT email FROM lead_sends WHERE lead_id = ?", l.id).toArray().map((r) => r.email);
          d.changed.push({ id: l.id, name: l.name, was: l.creator, now: g.creator.name, sentTo });
        }
      }

      // 3. What happened since the last check.
      d.offers = this.sql.exec("SELECT id, name, contact, asking FROM leads WHERE offered_at > ? ORDER BY offered_at DESC LIMIT 30", since).toArray();
      d.confirmed = this.sql.exec("SELECT id, name, proof_at FROM leads WHERE owner_verified_at > ? ORDER BY owner_verified_at DESC LIMIT 30", since).toArray();
      d.recordings = this.sql.exec("SELECT id, name, proof FROM leads WHERE proof_at > ? AND status != 'verified' ORDER BY proof_at DESC LIMIT 30", since).toArray();
      d.updates = this.sql.exec("SELECT s.lead_id AS id, l.name AS name, s.email AS email, s.status AS status FROM lead_sends s JOIN leads l ON l.id = s.lead_id WHERE s.updated_at > ? AND s.updated_at > s.sent_at AND s.status != 'new' ORDER BY s.updated_at DESC LIMIT 30", since).toArray();
      d.willing = this.sql.exec("SELECT COUNT(*) AS n FROM leads WHERE status = 'willing'").toArray()[0].n;
      d.stale = this.sql.exec("SELECT id, name, updated_at FROM leads WHERE status = 'asked' AND updated_at < ? ORDER BY updated_at LIMIT 20", now - 3 * DAY_MS).toArray()
        .map((r) => ({ id: r.id, name: r.name, days: Math.floor((now - r.updated_at) / DAY_MS) }));
      const newGames = d.found.reduce((n, f) => n + f.items.length, 0);
      d.any = !!(newGames || d.offers.length || d.confirmed.length || d.recordings.length || d.changed.length || d.updates.length);
      const bits = [];
      if (newGames) bits.push(newGames + (newGames === 1 ? " new game" : " new games") + " for your buyers");
      if (d.offers.length) bits.push(d.offers.length + (d.offers.length === 1 ? " owner wants" : " owners want") + " to sell");
      if (d.changed.length) bits.push(d.changed.length + (d.changed.length === 1 ? " game changed owner" : " games changed owner"));
      if (d.updates.length) bits.push(d.updates.length + (d.updates.length === 1 ? " buyer update" : " buyer updates"));
      if (d.confirmed.length) bits.push(d.confirmed.length + (d.confirmed.length === 1 ? " owner confirmed" : " owners confirmed"));
      if (d.recordings.length) bits.push(d.recordings.length + (d.recordings.length === 1 ? " dashboard to check" : " dashboards to check"));
      d.headline = bits.join(", ") || "nothing new";
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('daily_at', ?)", String(now));
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('digest', ?)", JSON.stringify(d));
      return reply({ ok: true, digest: d, staleFiles });
    }

    if (op === "make-link") {
      if (!this.account(p.email)) return reply({ ok: false });
      this.sql.exec("DELETE FROM links WHERE email = ?", p.email);
      this.sql.exec("INSERT INTO links (hash, email, expires) VALUES (?, ?, ?)", p.linkHash, p.email, p.expires);
      return reply({ ok: true });
    }

    if (op === "create") {
      const existed = !!this.account(p.email);
      if (existed) this.sql.exec("UPDATE signups SET access_until = ? WHERE email = ?", p.until, p.email);
      else this.sql.exec("INSERT INTO signups (email, name, company, role, created_at, access_until, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)", p.email, p.name, p.company, p.role || "", now, p.until, null);
      return reply({ ok: true, existed });
    }

    if (op === "list") {
      return reply({
        rows: this.sql.exec("SELECT email, name, company, role, created_at, access_until, last_seen, pw IS NOT NULL AS has_pw, referred_by, paid_at, ref_credited FROM signups ORDER BY created_at DESC").toArray(),
        credits: this.sql.exec("SELECT referrer, referred, at, days FROM credits ORDER BY at DESC").toArray(),
      });
    }

    if (op === "access") {
      this.sql.exec("UPDATE signups SET access_until = ? WHERE email = ?", p.until, p.email);
      return reply({ ok: true });
    }

    // ---------- activity ----------
    if (op === "track") {
      const day = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      this.sql.exec("INSERT INTO events (at, day, type, who, detail, src) VALUES (?, ?, ?, ?, ?, ?)", now, day, String(p.type || "").slice(0, 20), String(p.who || "").slice(0, 120), String(p.detail || "").slice(0, 200), String(p.src || "").slice(0, 80));
      if (Math.random() < 0.02) this.sql.exec("DELETE FROM events WHERE at < ?", now - 120 * DAY_MS);
      return reply({ ok: true });
    }

    if (op === "activity") {
      const since = new Date(now - (p.days || 14) * DAY_MS).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const week = now - 7 * DAY_MS;
      return reply({
        daily: this.sql.exec("SELECT day, type, COUNT(*) AS n, COUNT(DISTINCT who) AS u FROM events WHERE day >= ? GROUP BY day, type", since).toArray(),
        boardDaily: this.sql.exec("SELECT day, COUNT(DISTINCT who) AS u FROM events WHERE day >= ? AND type IN ('pass', 'view') AND detail = 'board' GROUP BY day", since).toArray(),
        week: this.sql.exec("SELECT type, COUNT(*) AS n, COUNT(DISTINCT who) AS u FROM events WHERE at > ? GROUP BY type", week).toArray(),
        boardWeek: (this.sql.exec("SELECT COUNT(DISTINCT who) AS u FROM events WHERE at > ? AND type IN ('pass', 'view') AND detail = 'board'", week).toArray()[0] || {}).u || 0,
        from: this.sql.exec("SELECT detail, COUNT(*) AS n FROM (SELECT detail FROM events WHERE at > ? AND type = 'visit' UNION ALL SELECT src AS detail FROM events WHERE at > ? AND type IN ('page', 'land')) GROUP BY detail ORDER BY n DESC LIMIT 15", week, week).toArray(),
        tagged: this.sql.exec("SELECT tag, COUNT(*) AS n, GROUP_CONCAT(DISTINCT page) AS pages FROM (SELECT detail AS tag, 'home page' AS page FROM events WHERE at > ? AND type = 'visit' AND detail LIKE 'via %' UNION ALL SELECT src AS tag, CASE WHEN type = 'page' THEN 'game pages' ELSE detail END AS page FROM events WHERE at > ? AND type IN ('page', 'land') AND src LIKE 'via %') GROUP BY tag ORDER BY n DESC", now - 30 * DAY_MS, now - 30 * DAY_MS).toArray(),
        games: this.sql.exec("SELECT detail, COUNT(*) AS n, COUNT(DISTINCT who) AS u FROM events WHERE at > ? AND (type IN ('lookup', 'page') OR (type IN ('view', 'pass') AND detail LIKE 'game %')) GROUP BY detail ORDER BY n DESC LIMIT 15", week).toArray(),
        recent: this.sql.exec("SELECT at, type, who, detail, src FROM events ORDER BY id DESC LIMIT 120").toArray(),
        emails: this.sql.exec("SELECT d.email, d.created_at, d.until, d.source, d.state, d.last_sent, d.sends, s.access_until FROM daily_emails d LEFT JOIN signups s ON s.email = d.email ORDER BY d.created_at DESC LIMIT 200").toArray(),
        discord: this.sql.exec("SELECT email, discord_at, discord_err, access_until FROM signups WHERE discord IS NOT NULL ORDER BY email").toArray(),
        lastPicks: (this.sql.exec("SELECT v FROM kv WHERE k = 'picks_last'").toArray()[0] || {}).v || null,
        lastAlerts: (this.sql.exec("SELECT v FROM kv WHERE k = 'alerts_last'").toArray()[0] || {}).v || null,
        alertsOn: (this.sql.exec("SELECT COUNT(*) AS n FROM buybox b JOIN signups u ON u.email = b.email LEFT JOIN alerts a ON a.email = b.email WHERE u.access_until > ? AND (a.state IS NULL OR a.state = 'on')", now).toArray()[0] || {}).n || 0,
      });
    }

    // ---------- the free plan ----------
    if (op === "free-used") {
      return reply({ uids: this.sql.exec("SELECT uid FROM free_lookups WHERE who = ? AND day = ?", String(p.who), String(p.day)).toArray().map((r) => Number(r.uid)) });
    }
    if (op === "free-add") {
      this.sql.exec("INSERT OR IGNORE INTO free_lookups (who, day, uid, at) VALUES (?, ?, ?, ?)", String(p.who), String(p.day), Number(p.uid), now);
      if (Math.random() < 0.05) this.sql.exec("DELETE FROM free_lookups WHERE at < ?", now - 7 * DAY_MS);
      return reply({ ok: true });
    }

    if (op === "kv-get") {
      return reply({ v: (this.sql.exec("SELECT v FROM kv WHERE k = ?", String(p.k)).toArray()[0] || {}).v || null });
    }
    if (op === "kv-set") {
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", String(p.k), String(p.v));
      return reply({ ok: true });
    }

    // ---------- the daily top 5 by email ----------
    if (op === "daily-email-add") {
      const row = this.sql.exec("SELECT state FROM daily_emails WHERE email = ?", p.email).toArray()[0];
      if (row && row.state === "on") return reply({ ok: true, already: true });
      if (row) {
        // Signing up again turns it back on, with a new free week for someone who isn't a member.
        this.sql.exec("UPDATE daily_emails SET state = 'on', until = MAX(until, ?), source = ? WHERE email = ?", p.until, p.source || "", p.email);
        const t = this.sql.exec("SELECT token FROM daily_emails WHERE email = ?", p.email).toArray()[0];
        return reply({ ok: true, fresh: true, token: t.token });
      }
      const today = this.sql.exec("SELECT COUNT(*) AS n FROM daily_emails WHERE created_at > ?", now - DAY_MS).toArray()[0].n;
      if (today >= (p.cap || 300)) return reply({ limited: true });
      this.sql.exec("INSERT INTO daily_emails (email, created_at, until, token, source) VALUES (?, ?, ?, ?, ?)", p.email, now, p.until, p.token, p.source || "");
      return reply({ ok: true, fresh: true, token: p.token });
    }
    if (op === "daily-email-get") {
      const row = this.sql.exec("SELECT state FROM daily_emails WHERE email = ?", p.email).toArray()[0];
      return reply({ on: !!row && row.state === "on" });
    }
    if (op === "daily-email-off") {
      this.sql.exec("UPDATE daily_emails SET state = 'off' WHERE email = ?", p.email);
      return reply({ ok: true });
    }
    if (op === "daily-email-unsub") {
      const row = this.sql.exec("SELECT email FROM daily_emails WHERE token = ?", p.token).toArray()[0];
      if (row) this.sql.exec("UPDATE daily_emails SET state = 'off' WHERE token = ?", p.token);
      return reply({ ok: !!row });
    }
    if (op === "daily-email-due") {
      return reply({ rows: this.sql.exec("SELECT d.email, d.until, d.token, d.sends, (s.access_until IS NOT NULL AND s.access_until > ?) AS member FROM daily_emails d LEFT JOIN signups s ON s.email = d.email WHERE d.state = 'on' AND (d.last_sent IS NULL OR d.last_sent != ?)", now, p.date).toArray() });
    }
    if (op === "daily-email-sent") {
      for (const r of p.rows || []) {
        this.sql.exec("UPDATE daily_emails SET last_sent = ?, sends = sends + 1, state = CASE WHEN ? THEN 'ended' ELSE state END WHERE email = ?", p.date, r.final ? 1 : 0, r.email);
      }
      return reply({ ok: true });
    }

    // ---------- the daily top 5 in Discord ----------
    if (op === "discord-set") {
      this.sql.exec("UPDATE signups SET discord = ?, discord_at = NULL, discord_err = NULL WHERE email = ?", p.url || null, p.email);
      return reply({ ok: true });
    }
    if (op === "discord-get") {
      const r = this.sql.exec("SELECT discord, discord_at, discord_err FROM signups WHERE email = ?", p.email).toArray()[0] || {};
      return reply(p.full ? { url: r.discord || null } : { set: !!r.discord, tail: r.discord ? r.discord.slice(-6) : null, at: r.discord_at || null, err: r.discord_err || null });
    }
    if (op === "discord-due") {
      return reply({ rows: this.sql.exec("SELECT email, discord AS url FROM signups WHERE discord IS NOT NULL AND access_until > ?", now).toArray() });
    }
    if (op === "discord-results") {
      for (const r of p.rows || []) {
        // A webhook Discord says no longer exists is removed, so we stop posting to it.
        if (r.gone) this.sql.exec("UPDATE signups SET discord = NULL, discord_at = ?, discord_err = 'removed in Discord' WHERE email = ?", now, r.email);
        else this.sql.exec("UPDATE signups SET discord_at = ?, discord_err = ? WHERE email = ?", now, r.ok ? null : String(r.err || "error").slice(0, 80), r.email);
      }
      return reply({ ok: true });
    }

    if (op === "delete") {
      this.sql.exec("DELETE FROM daily_emails WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM events WHERE who = ?", p.email);
      this.sql.exec("DELETE FROM free_lookups WHERE who = ?", p.email);
      this.sql.exec("DELETE FROM sessions WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM links WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM fails WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM credits WHERE referrer = ? OR referred = ?", p.email, p.email);
      this.sql.exec("DELETE FROM watch WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM buybox WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM alerts WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM alert_sent WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM lead_sends WHERE email = ?", p.email);
      this.sql.exec("UPDATE leads SET for_email = NULL WHERE for_email = ?", p.email);
      this.sql.exec("UPDATE signups SET referred_by = NULL WHERE referred_by = ?", p.email);
      this.sql.exec("DELETE FROM signups WHERE email = ?", p.email);
      return reply({ ok: true });
    }

    return new Response("Unknown operation", { status: 404 });
  }
}

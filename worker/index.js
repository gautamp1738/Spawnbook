// Spawnbook's Cloudflare Worker. It serves the static site in public/ and adds accounts:
// today's board and its data need a signed-in visitor whose access hasn't run out. Everything
// else (the landing page, the valuation tool, pricing, the policies) stays public.
//
// Routes
//   POST /api/signup        the landing page's form: makes an account with a password and signs the
//                           visitor in. The account runs on the browser's free pass (below), or
//                           starts one: one free day either way
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
//   GET  /lookup            look up any Roblox game, same access as the board
//   POST /api/daily-email   { email, source } signs up for the daily top 5 by email (free for 7 days
//                           without an account); signed in, { action: "off" } stops it. GET: status
//   GET|POST /unsubscribe?t= the link in every daily email
//   GET|POST /api/discord   a member's Discord webhook for the daily top 5: save, test, remove
//   /admin/activity         what people do on the site: visits, free passes, pages, lookups, sign-ups
//   GET  /api/lookup?q=     a link, place ID or name (or ?u=<universe ID>): the game's public numbers
//                           and a plain-English read of them (worker/lookup.js), cached 10 minutes a game
//   GET  /leads             verified leads: any signed-in account, even after its access ends, so a
//                           free lead still shows
//   GET  /api/buybox        what the signed-in buyer buys (genres, players, budget...), for matching
//   POST /api/buybox        saves it, as JSON
//   GET  /api/leads         the verified leads sent to the signed-in buyer
//   POST /api/leads         { id, status, note } as JSON: the buyer's own progress on a lead
//   POST /api/sell          the public "Open to selling?" form on /sell, from game owners
//   /admin                  accounts and access, behind the ADMIN_KEY secret (off until it's set)
//   /admin/leads            finding games for each buyer, asking owners, verifying and sending leads
//
// Once a day (the cron in wrangler.jsonc) the Worker also runs a check that adds new games for each
// buyer, flags leads whose game changed owner on Roblox, and emails a summary when Resend is set up
// (the RESEND_API_KEY secret, and optionally EMAIL_FROM).
//
// Accounts are kept in a Durable Object with SQLite storage (Store, below), which Cloudflare
// creates on deploy, so there's no database to set up. Passwords are stored only as salted
// PBKDF2 hashes, worked out inside the Durable Object, which has a much larger CPU allowance
// than the Worker itself.

import { lookup } from "./lookup.js";

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
      // Forms that change something must come from this site.
      if (request.method === "POST" && !sameOrigin(request, url)) res = new Response("Forbidden", { status: 403 });
      else if (path === "/api/signup") res = await signup(request, env, ctx);
      else if (path === "/api/signin") res = await signin(request, env);
      else if (path === "/api/signout") res = await signout(request, env);
      else if (path === "/api/password") res = await password(request, env);
      else if (path === "/api/me") res = await me(request, env);
      else if (path === "/api/referrals") res = await referrals(request, env, url);
      else if (path === "/api/teaser") res = await teaser(env, url);
      else if (path === "/api/watch") res = await watch(request, env);
      else if (path === "/api/live") res = await live(request, env, url);
      else if (path === "/api/buybox") res = await buybox(request, env);
      else if (path === "/api/leads") res = await myLeads(request, env);
      else if (path === "/api/sell") res = await sellForm(request, env);
      else if (path === "/api/lookup") res = await lookupApi(request, env, url, ctx);
      else if (path === "/api/daily-email") res = await dailyEmailApi(request, env, url, ctx);
      else if (path === "/api/discord") res = await discordApi(request, env, url, ctx);
      else if (path === "/unsubscribe") res = await unsubscribe(request, env, url);
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
      .then(() => sendDailyPicks(env, origin)).catch((e) => console.error("picks", e && e.stack || e)));
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
function track(env, ctx, type, who, detail) {
  const p = call(env, "track", { type, who: String(who || "").slice(0, 120), detail: String(detail || "").slice(0, 200) }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}
const passWho = (start) => "pass " + String(start || "").slice(-7);
function trackVisit(request, env, url, ctx) {
  if (isBot(request)) return;
  const raw = readCookie(request, TRIAL_COOKIE);
  const m = raw && /^(\d{13})\./.exec(raw);
  let from = "";
  try {
    const ref = request.headers.get("Referer");
    if (ref) { const h = new URL(ref).hostname.replace(/^www\./, ""); if (h && h !== url.hostname) from = h; }
  } catch (e) { /* no usable referrer */ }
  if (url.searchParams.get("ref")) from = from ? from + ", referral link" : "referral link";
  track(env, ctx, "visit", m ? passWho(m[1]) : "new visitor", from);
}

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
  const picks = board.slice().sort((a, b) => b[24] - a[24] || b[7] - a[7]).slice(0, 5).map((r) => {
    const mult = (r[25] && r[25][1]) || (r[21] === "staircase" ? 4.5 : 1.5);
    return { name: cleanName(r[1]), pid: r[0], uid: (r[26] && r[26].uid) || null, score: r[24], players: r[7], perDay: r[8], price: r[8] * 30 * 0.008 * mult, genre: r[5] || r[4] || "", age: r[6] };
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
  const back = (code) => redirect("/?e=" + code + "#signup");

  // Bots fill in every field, including the hidden one people never see.
  if (get("website")) return redirect("/");

  const name = get("name").slice(0, 120);
  const email = get("email").toLowerCase().slice(0, 200);
  const company = get("company").slice(0, 160);
  const role = get("role").slice(0, 60);
  const pw = String(form.get("password") || "");
  const ref = get("ref").toLowerCase();
  if (!name || !email || !company) return back("missing");
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
  if (r.exists) return redirect("/signin?e=exists");
  track(env, ctx, "signup", email, company);
  const headers = new Headers({ Location: nextPath("", r.until), "Cache-Control": "no-store" });
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
    return json({ access: "none", trial: t ? { active: t.active, start: t.start, until: t.until } : null });
  }
  return json({ access: s.until > Date.now() ? "active" : "expired", until: s.until, email: s.email, hasPassword: !!s.hasPassword });
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
  const s = await member(request, env);
  if (!s) return json({ error: "signin" }, 401);
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

// Look up any Roblox game: same access as the board (an active account, or a free pass that's still
// running). The work is in worker/lookup.js.
async function lookupApi(request, env, url, ctx) {
  const s = await session(request, env);
  let who;
  if (s) {
    if (s.until <= Date.now()) return json({ error: "subscribe" }, 403);
    who = s.email;
  } else {
    const t = await readTrial(request, env);
    if (!t) return json({ error: "signin" }, 401);
    if (!t.active) return json({ error: "subscribe" }, 403);
    who = passWho(t.start);
  }
  return lookup(env, url, (g) => { if (!url.searchParams.has("examples")) track(env, ctx, "lookup", who, String(g.name || "").slice(0, 120) + " u " + g.uid); });
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
  return json(await call(env, "buybox-set", { email: s.email, box: JSON.stringify(cleanBox(b || {})) }));
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
  const r = await call(env, "offer", {
    uid, pid: info.pid || pid, name, creator: String(c.name || "").slice(0, 120), ctype: c.type || null, cid: Number(c.id) || null,
    owner_user: owner ? owner.name : null, owner_user_id: owner ? owner.id : null,
    contact, age, deal, asking: asking ? asking : "",
    offer: JSON.stringify({ contact, role, deal, asking, notes, age }),
  });
  if (r.limited) return back("busy");
  if (r.fresh) {
    const link = new URL(request.url).origin + "/admin/leads?id=" + r.id + "#lead-" + r.id;
    await sendEmail(env, {
      to: OWNER_EMAIL,
      subject: "Open to selling: " + (name || "a Roblox game"),
      text: "Someone filled in the selling form.\n\nGame: " + (name || "Unknown") + " (" + gameUrl(info.pid || pid) + ")\nPlayers now: " + commas(info.players) + "\nContact: " + contact + "\nRole: " + role + "\nWould sell: " + DEALS[deal] + "\nAsking: " + (asking || "Not given") + "\nAge: " + AGES[age] + "\nNotes: " + (notes || "None") + "\n\nCheck it on Roblox before you reply, and ask for their Creator Dashboard recording:\n" + link,
    });
  }
  return done();
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
  if (s) {
    // An account decides on its own: a used-up account doesn't get a new free pass.
    if (s.until <= Date.now()) return shut("/subscribe");
  } else {
    const t = await readTrial(request, env);
    if (t && !t.active) return shut("/subscribe?over=1");
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
  if (path === "/admin/activity" || path === "/admin/picks/send") return adminActivity(request, env, url, path);

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
const ACT_TYPES = ["visit", "pass", "view", "lookup", "signup", "email", "discord"];
async function adminActivity(request, env, url, path) {
  if (path === "/admin/picks/send" && request.method === "POST") {
    const r = await sendDailyPicks(env, url.origin);
    const msg = r.skipped ? r.skipped : "Sent " + r.date + "'s top 5: " + r.discord + " Discord " + (r.discord === 1 ? "channel" : "channels") + (r.discordFailed ? " (" + r.discordFailed + " failed)" : "") + ", " + (r.emailsOff ? "no emails (Resend isn't connected yet)" : r.emails + " " + (r.emails === 1 ? "email" : "emails") + (r.emailError ? ", and some emails failed" : "")) + ".";
    return redirect("/admin/activity?sent=" + encodeURIComponent(msg) + "#picks");
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
    tile("Home page visitors", (wk.visit || {}).u || 0, commas((wk.visit || {}).n || 0) + " visits"),
    tile("Free passes started", (wk.pass || {}).u || 0),
    tile("People who opened the board", a.boardWeek),
    tile("Lookups", (wk.lookup || {}).n || 0, commas((wk.lookup || {}).u || 0) + " people"),
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
  const dayRows = days.map((d) => `<tr><th scope="row">${esc(day(d))}</th><td>${cell(d, "visit", "u")}</td><td>${cell(d, "pass")}</td><td>${commas(byDay[d].board || 0)}</td><td>${cell(d, "lookup")}</td><td>${cell(d, "signup")}</td><td>${cell(d, "email")}</td></tr>`).join("");
  const dayTable = days.length
    ? `<div class="table-box"><table><thead><tr><th scope="col">Day (Pacific)</th><th scope="col">Home page visitors</th><th scope="col">Free passes</th><th scope="col">Opened the board</th><th scope="col">Lookups</th><th scope="col">Accounts</th><th scope="col">Email sign-ups</th></tr></thead><tbody>${dayRows}</tbody></table></div>`
    : `<p>Nothing yet. Activity starts recording from today.</p>`;

  const fromList = a.from.length ? `<ul class="dlist">${a.from.map((r) => `<li>${esc(r.detail)}: ${commas(r.n)}</li>`).join("")}</ul>` : `<p class="small muted">No visits from other sites in the past week. Visits from a typed address, a bookmark or some apps show no source.</p>`;
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
<p>${last ? "Last sent: " + esc(last.date) + ", " + last.discord + " Discord " + (last.discord === 1 ? "channel" : "channels") + ", " + (last.emailsOff ? "emails off" : last.emails + " emails") + "." : "Nothing sent yet."} ${on} on the email list, ${a.discord.length} Discord ${a.discord.length === 1 ? "channel" : "channels"}.</p>
<form method="post" action="/admin/picks/send"><button class="button quiet" type="submit">Send today's top 5 now</button></form>${sentMsg}
<h3>Email list</h3>${emailTable}
<h3>Discord</h3>${a.discord.length ? `<ul class="dlist">${hookRows}</ul>` : "<p>No member has connected Discord yet.</p>"}</section>`;

  const label = (r) => {
    if (r.type === "visit") return "Opened the home page" + (r.detail ? " from " + r.detail : "");
    if (r.type === "pass") return "Started a free pass on the " + (r.detail.startsWith("game") ? "page for " + gameName(r.detail) : r.detail + " page");
    if (r.type === "view") return "Opened " + (r.detail.startsWith("game") ? "the page for " + gameName(r.detail) : "the " + r.detail + " page");
    if (r.type === "lookup") return "Looked up " + gameName(r.detail);
    if (r.type === "signup") return "Made an account" + (r.detail ? " (" + r.detail + ")" : "");
    if (r.type === "email") return "Signed up for the daily email" + (r.detail ? " on the " + r.detail : "");
    if (r.type === "discord") return "Connected Discord";
    return r.type + " " + r.detail;
  };
  const recent = a.recent.length
    ? `<div class="table-box"><table><thead><tr><th scope="col">When (Pacific)</th><th scope="col">Who</th><th scope="col">What</th></tr></thead><tbody>${a.recent.map((r) => `<tr><td>${esc(when(r.at))}</td><td>${esc(r.who)}</td><td>${esc(label(r))}</td></tr>`).join("")}</tbody></table></div>`
    : `<p>Nothing yet.</p>`;

  return page("Activity", `${adminNav("activity")}<h1 class="head">Activity</h1>
<p>What people do on Spawnbook, so you can tell whether outreach brings anyone in. "pass" and a number is one visitor without an account; accounts show their email. Bots and link previews are left out. Records are kept 120 days.</p>
<h2>Last 7 days</h2>${tiles}
<h2>Day by day</h2>${dayTable}
<div class="two"><section><h2>Where visitors came from</h2>${fromList}</section><section><h2>Games people looked at</h2>${gameList}</section></div>
${picks}
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
    out.push({ uid: Number(uid), name: g[0], pid: g[1], genre: g[2], genre2: g[3], creator: g[4], ctype: g[5], cid: g[6], age, players, visits, change, since: back ? HX.dates[back[0]] : null });
  }
  out.sort((a, b) => (b.change == null ? -9 : b.change) - (a.change == null ? -9 : a.change) || b.players - a.players);
  return out.slice(0, 60);
}

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
    return `<tr><td><a class="link" href="${esc(gameUrl(g.pid))}" target="_blank" rel="noopener">${esc(g.name)}</a><span class="sub">${esc(g.genre2 || g.genre || "")}</span></td><td>${g.age == null ? "–" : commas(g.age) + " days"}</td><td class="r">${commas(g.players)}</td><td class="r">${esc(ch)}${g.since ? `<span class="sub">since ${esc(shortDay(Date.parse(g.since) + 12 * 3600e3))}</span>` : ""}</td><td class="r">${commas(g.visits)}</td><td>${owner ? `<a class="link" href="${esc(owner)}" target="_blank" rel="noopener">${esc(g.creator || "Owner")}</a>` : esc(g.creator || "")}<span class="sub">${esc(g.ctype || "")}</span></td><td>${action}</td></tr>`;
  }).join("");
  const table = found.length
    ? `<div class="table-box"><table><thead><tr><th>Game</th><th>Age</th><th>Players at the last reading</th><th>Change in players</th><th>Visits</th><th>Owner on Roblox</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
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
    ].filter(Boolean).join(", ");
    const offerBlock = offer ? `<div class="offer"><h4>What the owner sent us${l.offered_at ? " on " + esc(shortDay(l.offered_at)) : ""}</h4><dl><dt>Contact</dt><dd>${esc(offer.contact)}</dd><dt>Role</dt><dd>${esc(offer.role)}</dd><dt>Would sell</dt><dd>${esc(DEALS[offer.deal] || "")}</dd><dt>Asking</dt><dd>${esc(offer.asking || "Not given")}</dd><dt>Age</dt><dd>${esc(AGES[offer.age] || "")}</dd><dt>Notes</dt><dd>${esc(offer.notes || "None")}</dd></dl><p class="small muted">They haven't agreed to share their contact with a specific buyer yet. Ask before you send it.</p></div>` : "";
    const sendList = sends.length
      ? `<ul class="sends">${sends.map((s) => `<li><strong>${esc(s.email)}</strong>, sent ${esc(shortDay(s.sent_at))}. Their status: ${esc(s.status)}${s.note ? `. Their note: ${esc(s.note)}` : ""}<form class="inline" method="post" action="/admin/leads/unsend"><input type="hidden" name="id" value="${l.id}"><input type="hidden" name="email" value="${esc(s.email)}"><button class="linkbutton small" type="submit">Take it back</button></form></li>`).join("")}</ul>`
      : "";
    const already = new Set(sends.map((s) => s.email));
    const sendForm = l.status === "verified"
      ? `<form class="inline" method="post" action="/admin/leads/send"><input type="hidden" name="id" value="${l.id}"><label class="sr-only" for="to-${l.id}">Buyer</label><select id="to-${l.id}" name="email" required>${buyerOptions(already)}</select><button class="button" type="submit">Send</button></form>`
      : `<p class="small muted">Mark it Verified to send it.</p>`;
    const f = (k) => esc(l[k] == null ? "" : l[k]);
    return `<details class="lead-row" id="lead-${l.id}"${l.id === openId ? " open" : ""}><summary>${esc(l.name || "Game " + l.pid)}${changed ? ` <span class="flag">Owner changed</span>` : ""}${l.source === "owner" && l.status === "willing" && !l.contact_ok ? ` <span class="flag">New from the selling form</span>` : ""}<span class="l-meta">${esc(meta)}</span></summary><div class="l-body">
<p class="small"><a class="link" href="${esc(gameUrl(l.pid))}" target="_blank" rel="noopener">Game on Roblox</a>${owner ? ` and its owner, <a class="link" href="${esc(owner)}" target="_blank" rel="noopener">${esc(l.creator || "on Roblox")}</a> (${esc(l.creator_type || "")})` : ""}. ${now ? commas(now.players) + " players and " + commas(now.visits) + " visits right now." : ""} Added ${esc(shortDay(l.created_at))}.${l.verified_at ? " Verified " + esc(shortDay(l.verified_at)) + "." : ""}</p>
${l.owner_user && l.owner_user_id ? `<p class="small">Run on Roblox by <a class="link" href="https://www.roblox.com/users/${esc(l.owner_user_id)}/profile" target="_blank" rel="noopener">${esc(l.owner_user)}</a>${l.creator_type === "Group" ? ", who owns the group" : ""}. <a class="link" href="https://x.com/search?q=${encodeURIComponent(l.owner_user)}&amp;f=user" target="_blank" rel="noopener">Search X for that name</a>: it's a search, not a confirmed account, so check it's really them. If you're signed in to Roblox, the game page also shows any Discord or X link they've added.</p>` : ""}
${changed ? `<p class="msg">Roblox now shows <strong>${esc(nowOwner.name)}</strong> (${esc(nowOwner.type)}) as the owner, not ${esc(l.creator)}. If you sent this lead to someone, the game may have sold. Ask them.</p>` : ""}
${offerBlock}
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
  const groups = order.map((st) => {
    const list = d.leads.filter((l) => l.status === st);
    return list.length ? `<h3>${esc(LEAD_STATUSES[st])} (${list.length})</h3>${list.map(leadBlock).join("")}` : "";
  }).join("");
  const add = `<form class="form add" id="add" method="post" action="/admin/leads/add"><h2 class="form-h">Add a game by its link</h2><div class="fields"><div class="field"><label for="ad-link">Roblox game link</label><input id="ad-link" name="link" required placeholder="https://www.roblox.com/games/…"></div><div class="field"><label for="ad-for">Found for <span class="opt">(optional)</span></label><select id="ad-for" name="for"><option value="">Nobody in particular</option>${boxes.map((b) => `<option value="${esc(b.email)}">${esc(b.email)}</option>`).join("")}</select></div></div><div class="form-row"><button class="button" type="submit">Add game</button></div></form>`;

  return page("Verified leads", `${adminNav("leads")}<h1 class="head">Verified leads</h1>
<p>Find games for each buyer, ask the owners, check their numbers, then send the lead. A buyer sees only the leads you send them, on their <a class="link" href="/leads">Leads page</a>.</p>
<ol class="steps small">
<li><strong>Find.</strong> Every evening the daily check adds up to ${AUTO_PER_BUYER} new games for each buyer, and owners who fill in the selling form at /sell show up on their own. You can also click Find games next to a buyer, or add a game by its link.</li>
<li><strong>Ask.</strong> Open the lead, copy the message and send it to the owner from X or Discord.</li>
<li><strong>Check.</strong> When they send a screen recording of their Creator Dashboard, compare it with the public numbers, fill in what they told you and set the status to Verified.</li>
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
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // Activity: one row per thing someone did (landing visit, free pass started, page opened, lookup,
    // sign-up), kept 120 days, for the admin activity page. "who" is an account's email, or "pass"
    // and a number for a visitor without an account.
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, type TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')");
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_day ON events (day)");
    // The daily top 5 by email. state: on, ended (a non-member's free week ran out) or off
    // (unsubscribed). Members with access get it for as long as they're members.
    this.sql.exec("CREATE TABLE IF NOT EXISTS daily_emails (email TEXT PRIMARY KEY, created_at INTEGER NOT NULL, until INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'on', last_sent TEXT, sends INTEGER NOT NULL DEFAULT 0)");
    // The daily top 5 in Discord: a member's webhook, and how the last post went.
    for (const col of ["discord TEXT", "discord_at INTEGER", "discord_err TEXT"]) {
      try { this.sql.exec("ALTER TABLE signups ADD COLUMN " + col); } catch (e) { /* already there */ }
    }
    this.seedOwner();
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
    const op = new URL(request.url).pathname.slice(1);
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
      const row = this.sql.exec("SELECT u.email AS email, u.access_until AS until, u.pw AS pw FROM sessions s JOIN signups u ON u.email = s.email WHERE s.token = ?", p.token).toArray()[0];
      if (!row) return reply({ email: null });
      this.sql.exec("UPDATE signups SET last_seen = ? WHERE email = ?", now, row.email);
      return reply({ email: row.email, until: row.until, hasPassword: !!row.pw });
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
      return reply({ box: r ? JSON.parse(r.box) : null, updated_at: r ? r.updated_at : null });
    }

    if (op === "buybox-set") {
      this.sql.exec("INSERT OR REPLACE INTO buybox (email, box, updated_at) VALUES (?, ?, ?)", p.email, p.box, now);
      return reply({ ok: true, box: JSON.parse(p.box), updated_at: now });
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
        this.sql.exec("UPDATE leads SET offer = ?, offered_at = ?, source = 'owner', auto = 0, status = CASE WHEN status IN ('found', 'asked', 'declined') THEN 'willing' ELSE status END, contact = CASE WHEN contact = '' THEN ? ELSE contact END, owner_age = CASE WHEN owner_age = 'unknown' THEN ? ELSE owner_age END, asking = CASE WHEN asking = '' THEN ? ELSE asking END, deal = CASE WHEN deal = '' THEN ? ELSE deal END, owner_user = COALESCE(owner_user, ?), owner_user_id = COALESCE(owner_user_id, ?), updated_at = ? WHERE id = ?", p.offer, now, p.contact, p.age, p.asking || "", p.deal || "", p.owner_user || null, p.owner_user_id || null, now, have.id);
      }
      return reply({ ok: true, fresh: true, id: this.sql.exec("SELECT id FROM leads WHERE uid = ?", p.uid).toArray()[0].id });
    }

    if (op === "lead-list") {
      return reply({
        leads: this.sql.exec("SELECT * FROM leads ORDER BY updated_at DESC").toArray(),
        sends: this.sql.exec("SELECT lead_id, email, sent_at, status, note, updated_at FROM lead_sends ORDER BY sent_at DESC").toArray(),
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
            this.sql.exec("INSERT INTO leads (uid, pid, name, creator, creator_type, creator_id, source, status, for_email, auto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scouted', 'found', ?, 1, ?, ?)", g.uid, g.pid || null, g.name || "", g.creator || "", g.ctype || null, g.cid || null, b.email, now, now);
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
      d.updates = this.sql.exec("SELECT s.lead_id AS id, l.name AS name, s.email AS email, s.status AS status FROM lead_sends s JOIN leads l ON l.id = s.lead_id WHERE s.updated_at > ? AND s.updated_at > s.sent_at AND s.status != 'new' ORDER BY s.updated_at DESC LIMIT 30", since).toArray();
      d.willing = this.sql.exec("SELECT COUNT(*) AS n FROM leads WHERE status = 'willing'").toArray()[0].n;
      d.stale = this.sql.exec("SELECT id, name, updated_at FROM leads WHERE status = 'asked' AND updated_at < ? ORDER BY updated_at LIMIT 20", now - 3 * DAY_MS).toArray()
        .map((r) => ({ id: r.id, name: r.name, days: Math.floor((now - r.updated_at) / DAY_MS) }));
      const newGames = d.found.reduce((n, f) => n + f.items.length, 0);
      d.any = !!(newGames || d.offers.length || d.changed.length || d.updates.length);
      const bits = [];
      if (newGames) bits.push(newGames + (newGames === 1 ? " new game" : " new games") + " for your buyers");
      if (d.offers.length) bits.push(d.offers.length + (d.offers.length === 1 ? " owner wants" : " owners want") + " to sell");
      if (d.changed.length) bits.push(d.changed.length + (d.changed.length === 1 ? " game changed owner" : " games changed owner"));
      if (d.updates.length) bits.push(d.updates.length + (d.updates.length === 1 ? " buyer update" : " buyer updates"));
      d.headline = bits.join(", ") || "nothing new";
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('daily_at', ?)", String(now));
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('digest', ?)", JSON.stringify(d));
      return reply({ ok: true, digest: d });
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
      this.sql.exec("INSERT INTO events (at, day, type, who, detail) VALUES (?, ?, ?, ?, ?)", now, day, String(p.type || "").slice(0, 20), String(p.who || "").slice(0, 120), String(p.detail || "").slice(0, 200));
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
        from: this.sql.exec("SELECT detail, COUNT(*) AS n FROM events WHERE at > ? AND type = 'visit' AND detail != '' GROUP BY detail ORDER BY n DESC LIMIT 12", week).toArray(),
        games: this.sql.exec("SELECT detail, COUNT(*) AS n, COUNT(DISTINCT who) AS u FROM events WHERE at > ? AND (type = 'lookup' OR (type IN ('view', 'pass') AND detail LIKE 'game %')) GROUP BY detail ORDER BY n DESC LIMIT 15", week).toArray(),
        recent: this.sql.exec("SELECT at, type, who, detail FROM events ORDER BY id DESC LIMIT 120").toArray(),
        emails: this.sql.exec("SELECT d.email, d.created_at, d.until, d.source, d.state, d.last_sent, d.sends, s.access_until FROM daily_emails d LEFT JOIN signups s ON s.email = d.email ORDER BY d.created_at DESC LIMIT 200").toArray(),
        discord: this.sql.exec("SELECT email, discord_at, discord_err, access_until FROM signups WHERE discord IS NOT NULL ORDER BY email").toArray(),
        lastPicks: (this.sql.exec("SELECT v FROM kv WHERE k = 'picks_last'").toArray()[0] || {}).v || null,
      });
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
      this.sql.exec("DELETE FROM sessions WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM links WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM fails WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM credits WHERE referrer = ? OR referred = ?", p.email, p.email);
      this.sql.exec("DELETE FROM watch WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM buybox WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM lead_sends WHERE email = ?", p.email);
      this.sql.exec("UPDATE leads SET for_email = NULL WHERE for_email = ?", p.email);
      this.sql.exec("UPDATE signups SET referred_by = NULL WHERE referred_by = ?", p.email);
      this.sql.exec("DELETE FROM signups WHERE email = ?", p.email);
      return reply({ ok: true });
    }

    return new Response("Unknown operation", { status: 404 });
  }
}

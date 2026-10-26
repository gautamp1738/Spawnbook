// Spawnbook's Cloudflare Worker. It serves the static site in public/ and adds accounts:
// today's board and its data need a signed-in visitor whose access hasn't run out. Everything
// else (the landing page, the valuation tool, pricing, the policies) stays public.
//
// Routes
//   POST /api/signup        the landing page's form: makes an account with a password, starts
//                           24 hours of free access and signs the visitor in with a cookie
//   POST /api/signin        email and password, from /signin
//   POST /api/signout       ends this browser's session
//   POST /api/password      sets a password, either from a one-time link (/account#t=...) or,
//                           for a signed-in visitor, from the change-password form on /account
//   GET  /api/me            { access: "none" | "active" | "expired", until, email, hasPassword }
//   GET  /api/teaser        today's top pick without its name, for the landing page
//   GET  /board             the full board, for signed-in visitors with access
//   GET  /data.js           the board's numbers, same rule
//   GET  /report            the weekly report and its archive, same rule
//   GET  /report.js         the report's numbers, same rule
//   GET  /track             the track record, public (its track.js names picks only after a week)
//   /admin                  accounts and access, behind the ADMIN_KEY secret (off until it's set)
//
// Accounts are kept in a Durable Object with SQLite storage (Store, below), which Cloudflare
// creates on deploy, so there's no database to set up. Passwords are stored only as salted
// PBKDF2 hashes, worked out inside the Durable Object, which has a much larger CPU allowance
// than the Worker itself.

const FREE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LINK_MS = 7 * DAY_MS; // how long a password link from the admin page works
const SESSION_COOKIE = "sb_session";
const SESSION_MAX_AGE = 60 * 24 * 60 * 60; // 60 days
const ADMIN_COOKIE = "sb_admin";
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalPath(url);
    let res;
    try {
      // Forms that change something must come from this site.
      if (request.method === "POST" && !sameOrigin(request, url)) res = new Response("Forbidden", { status: 403 });
      else if (path === "/api/signup") res = await signup(request, env);
      else if (path === "/api/signin") res = await signin(request, env);
      else if (path === "/api/signout") res = await signout(request, env);
      else if (path === "/api/password") res = await password(request, env);
      else if (path === "/api/me") res = await me(request, env);
      else if (path === "/api/teaser") res = await teaser(env, url);
      else if (path === "/data.js" || path === "/report.js") res = await gated(request, env, url, path);
      else if (path === "/board" || path.startsWith("/board.") || path.startsWith("/board/")) res = await gated(request, env, url, "/board");
      else if (path === "/report" || path.startsWith("/report.") || path.startsWith("/report/")) res = await gated(request, env, url, "/report");
      else if (path === "/admin" || path.startsWith("/admin/")) res = await admin(request, env, url, path);
      else res = await env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err && err.stack || err);
      res = new Response("Something went wrong on our side. Try again in a minute.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return secure(res);
  },
};

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
  const ok = ["/board", "/report", "/subscribe", "/account"];
  if (ok.includes(value)) return (value === "/board" || value === "/report") && until <= Date.now() ? "/subscribe" : value;
  return until > Date.now() ? "/board" : "/subscribe";
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

// ---------- accounts ----------

async function signup(request, env) {
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
  if (!name || !email || !company) return back("missing");
  if (!validEmail(email)) return back("email");
  const bad = passwordProblem(pw);
  if (bad) return back("password-" + bad);
  if (get("agree") !== "yes") return back("agree");

  const token = randomToken();
  const r = await call(env, "signup", { email, name, company, role, password: pw, token, freeMs: FREE_MS });
  if (r.exists) return redirect("/signin?e=exists");
  return redirect(nextPath("", r.until), { "Set-Cookie": sessionCookie(token) });
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
  if (!s) return json({ access: "none" });
  return json({ access: s.until > Date.now() ? "active" : "expired", until: s.until, email: s.email, hasPassword: !!s.hasPassword });
}

// ---------- the board ----------

async function gated(request, env, url, assetPath) {
  const s = await session(request, env);
  const isData = assetPath.endsWith(".js");
  if (!s || s.until <= Date.now()) {
    if (isData) {
      return new Response("/* Sign in at spawnbook.com to see today's board. */\n", {
        status: 401, headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return redirect(s ? "/subscribe" : "/signin?next=" + assetPath);
  }
  const asset = await env.ASSETS.fetch(new Request(new URL(assetPath, url), { headers: request.headers }));
  const res = new Response(asset.body, asset);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Robots-Tag", "noindex");
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

function page(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Spawnbook</title><link rel="stylesheet" href="/site.css"><style>
.admin { padding-block: 2rem 4rem; display: grid; gap: 1.5rem; }
.admin table { font-size: var(--step-small); }
.admin td, .admin th { padding: 0.6rem 0.75rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--surface-2); }
.admin form.inline { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.admin input[type=number] { width: 4.5rem; min-height: 2.5rem; padding: 0 0.5rem; border: 2px solid var(--field); background: var(--bg); }
.admin .button { min-height: 2.5rem; padding: 0 1rem; }
.admin input[type=password] { min-height: 3rem; padding: 0 0.75rem; border: 2px solid var(--field); background: var(--bg); width: min(100%, 22rem); }
.admin .add { max-width: 48rem; }
.admin .linkbox { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--step-small); background: var(--surface); padding: 1rem; overflow-wrap: anywhere; user-select: all; }
</style></head><body><main class="wrap admin">${body}</main></body></html>`, {
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

  if (path === "/admin/access" && request.method === "POST") {
    const form = await request.formData();
    const email = String(form.get("email") || "").toLowerCase();
    const days = Math.max(0, Math.min(3660, Number(form.get("days")) || 0));
    await call(env, "access", { email, until: Date.now() + days * DAY_MS });
    return redirect("/admin");
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

  const { rows } = await call(env, "list", {});

  if (path === "/admin/signups.csv") {
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const iso = (t) => (t ? new Date(t).toISOString() : "");
    const lines = [["signed_up", "name", "email", "studio_or_fund", "role", "access_until", "last_seen", "has_password"].join(",")]
      .concat(rows.map((r) => [iso(r.created_at), r.name, r.email, r.company, r.role, iso(r.access_until), iso(r.last_seen), r.has_pw ? "yes" : "no"].map(cell).join(",")));
    return new Response(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="spawnbook-signups.csv"', "Cache-Control": "no-store" },
    });
  }

  const now = Date.now();
  const when = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const body = rows.map((r) => {
    const status = r.access_until > now ? "Until " + when(r.access_until) : "Ended " + when(r.access_until);
    const id = esc(r.email);
    return `<tr><td>${esc(when(r.created_at))}</td><td>${esc(r.name)}</td><td><a class="link" href="mailto:${id}">${id}</a></td><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(status)}</td><td>${r.has_pw ? "Set" : "Not set"}</td>
<td><form class="inline" method="post" action="/admin/access"><input type="hidden" name="email" value="${id}"><label class="sr-only" for="d-${id}">Days of access for ${id}</label><input type="number" min="0" max="3660" id="d-${id}" name="days" value="31"><button class="button quiet" type="submit">Set days from now</button></form></td>
<td><form class="inline" method="post" action="/admin/link"><input type="hidden" name="email" value="${id}"><button class="button quiet" type="submit">Make a link</button></form></td>
<td><form class="inline" method="post" action="/admin/delete"><input type="hidden" name="email" value="${id}"><button class="button quiet" type="submit">Delete</button></form></td></tr>`;
  }).join("");
  const table = rows.length
    ? `<div class="table-box"><table><thead><tr><th>Signed up (Pacific)</th><th>Name</th><th>Email</th><th>Studio or fund</th><th>Role</th><th>Access</th><th>Password</th><th>Give access</th><th>Password link</th><th>Remove</th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<p>No accounts yet.</p>`;
  const addErr = url.searchParams.get("add") === "bad" ? `<p class="err" role="alert">Fill in a name, a valid email and a studio or fund.</p>` : "";
  const add = `<form class="form add" method="post" action="/admin/create"><h2>Add an account</h2><p class="small muted">For a subscriber who pays before signing up. You'll get a link to send them so they can choose a password.</p><div class="fields">
<div class="field"><label for="a-name">Name</label><input id="a-name" name="name" maxlength="120" required></div>
<div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" maxlength="200" required></div>
<div class="field"><label for="a-co">Studio or fund</label><input id="a-co" name="company" maxlength="160" required></div>
<div class="field"><label for="a-days">Days of access</label><input id="a-days" name="days" type="number" min="0" max="3660" value="31"></div>
</div><div class="form-row"><button class="button" type="submit">Add account</button></div>${addErr}</form>`;
  return page("Accounts", `<h1 class="head">Accounts</h1><p>${rows.length} ${rows.length === 1 ? "account" : "accounts"}. When someone pays, set their days of access (31 for a month). Set 0 to end someone's access. If someone forgets their password, make a link and send it to them. Delete removes a person completely, for example when they ask you to delete their data.</p><p><a class="button quiet" href="/admin/signups.csv">Download as a spreadsheet (CSV)</a></p>${table}${add}`);
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
    return this.sql.exec("SELECT email, access_until, pw FROM signups WHERE email = ?", email).toArray()[0];
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
      this.sql.exec("INSERT INTO signups (email, name, company, role, created_at, access_until, last_seen, pw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", p.email, p.name, p.company, p.role || "", now, now + p.freeMs, now, pw);
      this.newSession(p.token, p.email, now);
      return reply({ until: now + p.freeMs });
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
      return reply({ rows: this.sql.exec("SELECT email, name, company, role, created_at, access_until, last_seen, pw IS NOT NULL AS has_pw FROM signups ORDER BY created_at DESC").toArray() });
    }

    if (op === "access") {
      this.sql.exec("UPDATE signups SET access_until = ? WHERE email = ?", p.until, p.email);
      return reply({ ok: true });
    }

    if (op === "delete") {
      this.sql.exec("DELETE FROM sessions WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM links WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM fails WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM signups WHERE email = ?", p.email);
      return reply({ ok: true });
    }

    return new Response("Unknown operation", { status: 404 });
  }
}

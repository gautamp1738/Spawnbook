// Spawnbook's Cloudflare Worker. It serves the static site in public/ and adds the sign-up gate:
// today's board and its data need a signed-in visitor whose access hasn't run out. Everything
// else (the landing page, the valuation tool, pricing, the policies) stays public.
//
// Routes
//   POST /api/signup        the landing page's form: saves the sign-up, starts 24 hours of free
//                           access and signs the visitor in with a cookie
//   GET  /api/me            { access: "none" | "active" | "expired", until }
//   GET  /api/teaser        today's top pick without its name, for the landing page
//   GET  /board             the full board, for signed-in visitors with access
//   GET  /data.js           the board's numbers, same rule
//   /admin                  sign-ups and access, behind the ADMIN_KEY secret (off until it's set)
//
// Sign-ups are kept in a Durable Object with SQLite storage (Store, below), which Cloudflare
// creates on deploy, so there's no database to set up.

const FREE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "sb_session";
const SESSION_MAX_AGE = 60 * 24 * 60 * 60; // 60 days, so a returning visitor sees "expired" rather than a blank form
const ADMIN_COOKIE = "sb_admin";

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
      if (path === "/api/signup") res = await signup(request, env, url);
      else if (path === "/api/me") res = await me(request, env);
      else if (path === "/api/teaser") res = await teaser(env, url);
      else if (path === "/data.js") res = await gated(request, env, url, "/data.js");
      else if (path === "/board" || path.startsWith("/board.") || path.startsWith("/board/")) res = await gated(request, env, url, "/board");
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
  return s.email ? s : null;
}

// ---------- sign-up ----------

async function signup(request, env, url) {
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
  if (!name || !email || !company) return back("missing");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back("email");
  if (get("agree") !== "yes") return back("agree");

  const token = randomToken();
  const r = await call(env, "signup", { email, name, company, role, token, freeMs: FREE_MS });
  const cookie = SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=" + SESSION_MAX_AGE + "; HttpOnly; Secure; SameSite=Lax";
  return redirect(r.until > Date.now() ? "/board" : "/subscribe", { "Set-Cookie": cookie });
}

async function me(request, env) {
  const s = await session(request, env);
  if (!s) return json({ access: "none" });
  return json({ access: s.until > Date.now() ? "active" : "expired", until: s.until });
}

// ---------- the board ----------

async function gated(request, env, url, assetPath) {
  const s = await session(request, env);
  const isData = assetPath === "/data.js";
  if (!s || s.until <= Date.now()) {
    if (isData) {
      return new Response("/* Sign up at spawnbook.com to see today's board. */\n", {
        status: 401, headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return redirect(s ? "/subscribe" : "/#signup");
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
</style></head><body><main class="wrap admin">${body}</main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

async function isAdmin(request, env) {
  const c = readCookie(request, ADMIN_COOKIE);
  return !!c && c === (await sha256("spawnbook-admin:" + env.ADMIN_KEY));
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
    return page("Admin sign-in", `<h1 class="head">Sign-ups</h1><form method="post" action="/admin/login" class="stack"><label for="k">Admin password</label><input type="password" id="k" name="key" autocomplete="current-password" required><div><button class="button" type="submit">Sign in</button></div>${bad}</form>`);
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

  const { rows } = await call(env, "list", {});

  if (path === "/admin/signups.csv") {
    const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const iso = (t) => (t ? new Date(t).toISOString() : "");
    const lines = [["signed_up", "name", "email", "studio_or_fund", "role", "access_until", "last_seen"].join(",")]
      .concat(rows.map((r) => [iso(r.created_at), r.name, r.email, r.company, r.role, iso(r.access_until), iso(r.last_seen)].map(cell).join(",")));
    return new Response(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="spawnbook-signups.csv"', "Cache-Control": "no-store" },
    });
  }

  const now = Date.now();
  const when = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const body = rows.map((r) => {
    const status = r.access_until > now ? "Until " + when(r.access_until) : "Ended " + when(r.access_until);
    return `<tr><td>${esc(when(r.created_at))}</td><td>${esc(r.name)}</td><td><a class="link" href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(status)}</td>
<td><form class="inline" method="post" action="/admin/access"><input type="hidden" name="email" value="${esc(r.email)}"><label class="sr-only" for="d-${esc(r.email)}">Days of access for ${esc(r.email)}</label><input type="number" min="0" max="3660" id="d-${esc(r.email)}" name="days" value="31"><button class="button quiet" type="submit">Set days from now</button></form></td>
<td><form class="inline" method="post" action="/admin/delete"><input type="hidden" name="email" value="${esc(r.email)}"><button class="button quiet" type="submit">Delete</button></form></td></tr>`;
  }).join("");
  const table = rows.length
    ? `<div class="table-box"><table><thead><tr><th>Signed up (Pacific)</th><th>Name</th><th>Email</th><th>Studio or fund</th><th>Role</th><th>Access</th><th>Give access</th><th>Remove</th></tr></thead><tbody>${body}</tbody></table></div>`
    : `<p>No sign-ups yet.</p>`;
  return page("Sign-ups", `<h1 class="head">Sign-ups</h1><p>${rows.length} ${rows.length === 1 ? "person has" : "people have"} signed up. When someone pays, set their days of access (31 for a month). Set 0 to end someone's access. Delete removes a person completely, for example when they ask you to delete their data.</p><p><a class="button quiet" href="/admin/signups.csv">Download as a spreadsheet (CSV)</a></p>${table}`);
}

// ---------- Durable Object: sign-ups and sessions ----------

export class Store {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS signups (email TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL, access_until INTEGER NOT NULL, last_seen INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL)");
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const p = await request.json();
    const now = Date.now();
    const reply = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

    if (op === "signup") {
      const existing = this.sql.exec("SELECT access_until FROM signups WHERE email = ?", p.email).toArray()[0];
      if (existing) this.sql.exec("UPDATE signups SET last_seen = ? WHERE email = ?", now, p.email);
      else this.sql.exec("INSERT INTO signups (email, name, company, role, created_at, access_until, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)", p.email, p.name, p.company, p.role || "", now, now + p.freeMs, now);
      this.sql.exec("INSERT INTO sessions (token, email, created_at) VALUES (?, ?, ?)", p.token, p.email, now);
      const row = this.sql.exec("SELECT access_until FROM signups WHERE email = ?", p.email).toArray()[0];
      return reply({ until: row.access_until, isNew: !existing });
    }
    if (op === "session") {
      const row = this.sql.exec("SELECT u.email AS email, u.access_until AS until FROM sessions s JOIN signups u ON u.email = s.email WHERE s.token = ?", p.token).toArray()[0];
      if (row) this.sql.exec("UPDATE signups SET last_seen = ? WHERE email = ?", now, row.email);
      return reply(row ? { email: row.email, until: row.until } : { email: null });
    }
    if (op === "list") {
      return reply({ rows: this.sql.exec("SELECT email, name, company, role, created_at, access_until, last_seen FROM signups ORDER BY created_at DESC").toArray() });
    }
    if (op === "access") {
      this.sql.exec("UPDATE signups SET access_until = ? WHERE email = ?", p.until, p.email);
      return reply({ ok: true });
    }
    if (op === "delete") {
      this.sql.exec("DELETE FROM sessions WHERE email = ?", p.email);
      this.sql.exec("DELETE FROM signups WHERE email = ?", p.email);
      return reply({ ok: true });
    }
    return new Response("Unknown operation", { status: 404 });
  }
}

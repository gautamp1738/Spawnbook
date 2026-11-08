// One-time check: can Spawnbook read a game's analytics through Roblox's Open Cloud
// Analytics Query API with an owner's read-only key (universe-analytics, universe.analytics:read)?
//
// It asks for daily active users and daily revenue for the last 30 days and prints only whether
// each request worked and how much data came back. It never prints the numbers themselves or the
// key: this repository is public, so its Actions logs are too.
//
// Env: ROBLOX_ANALYTICS_KEY (secret), UNIVERSE_ID.

import { appendFileSync } from "node:fs";

const KEY = process.env.ROBLOX_ANALYTICS_KEY || "";
const UNIVERSE = (process.env.UNIVERSE_ID || "").trim();
const BASE = "https://apis.roblox.com/analytics-query-api";
const METRICS = ["DailyActiveUsers", "DailyRevenue"];
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

function iso(d) { return d.toISOString().replace(/\.\d{3}Z$/, "Z"); }

// The structure of a response with every value replaced by its type, so the shape can be
// logged publicly without the numbers.
function shape(o, depth = 0) {
  if (depth > 6) return "...";
  if (Array.isArray(o)) return o.length ? [`${o.length} items`, shape(o[0], depth + 1)] : ["empty"];
  if (o && typeof o === "object") { const r = {}; Object.keys(o).forEach((k) => { r[k] = shape(o[k], depth + 1); }); return r; }
  return typeof o;
}

// Find every data point ({ time, value } or { time, stringValues }) anywhere in a response.
function points(o, out = []) {
  if (Array.isArray(o)) { o.forEach((x) => points(x, out)); return out; }
  if (o && typeof o === "object") {
    if ("time" in o && ("value" in o || "stringValues" in o)) { out.push(o); return out; }
    Object.values(o).forEach((x) => points(x, out));
  }
  return out;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

async function query(metric) {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 30 * 864e5);
  let r = await call("POST", `${BASE}/v1/universes/${UNIVERSE}/metrics`, {
    metric, granularity: "OneDay", startTime: iso(start), endTime: iso(end),
  });
  // Slow queries come back as a long-running operation to poll (202 with done: false).
  let polls = 0;
  while (r.data && r.data.done === false && r.data.path && polls < 20) {
    await new Promise((ok) => setTimeout(ok, 3000));
    r = await call("GET", `${BASE}/${String(r.data.path).replace(/^\//, "")}`);
    polls++;
  }
  return { ...r, polls };
}

async function main() {
  say("## Roblox analytics key test");
  if (!KEY) { say("- No key found. Add a repository secret named ROBLOX_ANALYTICS_KEY (Settings > Secrets and variables > Actions)."); return finish(1); }
  if (!/^\d+$/.test(UNIVERSE)) { say("- UNIVERSE_ID is missing or not a number."); return finish(1); }
  say(`- Universe: ${UNIVERSE}`);
  let ok = 0;
  for (const m of METRICS) {
    try {
      const r = await query(m);
      if (r.status >= 200 && r.status < 300 && r.data && r.data.done !== false) {
        const pts = points(r.data);
        const withData = pts.filter((p) => Number(p.value) > 0).length;
        say(`- ${m}: worked (HTTP ${r.status}${r.polls ? `, after ${r.polls} polls` : ""}). ${pts.length} daily points returned, ${withData} of them above zero. Response fields: ${Object.keys(r.data).join(", ")}.`);
        say(`  Shape (field names and list lengths only, no values): ${JSON.stringify(shape(r.data.response)).slice(0, 600)}`);
        ok++;
      } else {
        const err = (r.data && (r.data.error || r.data.errors)) || null;
        const msg = err ? JSON.stringify(err).slice(0, 300) : (r.data && r.data.message) || "no error message";
        say(`- ${m}: failed (HTTP ${r.status}). ${msg}`);
      }
    } catch (e) {
      say(`- ${m}: request error: ${String(e && e.message || e).slice(0, 200)}`);
    }
  }
  say(ok === METRICS.length ? "\nResult: the key works. Spawnbook can read this game's players and revenue from Roblox." : ok ? "\nResult: partly worked." : "\nResult: didn't work. See the messages above.");
  finish(0);
}

function finish(code) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { appendFileSync(f, lines.join("\n") + "\n"); } catch (e) {} }
  process.exitCode = code;
}

main();

// Spawnbook cloud runner, v1.
// Runs the browser collector (collector.js, unchanged) in Node and moves its daily history
// in and out of the site's private database through plain JSON files.
//
//   NODE_USE_ENV_PROXY=1 node runner.mjs --state <dir> --out <dir> [--weekly]
//
// <state>/hist/*.json, <state>/picks/*.json  documents saved by ArtifactData list with out_dir
// <state>/code/collector.json                 {src} holding collector.js
//
// Writes to <out>: data.js, hist.json, batch.json, summary.json, and on weekly runs picks.json and picks.csv.
// batch.json is the list of database writes for ArtifactData "batch": the new snapshot, this week's
// picks, and deletes for snapshots the collector no longer keeps. Documents are written once and never
// edited, so every delete pins version 1.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const STATE = path.resolve(opt("--state") || "state");
const OUT = path.resolve(opt("--out") || "out");
const WEEKLY = args.includes("--weekly");
fs.mkdirSync(OUT, { recursive: true });

function readDocs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({
    id: f.slice(0, -5),
    doc: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")),
  }));
}

// History: one document per run; keep the latest reading for each Pacific date.
const histDocs = readDocs(path.join(STATE, "hist"));
const byDay = {};
for (const h of histDocs) {
  h.s = JSON.parse(h.doc.snap);
  if (!byDay[h.s.d] || byDay[h.s.d].s.t < h.s.t) byDay[h.s.d] = h;
}
const snaps = Object.values(byDay).map((h) => h.s).sort((a, b) => (a.t < b.t ? -1 : 1));

// Picks: one document per weekly issue; the latest document for a date wins.
const pickDocs = readDocs(path.join(STATE, "picks"));
const pickByDate = {};
for (const p of pickDocs) if (!pickByDate[p.doc.d] || pickByDate[p.doc.d].doc.t < p.doc.t) pickByDate[p.doc.d] = p;
const picks = Object.keys(pickByDate).sort().flatMap((d) => JSON.parse(pickByDate[d].doc.rows));

// The collector expects a browser: give it window and a localStorage backed by the documents above.
const store = new Map([
  ["br.hist.v1", JSON.stringify({ v: 1, snaps })],
  ["br.picks.v1", JSON.stringify(picks)],
]);
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const src = JSON.parse(fs.readFileSync(path.join(STATE, "code", "collector.json"), "utf8")).src;
(0, eval)(src);

let res;
try {
  res = await window.BRC.run({ weekly: WEEKLY });
} catch (e) {
  const fail = { ok: false, error: String((e && e.stack) || e) };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(fail, null, 1));
  console.log(JSON.stringify(fail));
  process.exit(1);
}

const docId = res.at.replace(/\.\d+Z$/, "Z"); // e.g. 2026-10-23T21:33:05Z
const hist = JSON.parse(store.get("br.hist.v1"));
const today = hist.snaps.find((s) => s.t === res.at);
fs.writeFileSync(path.join(OUT, "hist.json"), JSON.stringify({ d: today.d, t: today.t, n: Object.keys(today.g).length, snap: JSON.stringify(today) }));
fs.writeFileSync(path.join(OUT, "data.js"), window.__BR_LAST.dataJs);

const writes = [{ op: "set", collection: "hist", doc_id: docId, file_path: path.join(OUT, "hist.json") }];
if (WEEKLY) {
  const allPicks = JSON.parse(store.get("br.picks.v1"));
  const d = today.d;
  const rows = allPicks.filter((x) => x.d === d);
  fs.writeFileSync(path.join(OUT, "picks.json"), JSON.stringify({ d, t: res.at, n: rows.length, rows: JSON.stringify(rows) }));
  fs.writeFileSync(path.join(OUT, "picks.csv"), "date,rank,game,place_id,score,players,visits_per_day\n" + window.__BR_LAST.picksCsv + "\n");
  writes.push({ op: "set", collection: "picks", doc_id: docId, file_path: path.join(OUT, "picks.json") });
  for (const p of pickDocs) if (p.doc.d === d) writes.push({ op: "delete", collection: "picks", doc_id: p.id, if_version: 1 });
}
const keptT = new Set(hist.snaps.map((s) => s.t));
const stale = histDocs.filter((h) => !keptT.has(h.s.t)).map((h) => h.id);
for (const id of stale.slice(0, 50 - writes.length)) writes.push({ op: "delete", collection: "hist", doc_id: id, if_version: 1 });
fs.writeFileSync(path.join(OUT, "batch.json"), JSON.stringify(writes, null, 1));

const summary = Object.assign({}, res, { snapshotDoc: docId, databaseWrites: writes.length, staleSnapshots: stale.length });
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));

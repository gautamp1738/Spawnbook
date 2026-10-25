// Applies the history writes that runner.mjs lists in batch.json to the files in state/.
// runner.mjs was written for a database, so batch.json holds "set" and "delete" entries;
// here each document is a JSON file at state/<collection>/<doc_id>.json.
//
//   node apply-batch.mjs <batch.json> <state dir>
//
// Document ids are timestamps like 2026-10-25T02:24:27Z. Colons aren't allowed in Windows
// file names, so they're stored with dashes instead (2026-10-25T02-24-27Z.json).
import fs from "node:fs";
import path from "node:path";

const [batchPath, stateDir] = process.argv.slice(2);
if (!batchPath || !stateDir) {
  console.error("Usage: node apply-batch.mjs <batch.json> <state dir>");
  process.exit(2);
}

const writes = JSON.parse(fs.readFileSync(batchPath, "utf8"));
const fileName = (id) => id.replace(/:/g, "-") + ".json";

for (const w of writes) {
  const dir = path.join(stateDir, w.collection);
  const file = path.join(dir, fileName(w.doc_id));
  if (w.op === "set") {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(w.file_path, file);
  } else if (w.op === "delete") {
    fs.rmSync(file, { force: true });
  } else {
    throw new Error("Unknown write: " + JSON.stringify(w));
  }
}
console.log("Applied " + writes.length + " history writes.");

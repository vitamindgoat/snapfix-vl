import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "dataset");
const destDir = path.join(root, "public", "dataset");
const manifestPath = path.join(destDir, "manifest.json");
const imageExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function writeEmptyManifest() {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({ files: [] }, null, 2)}\n`);
}

if (!fs.existsSync(srcDir)) {
  writeEmptyManifest();
  process.exit(0);
}

const files = fs
  .readdirSync(srcDir)
  .filter((name) => imageExt.has(path.extname(name).toLowerCase()))
  .sort();

fs.mkdirSync(destDir, { recursive: true });

for (const name of files) {
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}

for (const existing of fs.readdirSync(destDir)) {
  if (existing === "manifest.json") continue;
  if (!files.includes(existing)) {
    fs.unlinkSync(path.join(destDir, existing));
  }
}

fs.writeFileSync(manifestPath, `${JSON.stringify({ files }, null, 2)}\n`);
console.log(`Synced ${files.length} dataset image(s) to public/dataset/`);

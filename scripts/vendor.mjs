/* Vendors the @chenglou/pretext ESM modules into vendor/pretext/ so the site
   stays fully self-hosted (strict CSP: script-src 'self', no CDN).
   Run: pnpm vendor   (or: node scripts/vendor.mjs)
   Re-run after `pnpm install` if the dependency is upgraded. */
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@chenglou", "pretext", "dist");
const dest = join(root, "vendor", "pretext");

function walk(dir, base, files) {
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".d.ts") || entry.endsWith(".map") || entry.endsWith(".d.ts.map")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, files);
    else if (entry.endsWith(".js")) files.push(relative(base, full));
  }
  return files;
}

const files = walk(src, src, []);
for (const rel of files) {
  const target = join(dest, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(src, rel), target);
  console.log("vendored", rel);
}
console.log(`done: ${files.length} files -> vendor/pretext/`);

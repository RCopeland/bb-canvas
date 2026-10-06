// Refresh the vendored Excalidraw stylesheet in canvas/vendor/.
//
// Why this exists: @excalidraw/excalidraw gates its CSS behind
// "development"/"production" exports conditions that `bb plugin build`'s
// bundler does not enable, and its `exports` map blocks every subpath — so the
// stylesheet cannot be imported as a specifier at all. It is copied in instead,
// the same "vendor source you own" approach the plugin guide uses for
// components. The @font-face blocks are stripped because the bundler has no
// .woff2 loader and Excalidraw loads fonts at runtime from
// EXCALIDRAW_ASSET_PATH anyway.
//
// Run after upgrading the excalidraw dependency:  node scripts/vendor-excalidraw.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(
  root,
  "node_modules/@excalidraw/excalidraw/dist/prod/index.css",
);
const target = join(root, "canvas/vendor/excalidraw.css");

const css = readFileSync(source, "utf8");
const stripped = css.replace(/@font-face\{[^}]*\}/g, "");
const removed = css.length - stripped.length;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, stripped);
console.log(
  `vendored excalidraw.css (${stripped.length} bytes, stripped ${removed} bytes of @font-face)`,
);

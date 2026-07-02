/**
 * Browser-bundle build for @kubit-ai/sentry.
 *
 * Produces a single self-contained IIFE that exposes `window.KubitSentry`,
 * with `@sentry/browser` bundled in — so a site with no bundler can load it
 * via one `<script>` tag. Output: dist/browser/kubit-sentry.global.js.
 *
 *   npm run build:browser
 */

import { rmSync } from "node:fs";
import { build } from "esbuild";

const outfile = "dist/browser/kubit-sentry.global.js";

await build({
  entryPoints: ["src/browser.ts"],
  bundle: true,
  format: "iife",
  globalName: "KubitSentry",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  // No sourcemap: this is a public prebuilt IIFE, and an inlined-sources map
  // embeds all of @sentry/* (~3 MB) for little consumer benefit — keep the
  // published bundle slim.
  sourcemap: false,
  // Sentry references process.env.NODE_ENV; inline it so the bundle has no
  // `process` dependency in the browser.
  define: { "process.env.NODE_ENV": '"production"' },
  outfile,
});

// Remove any stale map from a previous `sourcemap: true` build so it can never
// be packed into the published tarball (dist is gitignored but shipped via the
// package.json `files` allowlist).
rmSync(`${outfile}.map`, { force: true });

console.log(`built ${outfile}`);

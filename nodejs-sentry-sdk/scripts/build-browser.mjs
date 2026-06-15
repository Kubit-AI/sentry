/**
 * Browser-bundle build for @kubit-ai/sentry.
 *
 * Produces a single self-contained IIFE that exposes `window.KubitSentry`,
 * with `@sentry/browser` bundled in — so a site with no bundler can load it
 * via one `<script>` tag. Output: dist/browser/kubit-sentry.global.js.
 *
 *   npm run build:browser
 */

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
  sourcemap: true,
  // Sentry references process.env.NODE_ENV; inline it so the bundle has no
  // `process` dependency in the browser.
  define: { "process.env.NODE_ENV": '"production"' },
  outfile,
});

console.log(`built ${outfile}`);

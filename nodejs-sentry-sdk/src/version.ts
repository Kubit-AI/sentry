/**
 * SDK version, stamped onto the OTLP instrumentation scope
 * (`scopeSpans[].scope.version`).
 *
 * This package runs in browsers, so it cannot read `package.json` at runtime
 * the way the sibling nodejs-sdk does (`fs.readFileSync`). Instead the value
 * is pinned here and `tests/version.test.ts` asserts it matches
 * `package.json` — `prepublishOnly` runs the tests, so a release with a
 * drifted version cannot reach npm.
 */
export const SDK_VERSION = "0.3.2";

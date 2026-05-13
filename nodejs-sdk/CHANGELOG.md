# Changelog

## 0.7.2

### Fixed

- `KubitSpanProcessor.onEnd` now also stamps `kubit.sdk.name` and `kubit.sdk.version` on the span (in addition to the existing `onStart` stamping). This covers bridge-exporter integrations that synthesize a `ReadableSpan` and call `onEnd` directly without going through `onStart` (e.g. Mastra's `KubitMastraExporter`). Existing attributes are not overwritten.
- `SDK_NAME` and `VERSION` are now read from `package.json` at load time instead of being hardcoded in `src/version.ts`. 

## 0.7.1

### Added

- `KubitExporter.export()` now logs at `debug` after each successful batch (`Exported batch to kubit  span_count=N`) and at `warn` after a failed batch. Honors `KUBIT_OTEL_LOG_LEVEL`.

## 0.7.0

**Breaking change.** The SDK now ships spans directly over OTLP/HTTP. The client-side credential exchange has been removed; the API key is sent in the `x-api-key` request header on each export.

### Changed

- `tokenEndpoint` → `endpoint` on `configure()`, `KubitSpanProcessor`, and `KubitExporter`. Resolution order (first non-empty wins): explicit option → `KUBIT_OTEL_ENDPOINT` → `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` → default `https://otel.kubit.ai/v1/traces`.

### Removed

- `transformSpans` and the `KubitRecord` type.
- `@aws-sdk/client-kinesis` runtime dependency.

### Added

- `@opentelemetry/exporter-trace-otlp-proto` peer dependency.

### Migration

```ts
// Before
configure({ apiKey: "rg.v1.xxx", tokenEndpoint: "https://..." });

// After — omit endpoint to use the default
configure({ apiKey: "rg.v1.xxx", endpoint: "https://..." });
```

# Changelog

## 0.7.0

**Breaking change.** The SDK now ships spans directly over OTLP/HTTP. The client-side credential exchange has been removed; the API key is sent in the `x-api-key` request header on each export.

### Changed

- `tokenEndpoint` → `endpoint` on `configure()`, `KubitSpanProcessor`, and `KubitExporter`. Resolution order (first non-empty wins): explicit option → `KUBIT_OTEL_ENDPOINT` → `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` → default `https://kubit-ingest.kubit.ai/v1/traces`.

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

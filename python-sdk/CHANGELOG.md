# Changelog

## 0.7.1

### Added

- `KubitExporter.export()` now logs at `debug` after each successful batch (`Exported batch to kubit  span_count=N`) and at `warn` after a failed batch. Honors `KUBIT_OTEL_LOG_LEVEL`.

### Changed

- The `kubit_otel` logger now defaults to `info` and installs a dedicated `sys.stderr` handler with a `[kubit-otel <level>]` prefix — matching the Node SDK. Previously, `KUBIT_OTEL_LOG_LEVEL` only took effect when set, and `info` records were swallowed by Python's stdlib defaults. The logger is configured with `propagate=False` to avoid double-logging when the application also configures root.

## 0.7.0

**Breaking change.** The SDK now ships spans directly over OTLP/HTTP. The client-side credential exchange has been removed; the API key is sent in the `x-api-key` request header on each export.

### Changed

- `token_endpoint` → `endpoint` on `configure()`, `attach()`, `KubitSpanProcessor`, and `KubitExporter`. Resolution order (first non-empty wins): explicit arg → `KUBIT_OTEL_ENDPOINT` → `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` → default `https://otel.kubit.ai/v1/traces`.

### Removed

- `transform_spans` and the `kubit_otel.transformer` package.
- `boto3` and `httpx` runtime dependencies.

### Added

- `opentelemetry-exporter-otlp-proto-http` runtime dependency.

### Migration

```python
# Before
configure(api_key="rg.v1.xxx", token_endpoint="https://...")

# After — omit endpoint to use the default
configure(api_key="rg.v1.xxx", endpoint="https://...")
```

# Changelog

## 0.7.0

**Breaking change.** The SDK now ships spans directly over OTLP/HTTP. The client-side credential exchange has been removed; the API key is sent in the `x-api-key` request header on each export.

### Changed

- `token_endpoint` → `endpoint` on `configure()`, `attach()`, `KubitSpanProcessor`, and `KubitExporter`. Resolution order (first non-empty wins): explicit arg → `KUBIT_OTEL_ENDPOINT` → `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` → default `https://kubit-ingest.kubit.ai/v1/traces`.

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

/**
 * OTel ReadableSpan → Kubit JSON record transformer.
 *
 * Converts OpenTelemetry SDK ReadableSpan objects into flat JSON-serialisable
 * objects matching the Kubit analytics schema.
 *
 * Two entity types are produced:
 *   - `trace`                 one per unique trace_id (from root spans)
 *   - `enriched_observation`  one per span (including root spans)
 *
 * Every span received is transformed — scope/attribute filtering lives upstream
 * in {@link KubitSpanProcessor} (see `spanFilter.ts`). Consumers wiring their
 * own processor around `KubitExporter` can apply the same helpers or substitute
 * their own.
 *
 * Framework-specific attribute mappings live under
 * `./frameworks/*` as self-contained adapter modules. `core` consults each
 * in registry order to build the canonical alias tuples, parse JSON blobs,
 * and resolve the observation type.
 */

export { transformSpans, type KubitRecord } from "./core";

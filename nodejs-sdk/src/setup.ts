/**
 * Convenience setup — one-liner to configure OTel with Kubit exporter.
 */

import { trace, type TracerProvider } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { DEFAULT_TOKEN_ENDPOINT } from "./credentials";
import { logger, redactEndpoint } from "./logger";
import { KubitSpanProcessor } from "./processor";
import type { ShouldExportSpan } from "./spanFilter";

export interface ConfigureOptions {
  /** Kubit API key (`rg.v1.<payload>.<sig>`). */
  apiKey: string;
  /** Name of the service (maps to `service.name` resource attribute). */
  serviceName?: string;
  /** Version of the service. */
  serviceVersion?: string;
  /** URL of the credential endpoint. */
  tokenEndpoint?: string;
  /** Additional OTel resource attributes to include. */
  resourceAttributes?: Record<string, string>;
  /**
   * Predicate deciding which spans are forwarded to Kubit. See
   * {@link isDefaultExportSpan}. Defaults to LLM-only filtering.
   */
  shouldExportSpan?: ShouldExportSpan;
}

export interface AttachOptions {
  /** Kubit API key (`rg.v1.<payload>.<sig>`). */
  apiKey: string;
  /** URL of the credential endpoint. */
  tokenEndpoint?: string;
  /** Predicate deciding which spans are forwarded to Kubit. */
  shouldExportSpan?: ShouldExportSpan;
}

/**
 * Structural shape of an SDK ``TracerProvider`` we can attach a processor to.
 *
 * We avoid importing the concrete ``BasicTracerProvider`` class because
 * ``@opentelemetry/sdk-trace-base`` is a peer dependency and we don't want to
 * pay for it in this file just to `instanceof`-check.
 */
interface AttachableProvider {
  addSpanProcessor: (processor: unknown) => void;
  resource: Resource;
}

function buildResource(
  serviceName: string,
  serviceVersion: string | undefined,
  extra: Record<string, string> | undefined,
): Resource {
  const attrs: Record<string, string> = { "service.name": serviceName };
  if (serviceVersion) attrs["service.version"] = serviceVersion;
  if (extra) Object.assign(attrs, extra);
  return new Resource(attrs);
}

/**
 * Return the underlying SDK provider currently active, unwrapping the
 * ``ProxyTracerProvider`` that ``trace.getTracerProvider()`` always returns.
 *
 * JS's global API stores registrations on an internal proxy; its ``getDelegate``
 * method exposes whatever real provider has been registered (or
 * ``NoopTracerProvider`` if none).
 */
function getActiveProvider(): TracerProvider {
  const current = trace.getTracerProvider();
  const maybeProxy = current as { getDelegate?: () => TracerProvider };
  if (typeof maybeProxy.getDelegate === "function") {
    return maybeProxy.getDelegate();
  }
  return current;
}

/**
 * Whether ``provider`` is an SDK provider we can attach to.
 *
 * The OTel JS API's ``ProxyTracerProvider`` is marked ``@deprecated`` and
 * scheduled for removal, so duck-type on ``addSpanProcessor`` / ``resource``
 * rather than ``instanceof``. Covers ``NoopTracerProvider`` and any other
 * non-SDK shape by falling through to the false branch.
 */
function isAttachableProvider(
  provider: TracerProvider,
): provider is TracerProvider & AttachableProvider {
  const p = provider as Partial<AttachableProvider>;
  return typeof p.addSpanProcessor === "function" && p.resource instanceof Resource;
}

/**
 * Configure OpenTelemetry with the Kubit exporter.
 *
 * This is the simplest way to get started:
 *
 * ```ts
 * import { configure } from "@kubit-ai/otel";
 * const provider = configure({ apiKey: "rg.v1.xxx", serviceName: "my-app" });
 * ```
 *
 * If another library (e.g. Langfuse) has already installed a real
 * `TracerProvider` as global, this function attaches `KubitSpanProcessor` to
 * that provider and merges the supplied resource attributes into it — no
 * replacement, so both SDKs coexist regardless of import order. Otherwise it
 * creates a new `NodeTracerProvider` and registers it as the global provider.
 *
 * @returns The provider now driving Kubit export — either the freshly-registered
 * one or the pre-existing one we attached to.
 */
export function configure(options: ConfigureOptions): TracerProvider {
  const serviceName = options.serviceName ?? "default";
  const tokenEndpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const ourResource = buildResource(
    serviceName,
    options.serviceVersion,
    options.resourceAttributes,
  );
  const processor = new KubitSpanProcessor({
    apiKey: options.apiKey,
    tokenEndpoint,
    shouldExportSpan: options.shouldExportSpan,
  });

  const existing = getActiveProvider();
  let provider: TracerProvider;
  let branch: "attached" | "registered";

  if (isAttachableProvider(existing)) {
    // On key collision, merge(other) lets `other` take precedence — so our
    // attrs override whatever the existing provider set. This mirrors the
    // Python implementation and matches what Langfuse / OpenLLMetry do.
    existing.resource = existing.resource.merge(ourResource);
    existing.addSpanProcessor(processor);
    provider = existing;
    branch = "attached";
  } else {
    const fresh = new NodeTracerProvider({ resource: ourResource });
    fresh.addSpanProcessor(processor);
    fresh.register();
    provider = fresh;
    branch = "registered";
  }

  logger.info(
    `kubit_otel configured  mode=${branch} service_name=${serviceName} ` +
      `service_version=${options.serviceVersion ?? "-"} ` +
      `token_host=${redactEndpoint(tokenEndpoint)}`,
  );

  return provider;
}

/**
 * Attach `KubitSpanProcessor` to the currently-registered global provider.
 *
 * Unlike {@link configure}, this never registers a new provider — it throws if
 * no real SDK provider is in place yet. Intended for apps that let another
 * library (Langfuse, OpenLLMetry, an OTel-distro, …) own provider setup and
 * just want to add Kubit as another sink.
 */
export function attach(options: AttachOptions): TracerProvider {
  const tokenEndpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const existing = getActiveProvider();
  if (!isAttachableProvider(existing)) {
    throw new Error(
      "kubit-ai/otel attach() requires a TracerProvider already registered " +
        "as the global OTel provider. Call configure() instead, or install a " +
        "provider first (e.g. via Langfuse or @opentelemetry/sdk-trace-node).",
    );
  }
  existing.addSpanProcessor(
    new KubitSpanProcessor({
      apiKey: options.apiKey,
      tokenEndpoint,
      shouldExportSpan: options.shouldExportSpan,
    }),
  );
  logger.info(`kubit_otel attached  token_host=${redactEndpoint(tokenEndpoint)}`);
  return existing;
}

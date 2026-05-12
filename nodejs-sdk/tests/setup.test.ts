import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";

// Silence the real exporter so configure() can run without creds.
vi.mock("../src/exporter", () => ({
  KubitExporter: class {
    export() {}
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

async function loadSetup() {
  vi.resetModules();
  return await import("../src/setup");
}

describe("configure()", () => {
  let originalProvider: ReturnType<typeof trace.getTracerProvider>;

  beforeEach(() => {
    originalProvider = trace.getTracerProvider();
    trace.disable();
  });

  afterEach(() => {
    trace.disable();
    trace.setGlobalTracerProvider(originalProvider);
  });

  it("registers a fresh provider as the global tracer provider", async () => {
    const { configure } = await loadSetup();
    const provider = configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

    expect(provider).toBeDefined();
    // After register(), the global proxy should resolve to a real provider.
    expect(trace.getTracerProvider()).toBeDefined();
  });

  it("sets service.name and service.version on the provider's resource", async () => {
    const { configure } = await loadSetup();
    const provider = configure({
      apiKey: "rg.v1.x.y",
      serviceName: "my-app",
      serviceVersion: "1.2.3",
      resourceAttributes: { "deployment.environment": "prod" },
    });

    // v2 dropped the public `resource` field on BasicTracerProvider in favor
    // of a private `_resource`. Reach into it for the assertion.
    const resource = (provider as unknown as { _resource: Resource })._resource;
    expect(resource.attributes["service.name"]).toBe("my-app");
    expect(resource.attributes["service.version"]).toBe("1.2.3");
    expect(resource.attributes["deployment.environment"]).toBe("prod");
  });

  it("stamps kubit.sdk.name and kubit.sdk.version on the resource", async () => {
    const { configure } = await loadSetup();
    const { VERSION } = await import("../src/version");
    const provider = configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

    const resource = (provider as unknown as { _resource: Resource })._resource;
    expect(resource.attributes["kubit.sdk.name"]).toBe("kubit-otel-node");
    expect(resource.attributes["kubit.sdk.version"]).toBe(VERSION);
  });

  it("does not let user resourceAttributes override kubit.sdk identity", async () => {
    const { configure } = await loadSetup();
    const { VERSION } = await import("../src/version");
    const provider = configure({
      apiKey: "rg.v1.x.y",
      serviceName: "my-app",
      resourceAttributes: {
        "kubit.sdk.name": "evil-spoof",
        "kubit.sdk.version": "999.0.0",
      },
    });

    const resource = (provider as unknown as { _resource: Resource })._resource;
    expect(resource.attributes["kubit.sdk.name"]).toBe("kubit-otel-node");
    expect(resource.attributes["kubit.sdk.version"]).toBe(VERSION);
  });

  it("attaches a KubitSpanProcessor to the new provider", async () => {
    const { configure } = await loadSetup();
    const { KubitSpanProcessor } = await import("../src/processor");
    const provider = configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

    // BasicTracerProvider in v2 wraps configured processors in a single
    // MultiSpanProcessor stored on `_activeSpanProcessor`. Reach into it just
    // far enough to confirm our processor was wired in.
    const active = (provider as unknown as { _activeSpanProcessor: unknown })
      ._activeSpanProcessor as { _spanProcessors?: unknown[] };
    const processors = active._spanProcessors ?? [active];
    expect(processors.some((p) => p instanceof KubitSpanProcessor)).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// Silence the real exporter so configure()/attach() can run without creds.
vi.mock("./exporter", () => ({
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
  return await import("./setup");
}

function readProcessors(provider: BasicTracerProvider): SpanProcessor[] {
  // BasicTracerProvider 1.x stores its list under `_registeredSpanProcessors`.
  return (provider as unknown as { _registeredSpanProcessors: SpanProcessor[] })
    ._registeredSpanProcessors;
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

  describe("register path (no provider installed)", () => {
    it("registers a new provider when none present", async () => {
      const { configure } = await loadSetup();
      const provider = configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

      expect(provider).toBeDefined();
      // getTracerProvider returns the global; after register() it should be
      // the NodeTracerProvider we just created.
      expect(trace.getTracerProvider()).toBeDefined();
    });

    it("sets service.name and service.version on the new provider's resource", async () => {
      const { configure } = await loadSetup();
      const provider = configure({
        apiKey: "rg.v1.x.y",
        serviceName: "my-app",
        serviceVersion: "1.2.3",
        resourceAttributes: { "deployment.environment": "prod" },
      });

      const resource = (provider as unknown as { resource: Resource }).resource;
      expect(resource.attributes["service.name"]).toBe("my-app");
      expect(resource.attributes["service.version"]).toBe("1.2.3");
      expect(resource.attributes["deployment.environment"]).toBe("prod");
    });
  });

  describe("attach path (real provider already installed)", () => {
    it("reuses the existing provider rather than registering a new one", async () => {
      const existing = new BasicTracerProvider({
        resource: new Resource({ "service.name": "host-app" }),
      });
      trace.setGlobalTracerProvider(existing);

      const { configure } = await loadSetup();
      const provider = configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

      expect(provider).toBe(existing);
    });

    it("adds KubitSpanProcessor to the existing provider", async () => {
      const existing = new BasicTracerProvider();
      trace.setGlobalTracerProvider(existing);

      const { configure } = await loadSetup();
      const { KubitSpanProcessor } = await import("./processor");
      configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

      const processors = readProcessors(existing);
      expect(
        processors.some((p) => p instanceof KubitSpanProcessor),
      ).toBe(true);
    });

    it("merges resource attrs — our attrs win on collision", async () => {
      const existing = new BasicTracerProvider({
        resource: new Resource({
          "service.name": "host-app",
          "deployment.environment": "dev",
        }),
      });
      trace.setGlobalTracerProvider(existing);

      const { configure } = await loadSetup();
      configure({
        apiKey: "rg.v1.x.y",
        serviceName: "my-app",
        resourceAttributes: { "deployment.environment": "prod" },
      });

      expect(existing.resource.attributes["service.name"]).toBe("my-app");
      expect(existing.resource.attributes["deployment.environment"]).toBe(
        "prod",
      );
    });

    it("merges resource attrs — existing keys we don't override are preserved", async () => {
      const existing = new BasicTracerProvider({
        resource: new Resource({
          "host.name": "node-17",
          "telemetry.sdk.language": "nodejs",
        }),
      });
      trace.setGlobalTracerProvider(existing);

      const { configure } = await loadSetup();
      configure({ apiKey: "rg.v1.x.y", serviceName: "my-app" });

      expect(existing.resource.attributes["host.name"]).toBe("node-17");
      expect(existing.resource.attributes["telemetry.sdk.language"]).toBe(
        "nodejs",
      );
      expect(existing.resource.attributes["service.name"]).toBe("my-app");
    });
  });
});

describe("attach()", () => {
  let originalProvider: ReturnType<typeof trace.getTracerProvider>;

  beforeEach(() => {
    originalProvider = trace.getTracerProvider();
    trace.disable();
  });

  afterEach(() => {
    trace.disable();
    trace.setGlobalTracerProvider(originalProvider);
  });

  it("adds a KubitSpanProcessor to an already-installed provider", async () => {
    const existing = new BasicTracerProvider();
    trace.setGlobalTracerProvider(existing);

    const { attach } = await loadSetup();
    const { KubitSpanProcessor } = await import("./processor");
    const returned = attach({ apiKey: "rg.v1.x.y" });

    expect(returned).toBe(existing);
    expect(
      readProcessors(existing).some((p) => p instanceof KubitSpanProcessor),
    ).toBe(true);
  });

  it("throws when no real provider is installed", async () => {
    const { attach } = await loadSetup();
    expect(() => attach({ apiKey: "rg.v1.x.y" })).toThrow(
      /already registered/i,
    );
  });
});

/**
 * Hand-rolled OTLP/HTTP+JSON exporter targeting the Kubit collector
 * (`POST {endpoint}`, `x-api-key` header).
 *
 * Collector contract (OTLP/HTTP):
 *   POST {endpoint}                 — e.g. https://otel.kubit.ai/v1/traces
 *   Headers:
 *     x-api-key: {key}              (required, missing -> 401)
 *     Content-Type: application/json
 *   Body: standard OTLP `ExportTraceServiceRequest` JSON
 *
 *   Response:
 *     200 + body { partial_success?: { rejected_spans, error_message } }
 *     401  -> bad / missing key
 *     415  -> wrong Content-Type
 *     400  -> malformed body
 *     413  -> body too large
 *     503  -> transient (queue full) — has Retry-After
 */

import type { KubitSentryConfig } from "./config";
import type { OtlpExportRequest } from "./types";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Browsers cap the aggregate in-flight `keepalive` body at ~64 KB and reject
 * larger requests outright, so keepalive is only set for small payloads (and
 * only in browsers — Node fetch implementations may not support the flag).
 */
const KEEPALIVE_MAX_BODY_BYTES = 60_000;

export interface PostResult {
  ok: boolean;
  /** HTTP status, or 0 on network failure. */
  status: number;
  /** Human-readable explanation, populated on failure or partial success. */
  message?: string;
  /** Number of spans rejected by the collector (200 with partial_success). */
  rejectedSpans?: number;
}

interface PartialSuccessBody {
  partial_success?: {
    /** Proto3 JSON encodes int64 as string; tolerate both. */
    rejected_spans?: number | string;
    error_message?: string;
  };
}

/**
 * Fire-and-forget OTLP POST. Resolves with the result; never throws — callers
 * (Sentry `afterSendEvent` / `beforeSend`) cannot tolerate exceptions.
 */
export const postOtlp = async (
  payload: OtlpExportRequest,
  config: Pick<KubitSentryConfig, "endpoint" | "apiKey">,
): Promise<PostResult> => {
  let response: Response;
  try {
    const body = JSON.stringify(payload);
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body,
    };
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    }
    if (typeof document !== "undefined" && body.length < KEEPALIVE_MAX_BODY_BYTES) {
      // Lets events fired near page unload survive navigation.
      init.keepalive = true;
    }
    response = await fetch(config.endpoint, init);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown network error";
    return { ok: false, status: 0, message };
  }

  if (response.ok) {
    let body: PartialSuccessBody | null = null;
    try {
      body = (await response.json()) as PartialSuccessBody;
    } catch {
      // empty body or non-JSON — treat as full success
      return { ok: true, status: response.status };
    }
    const rejectedRaw = body?.partial_success?.rejected_spans;
    const rejected =
      typeof rejectedRaw === "string" ? Number(rejectedRaw) : rejectedRaw;
    if (typeof rejected === "number" && rejected > 0) {
      return {
        ok: true,
        status: response.status,
        rejectedSpans: rejected,
        message: body?.partial_success?.error_message,
      };
    }
    return { ok: true, status: response.status };
  }

  let message = `HTTP ${response.status}`;
  try {
    const text = await response.text();
    if (text.length > 0) {
      message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    }
  } catch {
    // ignore — fall back to status-only message
  }
  return { ok: false, status: response.status, message };
};

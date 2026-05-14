/**
 * Helpers for writing a `mask` function for {@link KubitSpanProcessor}.
 *
 * A mask function lets the user redact, rewrite, or drop sensitive content
 * from a span *before* it is queued for export. It is configured per
 * processor:
 *
 * ```ts
 * import { configure } from "@kubit-ai/otel";
 * import { setAttr, deleteAttr, maskEvents } from "@kubit-ai/otel/mask";
 *
 * function mask(span) {
 *   setAttr(span, "gen_ai.prompt", "[REDACTED]");
 *   deleteAttr(span, "http.request.body");
 *   maskEvents(span, (e) => e.name === "gen_ai.user.message" ? null : e);
 *   return span;
 * }
 *
 * configure({ apiKey: "rg.v1.xxx", mask });
 * ```
 *
 * The helpers are the only supported way to mutate a `ReadableSpan` from
 * within a mask function — they encapsulate the OTel-private attribute access
 * so user code stays portable across OTel SDK versions.
 *
 * Pipeline ordering inside `KubitSpanProcessor.onEnd`:
 *
 *     shouldExportSpan → mask → re-stamp kubit.sdk.{name,version} → BatchSpanProcessor
 *
 * The mask function:
 * - must be **synchronous** (OTel's `onEnd` is sync; promises are not awaited)
 * - must not perform I/O or network calls (it runs on the producer thread)
 * - must return a `ReadableSpan` (typically the same one it received, mutated
 *   in place via these helpers)
 * - if it throws, the SDK **drops the span and error-logs**; un-masked data is
 *   never shipped (fail-closed)
 *
 * To drop a span outright, use `shouldExportSpan` instead — mask is a
 * transform, not a filter.
 *
 * **Bare `KubitExporter` consumers do not inherit masking.** Masking lives in
 * `KubitSpanProcessor` so dropped spans never enter the batch queue. Users who
 * wrap `KubitExporter` in their own `SpanProcessor` must apply the mask in
 * that processor.
 */

import type { AttributeValue } from "@opentelemetry/api";
import type {
  ReadableSpan,
  TimedEvent,
} from "@opentelemetry/sdk-trace-base";

/** Type of the `mask` callable passed to {@link KubitSpanProcessor}. */
export type MaskSpan = (span: ReadableSpan) => ReadableSpan;

/** Per-event callback used with {@link maskEvents}. */
export type MaskEventFn = (event: TimedEvent) => TimedEvent | null | undefined;

type AttrTarget = ReadableSpan | TimedEvent;

interface MutableAttrsBag {
  attributes?: Record<string, AttributeValue | undefined>;
}

function ensureMutableAttrs(target: AttrTarget): Record<string, AttributeValue | undefined> {
  const bag = target as MutableAttrsBag;
  if (!bag.attributes) {
    bag.attributes = {};
  }
  return bag.attributes;
}

/**
 * Overwrite or add an attribute on a span or an event.
 *
 * `target` may be a `ReadableSpan` or a `TimedEvent` — the same helper covers
 * both surfaces. `value` should be an OTel-compatible type (string, number,
 * boolean, or a homogeneous array of one of those).
 *
 * No-op-ness is not enforced: passing `undefined` writes `undefined`. If you
 * mean "remove this attribute" use {@link deleteAttr}.
 */
export function setAttr(
  target: AttrTarget,
  key: string,
  value: AttributeValue,
): void {
  const attrs = ensureMutableAttrs(target);
  attrs[key] = value;
}

/**
 * Remove an attribute from a span or an event. No-op if the key is absent.
 */
export function deleteAttr(target: AttrTarget, key: string): void {
  const bag = target as MutableAttrsBag;
  if (!bag.attributes) return;
  delete bag.attributes[key];
}

/**
 * Apply `fn` to every event on `span`.
 *
 * `fn` receives a `TimedEvent` and must return either:
 * - the same event (optionally mutated via {@link setAttr} / {@link deleteAttr})
 * - a new `TimedEvent` to substitute
 * - `null` or `undefined` to drop the event entirely
 *
 * The span's underlying events array is rewritten in place with the result.
 * Order is preserved for kept events. If `fn` throws, the exception
 * propagates — the outer mask path's fail-closed handler will then drop the
 * whole span, so half-masked events never ship.
 */
export function maskEvents(span: ReadableSpan, fn: MaskEventFn): void {
  const raw = (span as { events?: TimedEvent[] }).events;
  if (!raw || raw.length === 0) return;
  const kept: TimedEvent[] = [];
  for (const event of raw.slice()) {
    const replacement = fn(event);
    if (replacement == null) continue;
    kept.push(replacement);
  }
  (span as { events: TimedEvent[] }).events = kept;
}

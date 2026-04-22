/**
 * Shared helpers used by the transformer core and framework adapters.
 */

export function firstAttr(
  attrs: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const val = attrs[key];
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
}

export function safeInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export function safeFloat(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Parse `raw` as JSON and merge its top-level keys into `target`. Existing
 * keys on `target` win. Silently no-ops when the blob is missing, malformed,
 * or not an object.
 */
export function mergeJsonBlob(
  raw: unknown,
  target: Record<string, unknown>,
): void {
  if (typeof raw !== "string" || raw.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (key in target) continue;
    target[key] = value;
  }
}

export function cleanDiscriminator(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

export function hrTimeToIso(hr: [number, number] | undefined): string {
  if (!hr) return nowIsoString();
  const ms = hr[0] * 1000 + Math.floor(hr[1] / 1_000_000);
  return new Date(ms).toISOString();
}

export function hrDurationMs(
  start: [number, number] | undefined,
  end: [number, number] | undefined,
): number | null {
  if (!start || !end) return null;
  const startMs = start[0] * 1000 + start[1] / 1_000_000;
  const endMs = end[0] * 1000 + end[1] / 1_000_000;
  return Math.round(endMs - startMs);
}

export function nowIsoString(): string {
  return new Date().toISOString();
}

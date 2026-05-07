/**
 * Internal SDK logger.
 *
 * Verbosity is controlled by the ``KUBIT_OTEL_LOG_LEVEL`` environment
 * variable (``debug`` | ``info`` | ``warn`` | ``error``), evaluated at
 * import time. Default level is ``info``.
 *
 * This logger is for SDK internals only — exporter lifecycle and span
 * filtering. It never logs span content or anything from user application
 * code.
 */

type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): Level {
  const raw =
    (typeof process !== "undefined" &&
      process.env &&
      process.env.KUBIT_OTEL_LOG_LEVEL) ||
    "info";
  const lower = raw.toLowerCase();
  if (lower === "warning") return "warn"; // aliases
  if (lower in RANK) return lower as Level;
  return "info";
}

const currentLevel: Level = resolveLevel();

function emit(level: Level, msg: string, ...args: unknown[]): void {
  if (RANK[level] < RANK[currentLevel]) return;
  const tag = `[kubit-otel ${level}]`;
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;
  fn(tag, msg, ...args);
}

export const logger = {
  debug: (m: string, ...a: unknown[]): void => emit("debug", m, ...a),
  info:  (m: string, ...a: unknown[]): void => emit("info",  m, ...a),
  warn:  (m: string, ...a: unknown[]): void => emit("warn",  m, ...a),
  error: (m: string, ...a: unknown[]): void => emit("error", m, ...a),
};

/** Strip path/query from a URL so it's safe to log. */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<redacted>";
  }
}

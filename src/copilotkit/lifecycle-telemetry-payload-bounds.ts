import { createHash } from "node:crypto";

import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

/**
 * Payload-size bounds for lifecycle telemetry (RT-F2/F4, round-3 fix: a
 * per-field cap alone does NOT bound the request — several large fields plus
 * `extra` can still blow past a reasonable request size). Two limits apply:
 *
 *  - `maxFieldBytes`: each individual field over the cap is replaced by a
 *    truncated preview + SHA-256 hash of its full value.
 *  - `maxPayloadBytes`: the REAL bound, measured on the UTF-8 byte length of
 *    the final serialized envelope. If per-field capping alone isn't enough,
 *    the largest remaining truncatable fields are progressively collapsed
 *    until the envelope fits.
 *
 * Neither cap ever touches `CORRELATION_FIELDS` — an envelope that is still
 * over `maxPayloadBytes` once every truncatable field is collapsed is
 * irreducible and must be dropped by the caller, never sent over-cap.
 *
 * Shared by `lifecycle-telemetry.ts` (bounds the FINAL prepared envelope
 * before a telemetry send) and `lifecycle-redaction.ts` (bounds a raw
 * activity/signal field BEFORE it reaches a base event factory, which also
 * covers the enforcing gate path that never touches the telemetry queue).
 */

export const DEFAULT_MAX_FIELD_BYTES = 8_192;
export const DEFAULT_MAX_PAYLOAD_BYTES = 262_144;

/** Bytes kept in a truncated-field preview marker — deliberately small; it exists for human debugging only. */
const PREVIEW_BYTES = 256;

/**
 * Hook spans: Core accepts `spans` only as an array of span dicts, so an
 * oversized one is bounded by trimming the long strings inside its spans
 * (request/response bodies), never by collapsing the array to a marker.
 */
const SPANS_FIELD = "spans";

/** Smallest per-string budget `fitSpans` trims down to. */
const MIN_SPAN_STRING_BYTES = 256;

/** Wire fields Core needs to route/correlate an event — NEVER truncated, collapsed, or dropped. */
export const CORRELATION_FIELDS: ReadonlySet<string> = new Set([
  "workflow_id",
  "run_id",
  "activity_id",
  "status"
]);

/** Marker replacing an oversized field: a bounded preview + hash of the full value, never the raw value itself. */
export interface TruncatedFieldMarker {
  __openbox_truncated: true;
  original_bytes: number;
  preview: string;
  sha256: string;
}

export function isTruncatedFieldMarker(value: unknown): value is TruncatedFieldMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["__openbox_truncated"] === true
  );
}

/** UTF-8 byte length of `value`'s JSON serialization. */
export function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character. */
function truncateToUtf8ByteLimit(text: string, maxBytes: number): string {
  let end = Math.min(text.length, maxBytes);
  let candidate = text.slice(0, end);
  while (end > 0 && Buffer.byteLength(candidate, "utf8") > maxBytes) {
    end -= 1;
    candidate = text.slice(0, end);
  }
  return candidate;
}

/** Collapse `value` to a bounded preview + SHA-256 hash of its full serialized form. */
export function buildTruncatedFieldMarker(value: JsonValue): TruncatedFieldMarker {
  const serialized = JSON.stringify(value) ?? "null";
  return {
    __openbox_truncated: true,
    original_bytes: Buffer.byteLength(serialized, "utf8"),
    preview: truncateToUtf8ByteLimit(serialized, PREVIEW_BYTES),
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex")
  };
}

/** Trim every string in `value` longer than `maxBytes`, noting the original size. */
function trimStrings(value: JsonValue, maxBytes: number): JsonValue {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    return bytes > maxBytes
      ? `${truncateToUtf8ByteLimit(value, maxBytes)}…[truncated, ${bytes} bytes]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => trimStrings(item, maxBytes));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = trimStrings(item, maxBytes);
    }
    return out;
  }
  return value;
}

/**
 * Bound a hook `spans` array to `maxBytes` by halving the per-string budget
 * until it fits (or the budget reaches its floor). Always returns an array.
 */
export function fitSpans(spans: JsonValue[], maxBytes: number): FieldTruncationResult {
  if (jsonByteLength(spans) <= maxBytes) {
    return { truncated: false, value: spans };
  }
  let budget = maxBytes;
  let fitted: JsonValue = spans;
  while (budget > MIN_SPAN_STRING_BYTES && jsonByteLength(fitted) > maxBytes) {
    budget = Math.max(MIN_SPAN_STRING_BYTES, Math.floor(budget / 2));
    fitted = trimStrings(spans, budget);
  }
  return { truncated: true, value: fitted };
}

export interface FieldTruncationResult {
  truncated: boolean;
  value: JsonValue;
}

/** Replace `value` with a truncated preview+hash marker when it exceeds `maxFieldBytes`. Idempotent on an already-collapsed marker. */
export function truncateFieldIfOversized(
  value: JsonValue,
  maxFieldBytes: number
): FieldTruncationResult {
  if (isTruncatedFieldMarker(value) || jsonByteLength(value) <= maxFieldBytes) {
    return { truncated: false, value };
  }
  // `TruncatedFieldMarker` is a fixed-shape interface (needed for
  // `isTruncatedFieldMarker`'s type guard) rather than an index-signature
  // type, so it isn't structurally a `JsonValue` to the compiler even though
  // every field (`true`/`number`/`string`) is JSON-safe.
  return { truncated: true, value: buildTruncatedFieldMarker(value) as unknown as JsonValue };
}

export interface PayloadBoundOptions {
  maxFieldBytes: number;
  maxPayloadBytes: number;
}

export interface PayloadBoundResult {
  /** `null` when the envelope is irreducibly over `maxPayloadBytes` — the caller must drop the event, never send it over-cap. */
  payload: Record<string, JsonValue> | null;
  fieldsTruncated: string[];
}

/**
 * Bound a PREPARED lifecycle payload (post `prepareLifecyclePayload`) to
 * `maxPayloadBytes` total. Pass 1 caps each non-correlation field
 * individually (`maxFieldBytes`); pass 2 progressively collapses the largest
 * remaining truncatable field until the whole envelope fits, measured on the
 * UTF-8 byte length of the final serialized envelope.
 */
export function boundPreparedPayload(
  payload: Readonly<Record<string, JsonValue>>,
  opts: PayloadBoundOptions
): PayloadBoundResult {
  const working: Record<string, JsonValue> = { ...payload };
  const fieldsTruncated: string[] = [];
  const truncatableKeys = Object.keys(working).filter(key => !CORRELATION_FIELDS.has(key));

  for (const key of truncatableKeys) {
    const field = working[key]!;
    const { value, truncated } =
      key === SPANS_FIELD && Array.isArray(field)
        ? fitSpans(field, opts.maxFieldBytes)
        : truncateFieldIfOversized(field, opts.maxFieldBytes);
    if (truncated) {
      working[key] = value;
      fieldsTruncated.push(key);
    }
  }

  while (jsonByteLength(working) > opts.maxPayloadBytes) {
    const largestKey = largestTruncatableField(working, truncatableKeys);
    if (largestKey === undefined) {
      // Every truncatable field is already collapsed to its minimal preview —
      // the correlation-field-only remainder still exceeds the cap. Irreducible.
      return { payload: null, fieldsTruncated };
    }
    working[largestKey] = buildTruncatedFieldMarker(working[largestKey]!) as unknown as JsonValue;
    if (!fieldsTruncated.includes(largestKey)) {
      fieldsTruncated.push(largestKey);
    }
  }

  return { payload: working, fieldsTruncated };
}

/** The largest-by-serialized-size truncatable field not already collapsed, or `undefined` if none remain. */
function largestTruncatableField(
  payload: Readonly<Record<string, JsonValue>>,
  truncatableKeys: readonly string[]
): string | undefined {
  let largestKey: string | undefined;
  let largestSize = -1;
  for (const key of truncatableKeys) {
    const value = payload[key];
    // Spans are already trimmed; a marker in their place is a Core 400.
    if (value === undefined || isTruncatedFieldMarker(value) || key === SPANS_FIELD) {
      continue;
    }
    const size = jsonByteLength(value);
    if (size > largestSize) {
      largestSize = size;
      largestKey = key;
    }
  }
  return largestKey;
}

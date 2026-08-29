/**
 * The byte response writer for response pass-through.
 *
 * Turns a captured subgraph response body into the client's HTTP response
 * without ever decoding the payload into a JavaScript string. The framing
 * (`{"data":{`, keys, commas, `}}`) is tiny and encoded fresh; every payload
 * value is a zero-copy `subarray` view into the original body. Avoiding the
 * decode/re-encode round trip is the whole point of the plugin — it is what
 * removes the GC pressure the parse-based path creates on megabyte responses.
 *
 * Only `data` is relayed, re-keyed to the client's response keys. The
 * subgraph's own `extensions` are never emitted: the gateway strips them
 * today, so relaying them would create an information leak that does not
 * currently exist. Gateway-side extensions, when supplied, are appended as a
 * freshly serialized member.
 *
 * The writer trusts nothing it is not handed: a root key the scan does not
 * account for throws, and the caller falls back to the normal execution path.
 */

import type { ScannedResponse } from './scanJsonResponse';

const encoder = new TextEncoder();

export interface WriteOptions {
  /** the raw subgraph response body */
  body: Uint8Array;
  /** result of scanJsonResponse(body) */
  scan: ScannedResponse;
  /** subgraph top-level data key -> client response key */
  rootKeyMap: Map<string, string>;
  /** gateway-side extensions to append, already sanitized; omit if absent */
  extensions?: unknown;
}

/**
 * Builds the byte chunks forming `{"data":{...}}` plus optional extensions.
 *
 * Payload values are `subarray` views of `body`; only the framing between
 * them is newly allocated. Client key order follows `rootKeyMap` insertion
 * order, which the eligibility check derived from the client document.
 *
 * Throws when the scan cannot supply a mapped root field — the caller must
 * treat that as "take the normal path".
 */
export function buildResponseChunks(options: WriteOptions): Uint8Array[] {
  const { body, scan, rootKeyMap, extensions } = options;
  const { dataFields } = scan;
  if (!dataFields) {
    // `data` was null or not an object; there is nothing to re-key.
    throw new Error('response pass-through: data is not an object');
  }

  const chunks: Uint8Array[] = [];
  // Framing accumulates here and is flushed as one encoded chunk each time a
  // payload view interrupts it, so adjacent framing never fragments.
  let framing = '{"data":{';
  let first = true;

  for (const [subgraphKey, clientKey] of rootKeyMap) {
    const range = dataFields.get(subgraphKey);
    if (!range) {
      throw new Error(
        `response pass-through: root field ${JSON.stringify(subgraphKey)} not found in response`,
      );
    }
    framing += (first ? '' : ',') + JSON.stringify(clientKey) + ':';
    first = false;
    chunks.push(encoder.encode(framing));
    framing = '';
    chunks.push(body.subarray(range.start, range.end));
  }

  framing += '}';
  if (extensions !== undefined) {
    const serialized = JSON.stringify(extensions);
    // JSON.stringify returns undefined for unserializable values; emitting
    // that would corrupt the response, so refuse instead.
    if (serialized === undefined) {
      throw new Error('response pass-through: extensions are not serializable');
    }
    framing += ',"extensions":' + serialized;
  }
  framing += '}';
  chunks.push(encoder.encode(framing));

  return chunks;
}

/**
 * A ReadableStream over chunks that already exist. Split from the chunk
 * building on purpose: building can throw (a missing root field, extensions
 * that refuse to serialize) and must therefore happen while the caller can
 * still decline; streaming prebuilt chunks cannot fail.
 */
export function streamChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  });
}

/** Convenience: build and stream in one call, for callers that may still fail. */
export function createResponseStream(
  options: WriteOptions,
): ReadableStream<Uint8Array> {
  return streamChunks(buildResponseChunks(options));
}

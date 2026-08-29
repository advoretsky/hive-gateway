import { describe, expect, it } from 'vitest';
import { scanJsonResponse } from '../src/plugins/response-passthrough/scanJsonResponse';
import {
  buildResponseChunks,
  createResponseStream,
  type WriteOptions,
} from '../src/plugins/response-passthrough/writeResponse';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function scanned(body: Uint8Array) {
  const scan = scanJsonResponse(body);
  if (!scan) {
    throw new Error('test fixture failed to scan');
  }
  return scan;
}

function options(
  json: string,
  rootKeyMap: Record<string, string>,
  extensions?: unknown,
): WriteOptions {
  const body = encoder.encode(json);
  return {
    body,
    scan: scanned(body),
    rootKeyMap: new Map(Object.entries(rootKeyMap)),
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

function concat(chunks: Uint8Array[]): string {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(out);
}

function build(opts: WriteOptions): unknown {
  return JSON.parse(concat(buildResponseChunks(opts)));
}

describe('buildResponseChunks', () => {
  it('relays a single root field', () => {
    const opts = options(
      '{"data":{"products":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}}',
      { products: 'products' },
    );
    expect(build(opts)).toEqual({
      data: {
        products: [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
      },
    });
  });

  it('emits payload slices as zero-copy views of the body', () => {
    const opts = options('{"data":{"products":[1,2,3]}}', {
      products: 'products',
    });
    const chunks = buildResponseChunks(opts);
    const payload = chunks.filter((c) => c.buffer === opts.body.buffer);
    expect(payload).toHaveLength(1);
    expect(decoder.decode(payload[0])).toBe('[1,2,3]');
  });

  it('re-keys a dropped client alias', () => {
    // The stitched subgraph document drops the client's root alias, so the
    // subgraph answers under `products` while the client expects `p`.
    const opts = options('{"data":{"products":[{"id":1}]}}', {
      products: 'p',
    });
    expect(build(opts)).toEqual({ data: { p: [{ id: 1 }] } });
  });

  it('re-keys _v0_/_v1_ batch prefixes and preserves client key order', () => {
    // Body order is _v1_ before _v0_; the client's order from rootKeyMap
    // insertion must win.
    const opts = options(
      '{"data":{"_v1_users":[{"id":9}],"_v0_products":[{"id":1}]}}',
      { _v0_products: 'products', _v1_users: 'users' },
    );
    const text = concat(buildResponseChunks(opts));
    expect(JSON.parse(text)).toEqual({
      data: { products: [{ id: 1 }], users: [{ id: 9 }] },
    });
    expect(text.indexOf('"products"')).toBeLessThan(text.indexOf('"users"'));
  });

  it('keeps every payload slice a view when there are multiple root fields', () => {
    const opts = options('{"data":{"a":{"x":1},"b":[true,false]}}', {
      a: 'a',
      b: 'b',
    });
    const chunks = buildResponseChunks(opts);
    const payload = chunks.filter((c) => c.buffer === opts.body.buffer);
    expect(payload).toHaveLength(2);
    expect(decoder.decode(payload[0])).toBe('{"x":1}');
    expect(decoder.decode(payload[1])).toBe('[true,false]');
  });

  it('handles an empty data object', () => {
    const opts = options('{"data":{}}', {});
    expect(build(opts)).toEqual({ data: {} });
  });

  it('JSON-escapes client response keys', () => {
    const opts = options('{"data":{"products":1}}', {
      products: 'we"ird\\key',
    });
    expect(build(opts)).toEqual({ data: { 'we"ird\\key': 1 } });
  });

  it('never emits the subgraph extensions present in the body', () => {
    const opts = options(
      '{"data":{"products":[1]},"extensions":{"secretTrace":"leak"}}',
      { products: 'products' },
    );
    const text = concat(buildResponseChunks(opts));
    expect(text).not.toContain('secretTrace');
    expect(JSON.parse(text)).toEqual({ data: { products: [1] } });
  });

  it('emits gateway extensions when supplied, replacing subgraph ones', () => {
    const opts = options(
      '{"data":{"products":[1]},"extensions":{"secretTrace":"leak"}}',
      { products: 'products' },
      { cost: { requested: 5 } },
    );
    expect(build(opts)).toEqual({
      data: { products: [1] },
      extensions: { cost: { requested: 5 } },
    });
  });

  it('throws when a mapped root field is missing from the scan', () => {
    const opts = options('{"data":{"products":[1]}}', { users: 'users' });
    expect(() => buildResponseChunks(opts)).toThrow(/users/);
  });

  it('throws when data is not an object', () => {
    const opts = options('{"data":null}', {});
    expect(() => buildResponseChunks(opts)).toThrow(/not an object/);
  });

  it('throws on unserializable gateway extensions', () => {
    const opts = options('{"data":{}}', {}, () => {});
    expect(() => buildResponseChunks(opts)).toThrow(/not serializable/);
  });
});

describe('createResponseStream', () => {
  it('streams the same bytes as buildResponseChunks', async () => {
    const opts = options(
      '{"data":{"products":[{"id":1}],"users":[{"id":9}]}}',
      { products: 'p', users: 'u' },
      { traceId: 't-1' },
    );
    const stream = createResponseStream(opts);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    expect(concat(chunks)).toBe(concat(buildResponseChunks(opts)));
    expect(JSON.parse(concat(chunks))).toEqual({
      data: { p: [{ id: 1 }], u: [{ id: 9 }] },
      extensions: { traceId: 't-1' },
    });
  });
});

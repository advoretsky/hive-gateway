import { describe, expect, it } from 'vitest';
import {
  scanJsonResponse,
  sliceRange,
  type ScanOptions,
} from '../src/plugins/response-passthrough/scanJsonResponse';

const enc = new TextEncoder();
const scan = (json: string, options?: ScanOptions) =>
  scanJsonResponse(enc.encode(json), options);

/** Scans, then checks every reported range parses back to the real value. */
function scanAndVerify(json: string, options?: ScanOptions) {
  const buf = enc.encode(json);
  const result = scanJsonResponse(buf, options);
  if (!result) {
    return null;
  }
  const original = JSON.parse(json);
  for (const [key, range] of result.keys) {
    expect(JSON.parse(sliceRange(buf, range))).toEqual(original[key]);
  }
  if (result.dataFields) {
    for (const [key, range] of result.dataFields) {
      expect(JSON.parse(sliceRange(buf, range))).toEqual(original.data[key]);
    }
  }
  return result;
}

describe('scanJsonResponse', () => {
  describe('top-level keys', () => {
    it('finds data and reports no errors', () => {
      const r = scanAndVerify(`{"data":{"a":1}}`)!;
      expect([...r.keys.keys()]).toEqual(['data']);
      expect(r.keys.has('errors')).toBe(false);
    });

    it('detects errors listed after data', () => {
      const r = scanAndVerify(`{"data":{"a":1},"errors":[{"message":"x"}]}`)!;
      expect(r.keys.has('errors')).toBe(true);
    });

    it('detects errors listed before data', () => {
      const r = scanAndVerify(`{"errors":[{"message":"x"}],"data":{"a":1}}`)!;
      expect(r.keys.has('errors')).toBe(true);
    });

    it('handles extensions alongside data', () => {
      const r = scanAndVerify(
        `{"data":{"a":1},"extensions":{"trace":{"id":"t"}}}`,
      )!;
      expect([...r.keys.keys()]).toEqual(['data', 'extensions']);
    });

    it('handles a response with no data key', () => {
      const r = scanAndVerify(`{"errors":[{"message":"boom"}]}`)!;
      expect(r.keys.has('data')).toBe(false);
      expect(r.dataFields).toBeUndefined();
    });

    it('handles null data', () => {
      const r = scanAndVerify(`{"data":null}`)!;
      expect(sliceRange(enc.encode(`{"data":null}`), r.keys.get('data')!)).toBe(
        'null',
      );
      expect(r.dataFields).toBeUndefined();
    });

    it('handles an empty object', () => {
      const r = scan(`{}`)!;
      expect(r).not.toBeNull();
      expect(r.keys.size).toBe(0);
    });

    it('handles an empty data object', () => {
      const r = scanAndVerify(`{"data":{}}`)!;
      expect(r.dataFields!.size).toBe(0);
    });
  });

  describe('data members', () => {
    it('reports each root field range', () => {
      const r = scanAndVerify(
        `{"data":{"products":[{"id":"1"}],"node":{"id":"2"}}}`,
      )!;
      expect([...r.dataFields!.keys()]).toEqual(['products', 'node']);
    });

    it('reports ranges for batch-prefixed keys', () => {
      const r = scanAndVerify(
        `{"data":{"_v0_products":[1,2],"_v1_node":{"id":"x"}}}`,
      )!;
      expect([...r.dataFields!.keys()]).toEqual(['_v0_products', '_v1_node']);
    });

    it('does not descend below data', () => {
      // A nested "errors" key must not be mistaken for a top-level one.
      const r = scanAndVerify(`{"data":{"a":{"errors":["nested"]}}}`)!;
      expect(r.keys.has('errors')).toBe(false);
      expect([...r.dataFields!.keys()]).toEqual(['a']);
    });

    it('leaves dataFields undefined when data is a scalar', () => {
      const r = scanAndVerify(`{"data":42}`)!;
      expect(r.dataFields).toBeUndefined();
    });
  });

  describe('strings that look like structure', () => {
    it('ignores braces inside strings', () => {
      const r = scanAndVerify(`{"data":{"a":"}{[]","b":1}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });

    it('ignores a quoted "errors" inside a string value', () => {
      const r = scanAndVerify(`{"data":{"a":"\\"errors\\": [1]"}}`)!;
      expect(r.keys.has('errors')).toBe(false);
    });

    it('handles escaped quotes', () => {
      const r = scanAndVerify(`{"data":{"a":"say \\"hi\\"","b":2}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });

    it('handles a trailing escaped backslash before the closing quote', () => {
      const r = scanAndVerify(`{"data":{"a":"back\\\\","b":2}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });

    it('handles unicode escapes including an escaped quote', () => {
      const r = scanAndVerify(`{"data":{"a":"\\u0022}{","b":3}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });

    it('handles escaped keys', () => {
      const r = scanAndVerify(`{"data":{"we\\"ird":1}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['we"ird']);
    });

    it('handles multi-byte characters', () => {
      const r = scanAndVerify(`{"data":{"a":"héllo → 世界","b":1}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });
  });

  describe('shapes and nesting', () => {
    it('handles deeply nested arrays and objects', () => {
      const r = scanAndVerify(
        `{"data":{"a":[[{"b":[1,{"c":[[]]}]}]],"d":null}}`,
      )!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'd']);
    });

    it('handles all literal types', () => {
      const r = scanAndVerify(
        `{"data":{"t":true,"f":false,"n":null,"i":-12,"e":1.5e10}}`,
      )!;
      expect([...r.dataFields!.keys()]).toEqual(['t', 'f', 'n', 'i', 'e']);
    });

    it('tolerates whitespace and newlines throughout', () => {
      const r = scanAndVerify(
        `{\n  "data" : {\n    "a" : [ 1 , 2 ] ,\n    "b" : { "c" : true }\n  }\n}\n`,
      )!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });

    it('tolerates leading whitespace', () => {
      expect(scanAndVerify(`   {"data":{"a":1}}`)).not.toBeNull();
    });
  });

  describe('refusals', () => {
    const refuses = (label: string, json: string) =>
      it(`refuses ${label}`, () => expect(scan(json)).toBeNull());

    refuses('an empty body', ``);
    refuses('whitespace only', `   `);
    refuses('a truncated object', `{"data":{"a":1}`);
    refuses('a truncated string', `{"data":{"a":"unterminated}`);
    refuses('a truncated array', `{"data":{"a":[1,2}}`);
    refuses('a top-level array', `[{"data":{}}]`);
    refuses('a top-level string', `"hello"`);
    refuses('a top-level number', `42`);
    refuses('a missing colon', `{"data" {"a":1}}`);
    refuses('an unquoted key', `{data:{"a":1}}`);
    refuses('a trailing comma', `{"data":{"a":1},}`);
    refuses('trailing content after the root object', `{"data":{}} junk`);
    refuses('a second root object', `{"data":{}}{"data":{}}`);
    refuses('duplicate top-level keys', `{"data":{},"data":{}}`);
    refuses('duplicate keys inside data', `{"data":{"a":1,"a":2}}`);
    refuses('a missing value', `{"data":}`);

    it('refuses rather than throwing on random truncations of a valid body', () => {
      const full = `{"data":{"products":[{"id":"1","tags":["a","b"],"n":null}],"x":true},"extensions":{"k":"v"}}`;
      for (let cut = 1; cut < full.length; cut++) {
        const partial = full.slice(0, cut);
        // Must never throw; a prefix is either refused or, if it happens to be
        // a complete valid document, scanned correctly.
        expect(() => scan(partial)).not.toThrow();
      }
    });
  });

  describe('bodies JSON.parse would reject (validate: true)', () => {
    const refuses = (label: string, json: string) =>
      it(`refuses ${label}`, () => {
        // Guard: the case must really be invalid JSON, or it proves nothing.
        expect(() => JSON.parse(json)).toThrow();
        expect(scan(json, { validate: true })).toBeNull();
      });
    const ctl = (code: number) => String.fromCharCode(code);

    // Unescaped control characters inside strings.
    refuses(
      'a raw NUL inside a string',
      `{"data":{"a":"x` + ctl(0x00) + `y"}}`,
    );
    refuses(
      'a raw newline inside a string',
      `{"data":{"a":"x` + ctl(0x0a) + `y"}}`,
    );
    refuses(
      'a raw tab inside a string',
      `{"data":{"a":"x` + ctl(0x09) + `y"}}`,
    );
    refuses(
      'a raw 0x1F inside a string',
      `{"data":{"a":"x` + ctl(0x1f) + `y"}}`,
    );
    refuses(
      'a raw control character in a key',
      `{"data":{"a` + ctl(0x01) + `b":1}}`,
    );

    // Malformed numbers.
    refuses('a leading zero', `{"data":{"a":01}}`);
    refuses('a leading plus', `{"data":{"a":+1}}`);
    refuses('a bare leading dot', `{"data":{"a":.5}}`);
    refuses('a trailing dot', `{"data":{"a":5.}}`);
    refuses('two decimal points', `{"data":{"a":1.2.3}}`);
    refuses('a lone minus', `{"data":{"a":-}}`);
    refuses('a minus separated from its digits', `{"data":{"a":- 1}}`);
    refuses('an exponent with no digits', `{"data":{"a":1e}}`);
    refuses('a signed exponent with no digits', `{"data":{"a":1e+}}`);
    refuses('a hex number', `{"data":{"a":0x10}}`);

    // Invalid literals.
    refuses('a capitalized True', `{"data":{"a":True}}`);
    refuses('a truncated true', `{"data":{"a":tru}}`);
    refuses('null with trailing junk', `{"data":{"a":nullx}}`);
    refuses('NaN', `{"data":{"a":NaN}}`);
    refuses('Infinity', `{"data":{"a":Infinity}}`);
    refuses('undefined', `{"data":{"a":undefined}}`);
    refuses('a single-quoted string', `{"data":{"a":'x'}}`);

    // Invalid escapes.
    refuses('an invalid escape character', `{"data":{"a":"\\q"}}`);
    refuses('an \\x escape', `{"data":{"a":"\\x41"}}`);
    refuses('a unicode escape with too few digits', `{"data":{"a":"\\u12"}}`);
    refuses(
      'a unicode escape with a non-hex digit',
      `{"data":{"a":"\\u12G4"}}`,
    );
    refuses('a capital \\U escape', `{"data":{"a":"\\U0041"}}`);
    refuses('an escape at end of input', `{"data":{"a":"x\\`);

    // Malformations below the two levels the scanner extracts keys from,
    // where the old bracket-balanced walk was blind.
    refuses('a missing comma deep inside data', `{"data":{"a":[1 2]}}`);
    refuses('a missing colon deep inside data', `{"data":{"a":{"b" 1}}}`);
    refuses('a trailing comma deep inside data', `{"data":{"a":[1,]}}`);
    refuses('a leading comma deep inside data', `{"data":{"a":[,1]}}`);
    refuses('an unquoted key deep inside data', `{"data":{"a":{b:1}}}`);
    refuses('a colon in an array', `{"data":{"a":[1:2]}}`);
    refuses('mismatched brackets', `{"data":{"a":{"b":1]}}`);
    refuses(
      'two values with no comma in an object',
      `{"data":{"a":{"b":1 "c":2}}}`,
    );
  });

  describe('default mode checks structure only', () => {
    // Without `validate` the scan trusts subgraph content but must still
    // refuse anything structurally broken, or the writer would relay a body
    // whose shape it misunderstood.
    const refuses = (label: string, json: string) =>
      it(`refuses ${label}`, () => expect(scan(json)).toBeNull());
    const accepts = (label: string, json: string) =>
      it(`accepts ${label}`, () => expect(scan(json)).not.toBeNull());

    refuses('a missing comma deep inside data', `{"data":{"a":[1 2]}}`);
    refuses('a missing colon deep inside data', `{"data":{"a":{"b" 1}}}`);
    refuses('mismatched brackets deep inside data', `{"data":{"a":{"b":[1}}}`);
    refuses(
      'an unbalanced container deep inside data',
      `{"data":{"a":[[1,2]}}`,
    );
    refuses('a truncated string deep inside data', `{"data":{"a":["x`);
    refuses('an escape hiding the closing quote', `{"data":{"a":"x\\`);
    refuses('a missing value deep inside data', `{"data":{"a":[1,,2]}}`);
    refuses('a colon in an array', `{"data":{"a":[1:2]}}`);
    refuses('an unquoted key deep inside data', `{"data":{"a":{b:1}}}`);

    // Content-level malformations pass: the user opted out of paying for
    // their detection and relies on the subgraph emitting valid JSON.
    accepts('a malformed number', `{"data":{"a":01}}`);
    accepts('NaN', `{"data":{"a":NaN}}`);
    accepts('an invalid escape character', `{"data":{"a":"\\q"}}`);
    accepts(
      'a raw newline inside a string',
      `{"data":{"a":"x` + String.fromCharCode(0x0a) + `y"}}`,
    );

    it('still tracks boundaries of strings with escaped quotes', () => {
      // The structural walk must not let an escaped quote close the string,
      // or the reported ranges drift.
      const r = scanAndVerify(`{"data":{"a":"say \\"}\\"","b":2}}`)!;
      expect([...r.dataFields!.keys()]).toEqual(['a', 'b']);
    });
  });

  describe('UTF-8 BOM', () => {
    const BOM = '\uFEFF'; // encodes to EF BB BF

    it('accepts a leading BOM before the root object', () => {
      const buf = enc.encode(
        `${BOM}{"data":{"a":1},"errors":[{"message":"x"}]}`,
      );
      const r = scanJsonResponse(buf)!;
      expect(r).not.toBeNull();
      expect(r.keys.has('errors')).toBe(true);
      expect(sliceRange(buf, r.dataFields!.get('a')!)).toBe('1');
    });

    it('accepts a leading BOM in validating mode', () => {
      expect(scan(`${BOM}{"data":{"a":1}}`, { validate: true })).not.toBeNull();
    });

    it('accepts a BOM followed by whitespace', () => {
      expect(scan(`${BOM}  {"data":{}}`)).not.toBeNull();
    });

    // TextDecoder strips only a BOM at the very start of the stream; anywhere
    // else it survives decoding and JSON.parse throws, so the scanner must
    // refuse too.
    it('refuses a BOM after whitespace', () => {
      expect(scan(` ${BOM}{"data":{}}`)).toBeNull();
    });

    it('refuses a doubled BOM', () => {
      expect(scan(`${BOM}${BOM}{"data":{}}`)).toBeNull();
    });

    it('refuses a BOM-only body', () => {
      expect(scan(BOM)).toBeNull();
    });
  });

  describe('invalid UTF-8 (validate: true)', () => {
    // Splice raw bytes into a string value so the encoder cannot sanitize
    // them on the way in.
    const bodyWithBytes = (bytes: number[]) => {
      const prefix = enc.encode(`{"data":{"a":"x`);
      const suffix = enc.encode(`y"}}`);
      const buf = new Uint8Array(prefix.length + bytes.length + suffix.length);
      buf.set(prefix, 0);
      buf.set(bytes, prefix.length);
      buf.set(suffix, prefix.length + bytes.length);
      return buf;
    };
    const refusesBytes = (label: string, bytes: number[]) =>
      it(`refuses ${label}`, () => {
        const buf = bodyWithBytes(bytes);
        // Guard: a strict decoder must agree the bytes are invalid.
        expect(() =>
          new TextDecoder('utf-8', { fatal: true }).decode(buf),
        ).toThrow();
        expect(scanJsonResponse(buf, { validate: true })).toBeNull();
      });

    refusesBytes('a stray continuation byte', [0x80]);
    refusesBytes('an overlong two-byte encoding', [0xc0, 0xaf]);
    refusesBytes('a 0xC1 lead byte', [0xc1, 0x80]);
    refusesBytes('a two-byte lead followed by ASCII', [0xc3, 0x41]);
    refusesBytes('an overlong three-byte encoding', [0xe0, 0x80, 0x80]);
    refusesBytes('a UTF-16 surrogate encoded as UTF-8', [0xed, 0xa0, 0x80]);
    refusesBytes('a truncated three-byte sequence', [0xe4, 0xb8]);
    refusesBytes('an overlong four-byte encoding', [0xf0, 0x80, 0x80, 0x80]);
    refusesBytes('a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]);
    refusesBytes('a 0xF5 lead byte', [0xf5, 0x80, 0x80, 0x80]);
    refusesBytes('a lone 0xFF byte', [0xff]);

    it('accepts well-formed sequences at encoding boundaries', () => {
      // First and last code points of each UTF-8 encoding length.
      const s = String.fromCodePoint(
        0x80,
        0x7ff,
        0x800,
        0xffff,
        0x10000,
        0x10ffff,
      );
      const r = scanAndVerify(JSON.stringify({ data: { a: s } }), {
        validate: true,
      })!;
      expect(r.dataFields!.has('a')).toBe(true);
    });

    it('does not check UTF-8 in the default mode', () => {
      // A lone 0xFF is refused above under validation; without it the bytes
      // are the subgraph's problem and the structure still scans.
      expect(scanJsonResponse(bodyWithBytes([0xff]))).not.toBeNull();
    });
  });

  describe('valid edge forms are still accepted', () => {
    const accepts = (label: string, json: string) =>
      it(`accepts ${label}`, () => {
        // Both modes must accept valid JSON, or validation costs relays.
        expect(scanAndVerify(json)).not.toBeNull();
        expect(scanAndVerify(json, { validate: true })).not.toBeNull();
      });

    accepts(
      'every escape character',
      `{"data":{"a":"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u0041"}}`,
    );
    accepts('a lone-surrogate unicode escape', `{"data":{"a":"\\ud800"}}`);
    accepts(
      'number edge forms',
      `{"data":{"a":0,"b":-0,"c":0.5,"d":1e5,"e":1E+5,"f":1e-5,"g":-12.25e2}}`,
    );
  });

  describe('differential fuzz against JSON.parse', () => {
    // Deterministic PRNG so a failing case reproduces from the seed.
    function mulberry32(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // JSON.parse sees the body the way the ordinary path would: decoded
    // leniently, so invalid bytes become U+FFFD before it ever runs. The
    // invariant is one-directional: whenever JSON.parse throws, the scanner
    // must refuse; the scanner refusing more than JSON.parse is fine.
    const lenient = new TextDecoder();
    const parseAccepts = (bytes: Uint8Array) => {
      try {
        JSON.parse(lenient.decode(bytes));
        return true;
      } catch {
        return false;
      }
    };

    const base = enc.encode(
      JSON.stringify({
        data: {
          products: [
            { id: 'p1', price: 10.5, tags: ['a', 'b'], meta: null },
            {
              id: 'p2',
              price: -0.25e2,
              inStock: true,
              name: 'multi-byte ' + String.fromCodePoint(0xe9, 0x4e16, 0x1f389),
            },
          ],
          count: 2,
        },
        extensions: {
          trace: { id: 'abc', nested: [1, 2, [3, { deep: false }]] },
        },
      }),
    );

    it('returns null whenever JSON.parse throws', () => {
      const rand = mulberry32(0xbadc0de);
      const int = (n: number) => Math.floor(rand() * n);
      // Bytes likely to corrupt: control characters, structure, escape
      // starters, digits, and invalid UTF-8 leads.
      const noise = [
        0x00, 0x0a, 0x1f, 0x22, 0x5c, 0x2c, 0x3a, 0x7b, 0x7d, 0x5b, 0x5d, 0x2b,
        0x2e, 0x30, 0x80, 0xc0, 0xed, 0xf5, 0xff,
      ];
      let malformed = 0;
      for (let iter = 0; iter < 600; iter++) {
        let body: Uint8Array;
        switch (iter % 4) {
          case 0: {
            // Truncation.
            body = base.slice(0, 1 + int(base.length - 1));
            break;
          }
          case 1: {
            // Flip one byte to a noisy value.
            body = base.slice();
            body[int(body.length)] = noise[int(noise.length)]!;
            break;
          }
          case 2: {
            // Inject a noisy byte.
            const at = int(base.length);
            body = new Uint8Array(base.length + 1);
            body.set(base.subarray(0, at), 0);
            body[at] = noise[int(noise.length)]!;
            body.set(base.subarray(at), at + 1);
            break;
          }
          default: {
            // Overwrite two bytes with a backslash escape, mostly broken.
            body = base.slice();
            const at = int(body.length - 1);
            body[at] = 0x5c;
            body[at + 1] = noise[int(noise.length)]!;
            break;
          }
        }
        if (!parseAccepts(body)) {
          malformed++;
          expect(
            scanJsonResponse(body, { validate: true }),
            `iter ${iter}: ${JSON.stringify(lenient.decode(body))}`,
          ).toBeNull();
        }
        // The default mode gives no acceptance guarantee on garbage, but it
        // must never throw on it.
        expect(() => scanJsonResponse(body)).not.toThrow();
      }
      // Sanity floor: the mutations must actually exercise the invariant.
      expect(malformed).toBeGreaterThan(300);
    });
  });

  describe('ranges are exact', () => {
    it('slices values that parse back identically', () => {
      const json = `{"data":{"products":[{"id":"1","name":"a \\"quoted\\" name"},{"id":"2"}],"count":2},"extensions":{"cost":{"estimated":5}}}`;
      const buf = enc.encode(json);
      const r = scanJsonResponse(buf)!;
      expect(
        JSON.parse(sliceRange(buf, r.dataFields!.get('products')!)),
      ).toEqual([{ id: '1', name: 'a "quoted" name' }, { id: '2' }]);
      expect(sliceRange(buf, r.dataFields!.get('count')!)).toBe('2');
      expect(JSON.parse(sliceRange(buf, r.keys.get('extensions')!))).toEqual({
        cost: { estimated: 5 },
      });
    });

    it('round-trips a rebuilt response', () => {
      const json = `{"data":{"_v0_products":[{"id":"1"}],"_v1_node":{"id":"2"}}}`;
      const buf = enc.encode(json);
      const r = scanJsonResponse(buf)!;
      // Re-key the top level, as the pass-through writer does.
      const rebuilt =
        '{"data":{' +
        [...r.dataFields!.entries()]
          .map(
            ([key, range]) =>
              `${JSON.stringify(key.replace(/^_v\d+_/, ''))}:${sliceRange(buf, range)}`,
          )
          .join(',') +
        '}}';
      expect(JSON.parse(rebuilt)).toEqual({
        data: { products: [{ id: '1' }], node: { id: '2' } },
      });
    });
  });

  describe('agreement with JSON.parse', () => {
    it('matches JSON.parse on generated payloads', () => {
      const payloads = [
        { data: { a: 1 } },
        { data: { a: [1, 2, 3], b: { c: 'd' } } },
        { data: null, errors: [{ message: 'e', path: ['a', 0] }] },
        { data: { s: 'quotes " braces {} brackets [] comma ,' } },
        { data: { deep: { deep: { deep: { deep: [[[{ x: null }]]] } } } } },
        { data: { unicode: '日本語 🎉   ' } },
        { extensions: { only: true } },
        {
          data: {
            products: Array.from({ length: 50 }, (_, i) => ({
              id: `p${i}`,
              tags: ['a', 'b'],
              nested: { deep: [{ v: i }] },
            })),
          },
        },
      ];
      for (const payload of payloads) {
        const json = JSON.stringify(payload);
        const buf = enc.encode(json);
        const r = scanJsonResponse(buf);
        expect(r, json).not.toBeNull();
        expect([...r!.keys.keys()].sort()).toEqual(Object.keys(payload).sort());
        for (const [key, range] of r!.keys) {
          expect(JSON.parse(sliceRange(buf, range))).toEqual(
            (payload as Record<string, unknown>)[key],
          );
        }
      }
    });
  });
});

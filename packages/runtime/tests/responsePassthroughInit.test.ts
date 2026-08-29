import { describe, expect, it } from 'vitest';
import { buildResponseInit } from '../src/plugins/response-passthrough/responseInit';

const JSON_TYPE = 'application/json';
const GRAPHQL_TYPE = 'application/graphql-response+json';

describe('buildResponseInit', () => {
  describe('defaults', () => {
    it('returns 200 and a charset-tagged content-type with no extensions', () => {
      const init = buildResponseInit({}, GRAPHQL_TYPE);
      expect(init.status).toBe(200);
      expect(init.headers).toEqual({
        'content-type': 'application/graphql-response+json; charset=utf-8',
      });
      expect(init.extensions).toBeUndefined();
    });

    it('tags the negotiated media type, not a hardcoded one', () => {
      const init = buildResponseInit({}, JSON_TYPE);
      expect(init.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      );
    });
  });

  describe('extensions.http', () => {
    it('overrides the status', () => {
      const init = buildResponseInit(
        { extensions: { http: { status: 203 } } },
        JSON_TYPE,
      );
      expect(init.status).toBe(203);
    });

    it('merges headers into the response init', () => {
      const init = buildResponseInit(
        {
          extensions: {
            http: {
              headers: {
                'cache-control': 'no-store',
                'set-cookie': 'sid=abc; HttpOnly',
              },
            },
          },
        },
        JSON_TYPE,
      );
      expect(init.headers['cache-control']).toBe('no-store');
      expect(init.headers['set-cookie']).toBe('sid=abc; HttpOnly');
    });

    it('lets an explicit content-type header win, matching Yoga precedence', () => {
      const init = buildResponseInit(
        { extensions: { http: { headers: { 'content-type': 'text/plain' } } } },
        JSON_TYPE,
      );
      expect(init.headers['content-type']).toBe('text/plain');
    });

    it('stringifies number and boolean header values, drops the rest', () => {
      const init = buildResponseInit(
        {
          extensions: {
            http: {
              headers: {
                'retry-after': 120,
                'x-flag': true,
                'x-bad': { nested: true },
                'x-null': null,
              },
            },
          },
        },
        JSON_TYPE,
      );
      expect(init.headers['retry-after']).toBe('120');
      expect(init.headers['x-flag']).toBe('true');
      expect(init.headers).not.toHaveProperty('x-bad');
      expect(init.headers).not.toHaveProperty('x-null');
    });
  });

  describe('extensions sanitization', () => {
    it('never leaks http, even when it holds headers like Set-Cookie', () => {
      const init = buildResponseInit(
        {
          extensions: {
            http: {
              status: 201,
              headers: { 'set-cookie': 'sid=abc; HttpOnly' },
            },
            trace: { id: 't1' },
          },
        },
        JSON_TYPE,
      );
      expect(init.status).toBe(201);
      expect(init.headers['set-cookie']).toBe('sid=abc; HttpOnly');
      expect(init.extensions).toEqual({ trace: { id: 't1' } });
      expect(JSON.stringify(init.extensions)).not.toContain('set-cookie');
      expect(JSON.stringify(init.extensions)).not.toContain('http');
    });

    it('returns undefined when removing http empties the extensions', () => {
      const init = buildResponseInit(
        { extensions: { http: { status: 200 } } },
        JSON_TYPE,
      );
      expect(init.extensions).toBeUndefined();
    });

    it('removes http even when it is null, unlike the truthy-only Yoga check', () => {
      const init = buildResponseInit(
        { extensions: { http: null, trace: 't' } },
        JSON_TYPE,
      );
      expect(init.extensions).toEqual({ trace: 't' });
    });

    it('passes http-free extensions through by reference', () => {
      const extensions = { trace: { id: 't1' } };
      const init = buildResponseInit({ extensions }, JSON_TYPE);
      expect(init.extensions).toBe(extensions);
    });

    it('does not mutate the original extensions object', () => {
      const extensions = { http: { status: 201 }, trace: 't' };
      buildResponseInit({ extensions }, JSON_TYPE);
      expect(extensions).toEqual({ http: { status: 201 }, trace: 't' });
    });
  });

  describe('malformed input', () => {
    it.each([
      ['a string', 'not-an-object'],
      ['null', null],
      ['a number', 42],
      ['an array', [{ status: 500 }]],
    ])('ignores extensions.http being %s', (_label, http) => {
      const init = buildResponseInit({ extensions: { http } }, JSON_TYPE);
      expect(init.status).toBe(200);
      expect(init.headers).toEqual({
        'content-type': 'application/json; charset=utf-8',
      });
      expect(init.extensions).toBeUndefined();
    });

    it('relays non-object extensions untouched — they cannot carry http', () => {
      const init = buildResponseInit({ extensions: 'oops' }, JSON_TYPE);
      expect(init.extensions).toBe('oops');
      expect(init.status).toBe(200);
    });

    it.each([
      ['a string', '503'],
      ['a float', 201.5],
      ['zero', 0],
      ['out of Response range low', 199],
      ['out of Response range high', 600],
      ['null', null],
    ])('ignores a status that is %s', (_label, status) => {
      const init = buildResponseInit(
        { extensions: { http: { status } } },
        JSON_TYPE,
      );
      expect(init.status).toBe(200);
    });

    it('ignores non-object http.headers', () => {
      const init = buildResponseInit(
        { extensions: { http: { headers: 'x=y' } } },
        JSON_TYPE,
      );
      expect(init.headers).toEqual({
        'content-type': 'application/json; charset=utf-8',
      });
    });
  });

  describe('unexpected errors (safety net, never hit on the happy path)', () => {
    it('takes the highest per-error http status, like Yoga', () => {
      const init = buildResponseInit(
        {
          errors: [
            { extensions: { http: { status: 400 } } },
            { extensions: { http: { status: 503 } } },
            { extensions: { http: { status: 401 } } },
          ],
        },
        GRAPHQL_TYPE,
      );
      expect(init.status).toBe(503);
    });

    it('prefers a higher per-error status over the result-level one', () => {
      const init = buildResponseInit(
        {
          extensions: { http: { status: 400 } },
          errors: [{ extensions: { http: { status: 500 } } }],
        },
        GRAPHQL_TYPE,
      );
      expect(init.status).toBe(500);
    });

    it('merges per-error headers even when the status is spec-gated', () => {
      const init = buildResponseInit(
        {
          errors: [
            {
              extensions: {
                http: {
                  spec: true,
                  status: 400,
                  headers: { 'www-authenticate': 'Bearer' },
                },
              },
            },
          ],
        },
        JSON_TYPE,
      );
      // For plain application/json Yoga skips spec-mandated statuses but has
      // already merged the headers; mirror both halves.
      expect(init.status).toBe(200);
      expect(init.headers['www-authenticate']).toBe('Bearer');
    });

    it('applies a spec status for application/graphql-response+json', () => {
      const init = buildResponseInit(
        { errors: [{ extensions: { http: { spec: true, status: 400 } } }] },
        GRAPHQL_TYPE,
      );
      expect(init.status).toBe(400);
    });

    it('does not throw on malformed error entries', () => {
      const init = buildResponseInit(
        {
          errors: [
            null,
            'boom',
            { extensions: null },
            { extensions: { http: 'nope' } },
            { extensions: { http: { status: 'high' } } },
          ],
        },
        JSON_TYPE,
      );
      expect(init.status).toBe(200);
    });

    it('treats an empty errors array as error-free', () => {
      const init = buildResponseInit({ errors: [] }, JSON_TYPE);
      expect(init.status).toBe(200);
    });
  });
});

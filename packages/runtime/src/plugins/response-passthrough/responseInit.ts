/**
 * Derives the HTTP response init for the pass-through writer.
 *
 * Installing a custom result processor bypasses Yoga's `processRegularResult`,
 * and with it two things Yoga quietly does for every other response:
 *
 *  - `getResponseInitByRespectingErrors` (graphql-yoga/esm/error.js) derives
 *    the status and response headers from `result.extensions.http` and from
 *    per-error `extensions.http` blocks;
 *  - `omitInternalsFromResultErrors` (graphql-yoga/esm/plugins/
 *    result-processor/stringify.js) strips `extensions.http` — an internal
 *    channel, not client payload — before serializing.
 *
 * Skipping either means hardcoding a 200, dropping headers the pipeline asked
 * for (a `Set-Cookie`, a cache directive), and leaking the internal `http`
 * block — status plus response headers — into the client-visible body. This
 * module mirrors both behaviours for the pass-through path.
 *
 * Two deliberate deviations from Yoga, both defensive:
 *
 *  - Yoga trusts `extensions.http` to be well-formed and would produce a
 *    broken `ResponseInit` (or mangled extensions) from a malformed one; here
 *    anything that is not the expected shape is ignored, because the writer
 *    has already passed the point where it could fall back.
 *  - Yoga only strips `http` when it is truthy, so `extensions: { http: null }`
 *    would leak through it; here the key is removed whenever it exists.
 */

export interface PassthroughResponseInit {
  status: number;
  headers: Record<string, string>;
  /** result extensions with internals removed; undefined when nothing is left */
  extensions?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges an `extensions.http.headers`-shaped value into `target`, mimicking
 * what a client observes when Yoga `Object.assign`s it into a `ResponseInit`:
 * strings pass through, numbers and booleans are stringified by the `Headers`
 * constructor, anything else has no defined serialization and is dropped.
 */
function mergeHeaders(target: Record<string, string>, source: unknown): void {
  if (!isPlainObject(source)) {
    return;
  }
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      target[name] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      target[name] = String(value);
    }
  }
}

/**
 * A usable `extensions.http.status`. Bounded to what the `Response`
 * constructor accepts (200-599) because by the time this runs the writer can
 * no longer fall back; a value that would make `new Response` throw must be
 * ignored, not propagated.
 */
function statusOf(http: Record<string, unknown>): number | undefined {
  const status = http['status'];
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 599
    ? status
    : undefined;
}

/**
 * Mirrors `omitInternalsFromResultErrors` for the only part of the result the
 * writer relays besides `data`: the result-level extensions. Errors never
 * reach the client on this path (the writer emits `data` and `extensions`
 * only), so the per-error `http`/`unexpected` stripping has nothing to strip.
 */
function sanitizeExtensions(extensions: unknown): unknown {
  if (!isPlainObject(extensions)) {
    // Not a spec-shaped extensions map; it cannot carry an `http` member, so
    // relay it exactly as serializing the original result would have.
    return extensions;
  }
  if (!('http' in extensions)) {
    return extensions;
  }
  const { http: _http, ...rest } = extensions;
  return Object.keys(rest).length ? rest : undefined;
}

/**
 * Derives status, headers and client-safe extensions for a pass-through
 * response, the way `getResponseInitByRespectingErrors` would have.
 *
 * The commit point only ever fires for error-free results, so the error loop
 * below is a safety net rather than a hot path: it mirrors Yoga's per-error
 * `extensions.http` handling — headers merge in, the highest status wins, and
 * for plain `application/json` a status marked `spec` is ignored — but not
 * the GraphQLError-classifying 500 fallback, which needs the error's
 * provenance and cannot apply to a result the writer accepted.
 */
export function buildResponseInit(
  result: { extensions?: unknown; errors?: readonly unknown[] },
  mediaType: string,
): PassthroughResponseInit {
  // Seeded before the merge, like Yoga's `processRegularResult`, so an
  // explicit `extensions.http.headers` content-type wins — same precedence.
  const headers: Record<string, string> = {
    'content-type': `${mediaType}; charset=utf-8`,
  };
  let status: number | undefined;

  const extensions = result.extensions;
  const http = isPlainObject(extensions) ? extensions['http'] : undefined;
  if (isPlainObject(http)) {
    mergeHeaders(headers, http['headers']);
    status = statusOf(http);
  }

  if (result.errors?.length) {
    for (const error of result.errors) {
      if (!isPlainObject(error) || !isPlainObject(error['extensions'])) {
        continue;
      }
      const errorHttp = error['extensions']['http'];
      if (!isPlainObject(errorHttp)) {
        continue;
      }
      mergeHeaders(headers, errorHttp['headers']);
      if (mediaType === 'application/json' && errorHttp['spec']) {
        continue;
      }
      const errorStatus = statusOf(errorHttp);
      if (errorStatus !== undefined && (!status || errorStatus > status)) {
        status = errorStatus;
      }
    }
  }

  return {
    status: status ?? 200,
    headers,
    extensions: sanitizeExtensions(extensions),
  };
}

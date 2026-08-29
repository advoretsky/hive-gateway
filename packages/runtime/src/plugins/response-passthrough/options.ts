/**
 * User-facing configuration for the response pass-through plugin, and its
 * normalization into the predicate form the rest of the plugin consumes.
 *
 * There is deliberately one gate rather than several. An allow-list of fields
 * would age badly: a root field added later would silently never be relayed,
 * and the symptom — a slower response — is invisible. A predicate expresses the
 * same intent, plus deny-lists, staged rollouts and anything else, without
 * anything to keep in sync. The value-or-predicate shape mirrors
 * `useUpstreamTimeout`, which is this repo's convention for per-subgraph
 * configuration.
 */

import type { PassthroughCheck, PassthroughPolicy } from './directive';

export interface PassthroughGatePayload {
  /** The subgraph that would answer the whole operation; `''` if unnamed. */
  subgraphName: string;
  /** The root type the field belongs to, e.g. `Query`. */
  typeName: string;
  /** The root field being considered, unaliased. */
  fieldName: string;
  /** The client's operation name, when it gave one. */
  operationName?: string;
}

export interface ResponsePassthroughOptions {
  /**
   * Whether pass-through may be attempted. `true` by default; a predicate is
   * consulted once per root field, and every root field must be allowed for the
   * operation to be relayed.
   *
   * ```ts
   * enabled: false                                              // off
   * enabled: ({ subgraphName }) => subgraphName === 'products'  // per subgraph
   * enabled: ({ fieldName }) => fieldName === 'orders'          // staged rollout
   * enabled: ({ fieldName }) => fieldName !== 'brokenThing'     // exclude one
   * ```
   */
  enabled?: boolean | ((payload: PassthroughGatePayload) => boolean);
  /**
   * Below this response size in bytes, take the normal path. The saving scales
   * with payload size, so for small responses the scan is not worth its own
   * cost. Default 0.
   */
  minBytes?: number;
  /**
   * The checks to run for subgraphs that carry no `@passthrough` directive of
   * their own; a subgraph's directive always wins over this list. Default
   * none: maximum performance, trusting the subgraph. See the directive module
   * for what each check buys back and what it costs.
   */
  checks?: PassthroughCheck[];
  /**
   * Called whenever pass-through was declined, with a machine-readable reason.
   * Worth wiring up: an operation that silently stops being relayed after a
   * schema change looks exactly like an operation that was never relayed.
   */
  onSkip?(
    reason: string,
    info: { operationName?: string; subgraphName?: string },
  ): void;
  /** Called when a response WAS relayed. */
  onPassthrough?(info: {
    operationName?: string;
    subgraphName?: string;
    bytes: number;
  }): void;
}

export interface NormalizedOptions {
  isEnabled(payload: PassthroughGatePayload): boolean;
  minBytes: number;
  /**
   * The policy applied to subgraphs without a `@passthrough` directive; feed
   * it to `policyFor` alongside what `readPassthroughDirectives` collected.
   * `enabled` is `false` only when the plugin was statically switched off — a
   * predicate cannot be consulted without a root field, so it leaves the
   * policy enabled and keeps gating per root field through `isEnabled`.
   */
  fallbackPolicy: PassthroughPolicy;
  skip(
    reason: string,
    info: { operationName?: string; subgraphName?: string },
  ): void;
  passedThrough(info: {
    operationName?: string;
    subgraphName?: string;
    bytes: number;
  }): void;
}

const noop = () => {};

export function normalizeOptions(
  options: ResponsePassthroughOptions = {},
): NormalizedOptions {
  const enabled = options.enabled ?? true;
  const isEnabled: NormalizedOptions['isEnabled'] =
    typeof enabled === 'function'
      ? (payload) => {
          try {
            // Strict `true` only: a predicate returning something truthy but
            // not boolean is more likely a mistake than an opt-in.
            return enabled(payload) === true;
          } catch {
            // A throwing gate cannot be read as consent.
            return false;
          }
        }
      : () => enabled;

  // Diagnostics must never break a response: a throwing user callback is a
  // bug in the observer, not in the request being observed.
  const onSkip = options.onSkip;
  const skip: NormalizedOptions['skip'] = onSkip
    ? (reason, info) => {
        try {
          onSkip(reason, info);
        } catch {
          // deliberately swallowed
        }
      }
    : noop;

  const onPassthrough = options.onPassthrough;
  const passedThrough: NormalizedOptions['passedThrough'] = onPassthrough
    ? (info) => {
        try {
          onPassthrough(info);
        } catch {
          // deliberately swallowed
        }
      }
    : noop;

  return {
    isEnabled,
    minBytes: options.minBytes ?? 0,
    fallbackPolicy: {
      enabled: enabled !== false,
      checks: new Set(options.checks),
    },
    skip,
    passedThrough,
  };
}

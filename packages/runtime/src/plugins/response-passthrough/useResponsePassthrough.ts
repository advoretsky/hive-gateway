/**
 * Relays a large single-subgraph JSON response to the client without
 * deserializing it, walking it with graphql-js or re-serializing it.
 *
 * The plugin is a three-phase collaboration over one HTTP request:
 *
 *  - `onExecute` decides, once per document, whether the operation *could* be
 *    relayed (`checkEligibility` screens it, `compareShape` proves it) and
 *    arms a per-request holder;
 *  - `onFetch` intercepts the subgraph response for an armed request, keeps
 *    its bytes, and hands the executor a stub shaped like the outgoing request
 *    so the normal pipeline still runs but costs nothing — the stub is
 *    synthesized (`synthesizeStubBody`) so that executing over it raises no
 *    errors at all, which makes every error that does appear on the result
 *    real by construction;
 *  - `onResultProcess` writes the kept bytes straight to the client, re-keyed
 *    to the client's response keys, with the gateway's own extensions
 *    appended.
 *
 * Every phase is one-way: any surprise disarms the holder and the request
 * finishes on the ordinary path. The only irreversible moment is swapping in
 * the stub, so everything that could still refuse — the scan, the `errors`
 * check, the root-key coverage check, the stub synthesis — happens before it,
 * and everything the writer needs — the response chunks, the response init —
 * is built before the processor is replaced, so nothing after the commit can
 * fail into serializing the stub. When a real error surfaces after the commit
 * anyway, the kept bytes are parsed back into `result.data` so the ordinary
 * path serializes the truth, not the placeholder.
 */

import {
  getOperationASTFromDocument,
  isAsyncIterable,
  type ExecutionRequest,
} from '@graphql-tools/utils';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import {
  Kind,
  type DocumentNode,
  type ExecutionArgs,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';
import type { GatewayPlugin } from '../../types';
import { compareOutgoingShape, compareShape } from './compareShape';
import {
  policyFor,
  readPassthroughDirectives,
  type PassthroughPolicy,
} from './directive';
import { checkEligibility } from './eligibility';
import {
  normalizeOptions,
  type NormalizedOptions,
  type ResponsePassthroughOptions,
} from './options';
import { buildResponseInit } from './responseInit';
import { scanJsonResponse, type ScannedResponse } from './scanJsonResponse';
import { synthesizeStubBody } from './stubValue';
import { buildResponseChunks, streamChunks } from './writeResponse';

const decoder = new TextDecoder();

/**
 * Brands the execution result produced over a stubbed subgraph response.
 *
 * The stub's data must never be serialized to a client. This plugin only ever
 * relays the kept bytes instead — but a result object can travel to requests
 * this plugin never armed: inbound in-flight request deduplication
 * (`inboundInflightRequestDeduplication`) shares one execution result across
 * concurrent identical client requests, and that plugin is appended after
 * user plugins, so it caches the stub-derived result and serves it to every
 * follower. The brand lets `onResultProcess` recognize such a result on ANY
 * request and refuse — loudly — to serialize it. An enumerable symbol
 * property survives object spreads and is invisible to `JSON.stringify`.
 */
const STUB_RESULT = Symbol('response-passthrough-stub-result');

function markStubResult(result: object): void {
  (result as Record<PropertyKey, unknown>)[STUB_RESULT] = true;
}

function unmarkStubResult(result: object): void {
  delete (result as Record<PropertyKey, unknown>)[STUB_RESULT];
}

function isStubResult(result: unknown): boolean {
  if (Array.isArray(result)) {
    return result.some(isStubResult);
  }
  return (
    typeof result === 'object' &&
    result !== null &&
    STUB_RESULT in (result as Record<PropertyKey, unknown>)
  );
}

function collectFragments(
  document: DocumentNode,
): Record<string, FragmentDefinitionNode> {
  const fragments: Record<string, FragmentDefinitionNode> = Object.create(null);
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments[definition.name.value] = definition;
    }
  }
  return fragments;
}

/**
 * Parses the kept subgraph bytes back into client-keyed `data`.
 *
 * The escape hatch for a real error surfacing after the stub was committed:
 * the client must then be served the ordinary serialization — errors and all —
 * and that serialization must carry the subgraph's actual data, not the
 * stub's placeholders. This is the parse the plugin exists to avoid, paid
 * only on the error path. Returns `null` when the bytes cannot be parsed
 * (possible when the JSON check is off), which serializes as `data: null` —
 * degraded but honest, and the errors still reach the client.
 */
function recoverRealData(
  body: Uint8Array,
  outgoingKeyMap: Map<string, string>,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decoder.decode(body)) as {
      data?: Record<string, unknown> | null;
    };
    const source = parsed?.data;
    if (source == null || typeof source !== 'object') {
      return null;
    }
    // outgoingKeyMap iterates in the client's key order, so the recovered
    // object serializes in the same order an executed response would have.
    const data: Record<string, unknown> = {};
    for (const [outgoingKey, clientKey] of outgoingKeyMap) {
      data[clientKey] = source[outgoingKey];
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * The response for a request whose result turned out to be another request's
 * stub. Serializing the stub would be a fabricated success; an explicit
 * internal error is the only honest answer left.
 */
function stubLeakResponse(fetchAPI: { Response: typeof Response }): Response {
  return new fetchAPI.Response(
    JSON.stringify({
      errors: [
        {
          message:
            'response pass-through: the execution result was shared with ' +
            'another request and no longer describes this one; response ' +
            'pass-through is mutually exclusive with ' +
            'inboundInflightRequestDeduplication',
        },
      ],
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

const JSON_MEDIA_TYPE = 'application/json';
const GRAPHQL_RESPONSE_MEDIA_TYPE = 'application/graphql-response+json';

/**
 * Subgraphs answer with either media type depending on what the executor
 * asked for; anything else (SSE, multipart/mixed) is incremental delivery and
 * is left alone.
 */
const JSON_CONTENT_TYPE = /^application\/(graphql-response\+)?json\b/;

/** batch-execute prefixes each merged request's root fields. */
const BATCH_PREFIX = /^_v\d+_/;

interface Verdict {
  /** The schema the verdict was reached against; a reload invalidates it. */
  schema: GraphQLSchema;
  eligible: boolean;
  reason?: string;
  operationName?: string;
  subgraphName?: string;
  /** subgraph top-level data key -> client response key */
  rootKeyMap?: Map<string, string>;
  /** The subgraph schema the outgoing document is checked against. */
  subgraphSchema?: GraphQLSchema;
  operation?: OperationDefinitionNode;
  /** The `@passthrough` policy of the answering subgraph. */
  policy?: PassthroughPolicy;
}

interface SkipInfo {
  operationName?: string;
  subgraphName?: string;
}

interface Holder extends SkipInfo {
  /** subgraph root key as `compareShape` predicted it -> client response key */
  rootKeyMap: Map<string, string>;
  /** the same, re-derived from the document the subgraph was actually sent */
  outgoingKeyMap?: Map<string, string>;
  /** Cleared the moment anything disqualifies this request. */
  armed: boolean;
  /** The media type this client negotiated, decided before arming. */
  mediaType: string;
  /** Everything the outgoing-document check needs, captured at arm time. */
  unifiedSchema: GraphQLSchema;
  subgraphSchema: GraphQLSchema;
  clientDocument: DocumentNode;
  clientOperation: OperationDefinitionNode;
  /** Fragments of the client document, for the stub synthesizer. */
  clientFragments: Record<string, FragmentDefinitionNode>;
  /** Decides which checks the answering subgraph wants run. */
  policy: PassthroughPolicy;
  /**
   * The document the verdict was reached against. A plugin later in the chain
   * may rewrite it before execution — the response cache injects its own
   * aliases that way — and the verdict does not describe that document.
   */
  document: DocumentNode;
  /**
   * The execution request the subgraph executor was ACTUALLY invoked with.
   * `onFetch` resolves its own `executionRequest` through `info`, which is
   * pinned to the original request before `onSubgraphExecute` hooks run — so
   * a request swapped by `setExecutionRequest` would be invisible there. The
   * plugin's own executor wrapper records the real one.
   */
  outgoingExecutionRequest?: ExecutionRequest;
  body?: Uint8Array;
  scan?: ScannedResponse;
}

/**
 * The stub body for an operation, computed once.
 *
 * Synthesizing walks the whole client selection and serializes the result, so
 * doing it per request is a real cost on a wide query — and a wasted one, since
 * the stub depends only on the schema, the operation and the outgoing key
 * mapping, none of which vary between requests for the same document. Variables
 * do not enter into it: the stub describes shape, never values.
 */
const stubBodies = new WeakMap<
  OperationDefinitionNode,
  WeakMap<GraphQLSchema, Map<string, Uint8Array | null>>
>();

function stubBodyFor(
  holder: Holder,
  outgoingKeyMap: Map<string, string>,
): Uint8Array | undefined {
  // Keyed by schema as well as operation: parsed documents outlive a schema
  // reload, and the stub encodes that schema's nullability, so a stub cached
  // against the previous generation would be wrong in exactly the way this
  // whole mechanism relies on being right.
  const signature = [...outgoingKeyMap].map(([o, c]) => `${o}>${c}`).join('|');
  let bySchema = stubBodies.get(holder.clientOperation);
  if (!bySchema) {
    bySchema = new WeakMap();
    stubBodies.set(holder.clientOperation, bySchema);
  }
  let bySignature = bySchema.get(holder.unifiedSchema);
  if (!bySignature) {
    bySignature = new Map();
    bySchema.set(holder.unifiedSchema, bySignature);
  }
  const cached = bySignature.get(signature);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const keyByClientKey = new Map<string, string>();
  for (const [outgoingKey, clientKey] of outgoingKeyMap) {
    keyByClientKey.set(clientKey, outgoingKey);
  }
  const body = synthesizeStubBody(
    holder.unifiedSchema,
    holder.clientOperation,
    holder.clientFragments,
    keyByClientKey,
  );
  // `null` records "cannot be synthesized", so a hopeless operation is not
  // re-walked on every request.
  bySignature.set(signature, body ?? null);
  return body;
}

/** Diagnostics see only what identifies the request, not the plugin's state. */
function skipInfo({ operationName, subgraphName }: SkipInfo): SkipInfo {
  return { operationName, subgraphName };
}

/** The HTTP request is the only object all three phases can see. */
function requestOf(value: unknown): Request | undefined {
  const request = (value as { request?: unknown } | null | undefined)?.request;
  return typeof request === 'object' && request !== null
    ? (request as Request)
    : undefined;
}

/**
 * Rebuilds a response around bytes we have already consumed.
 *
 * The constructor is taken from the response itself rather than imported: the
 * subgraph response may come from any fetch implementation the user installed,
 * and the executor downstream expects that same implementation's `Response`.
 * `content-length` is dropped because the stub body is a different size.
 */
function respondWith(response: Response, body: Uint8Array): Response {
  const ResponseCtor = response.constructor as typeof Response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new ResponseCtor(body as BodyInit, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Re-derives the root-key mapping from the document that is actually going out.
 *
 * One eligible operation does not imply one subgraph request: without batching
 * the gateway delegates each root field separately, and with batching it merges
 * them into one document under `_v0_`-style prefixes. Only a request whose root
 * selections cover the *whole* operation may be relayed, because relaying is
 * destructive — the bytes replace the client's entire response.
 *
 * Returns the mapping in the client's key order, or undefined when this request
 * is not the whole answer.
 */
function outgoingKeyMapFor(
  executionRequest: ExecutionRequest,
  rootKeyMap: Map<string, string>,
): Map<string, string> | undefined {
  const operation = getOperationASTFromDocument(
    executionRequest.document,
    executionRequest.operationName,
  );
  if (!operation) {
    return undefined;
  }

  const outgoingByClientKey = new Map<string, string>();
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      return undefined;
    }
    const outgoingKey = selection.alias?.value ?? selection.name.value;
    const clientKey =
      rootKeyMap.get(outgoingKey) ??
      rootKeyMap.get(outgoingKey.replace(BATCH_PREFIX, ''));
    if (clientKey === undefined || outgoingByClientKey.has(clientKey)) {
      return undefined;
    }
    outgoingByClientKey.set(clientKey, outgoingKey);
  }
  if (outgoingByClientKey.size !== rootKeyMap.size) {
    return undefined;
  }

  // Emit in the client's order so the relayed bytes carry the same key order a
  // normally executed response would have.
  const ordered = new Map<string, string>();
  for (const clientKey of rootKeyMap.values()) {
    const outgoingKey = outgoingByClientKey.get(clientKey);
    if (outgoingKey === undefined) {
      return undefined;
    }
    ordered.set(outgoingKey, clientKey);
  }
  return ordered;
}

/**
 * Mirrors Yoga's own negotiation between the two JSON media types, so a relayed
 * response carries the same `content-type` an executed one would have. Yoga
 * picks the first acceptable entry in the client's `accept` header and ignores
 * entries asking for a charset it cannot produce.
 */
/**
 * The JSON media type this client would be served, or `undefined` when it
 * would not be served JSON at all.
 *
 * Returning a media type the client did not ask for would override Yoga's own
 * content negotiation: a client accepting only `text/event-stream` must keep
 * getting SSE, and one accepting nothing we can serve must still get its 406.
 * So this is consulted before arming, never after the bytes are committed.
 */
function negotiatedJsonMediaType(request: Request): string | undefined {
  const header = request.headers.get('accept');
  if (!header) {
    // No preference expressed: Yoga serves JSON.
    return JSON_MEDIA_TYPE;
  }
  const accepts = header.replace(/\s/g, '').toLowerCase().split(',');
  for (const entry of accepts) {
    const [mediaType, ...params] = entry.split(';');
    const charset = params.find((param) => param.includes('charset='));
    if (charset != null && charset !== 'charset=utf-8') {
      continue;
    }
    if (
      mediaType === GRAPHQL_RESPONSE_MEDIA_TYPE ||
      mediaType === JSON_MEDIA_TYPE
    ) {
      return mediaType;
    }
    if (mediaType === '*/*' || mediaType === 'application/*') {
      // A wildcard expresses no preference, and Yoga answers those with plain
      // JSON — matched here so the relayed response carries the same
      // content-type the ordinary path would have negotiated.
      return JSON_MEDIA_TYPE;
    }
  }
  return undefined;
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType != null && JSON_CONTENT_TYPE.test(contentType.trim());
}

export function useResponsePassthrough<TContext extends Record<string, any>>(
  options: ResponsePassthroughOptions = {},
): GatewayPlugin<TContext> {
  const opts: NormalizedOptions = normalizeOptions(options);

  // The verdict depends only on the document, the operation within it and the
  // schema, so it is computed once and reused for every request that repeats
  // them — the shape comparison runs the whole delegation pipeline and is far
  // too expensive to repeat per request.
  const verdicts = new WeakMap<DocumentNode, Map<string, Verdict>>();
  const holders = new WeakMap<Request, Holder>();
  // Requests whose body was a JSON array. Yoga runs one execution per array
  // element over the same HTTP Request, so relaying any single one of them
  // would replace the whole batched response; such requests must never arm.
  const batchedRequests = new WeakSet<Request>();
  // `@passthrough` directives are part of the schema, so they are read once
  // per schema generation and a reload naturally invalidates them.
  const policiesBySchema = new WeakMap<
    GraphQLSchema,
    Map<string, PassthroughPolicy>
  >();

  function directivePoliciesFor(
    schema: GraphQLSchema,
  ): Map<string, PassthroughPolicy> {
    let policies = policiesBySchema.get(schema);
    if (!policies) {
      policies = readPassthroughDirectives(schema);
      policiesBySchema.set(schema, policies);
    }
    return policies;
  }

  function evaluate(args: ExecutionArgs): Verdict {
    const { schema, document } = args;
    const requestedName = args.operationName ?? undefined;
    try {
      const operation = getOperationASTFromDocument(document, requestedName);
      // Reported to the diagnostics alongside every decision, so it is resolved
      // once here rather than re-walking the document on every request.
      const operationName = requestedName ?? operation?.name?.value;

      const policies = directivePoliciesFor(schema);
      const decision = checkEligibility(schema, document, requestedName, {
        isEnabled: opts.isEnabled,
        checksFor: (subgraphName) =>
          policyFor(subgraphName, policies, opts.fallbackPolicy).checks,
      });
      if (!decision.eligible || !decision.subschema) {
        return {
          schema,
          eligible: false,
          operationName,
          reason: decision.reason ?? 'ineligible',
        };
      }

      if (!operation) {
        return {
          schema,
          eligible: false,
          operationName,
          reason: 'no-operation',
        };
      }

      const shape = compareShape({
        unifiedSchema: schema,
        document,
        operation,
        subschema: decision.subschema,
        variableValues: args.variableValues ?? undefined,
        context: args.contextValue as Record<string, unknown>,
        rootValue: args.rootValue,
      });
      if (!shape.matches || !shape.rootKeyMap) {
        return {
          schema,
          eligible: false,
          operationName,
          reason: shape.mismatch ?? 'shape-mismatch',
          subgraphName: decision.subschema.name,
        };
      }

      return {
        schema,
        eligible: true,
        operationName,
        subgraphName: decision.subschema.name,
        rootKeyMap: shape.rootKeyMap,
        subgraphSchema: decision.subschema.schema,
        operation,
        policy: policyFor(
          decision.subschema.name ?? '',
          policies,
          opts.fallbackPolicy,
        ),
      };
    } catch (error) {
      // Deciding is the risky part; failing to decide is never a reason to
      // fail the request.
      return {
        schema,
        eligible: false,
        operationName: requestedName,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function verdictFor(args: ExecutionArgs): Verdict {
    const key = args.operationName ?? '';
    let byOperation = verdicts.get(args.document);
    if (!byOperation) {
      byOperation = new Map();
      verdicts.set(args.document, byOperation);
    }
    const cached = byOperation.get(key);
    if (cached && cached.schema === args.schema) {
      return cached;
    }
    const verdict = evaluate(args);
    byOperation.set(key, verdict);
    return verdict;
  }

  function release(request: Request, holder: Holder): void {
    holder.armed = false;
    // The body is the whole point of the plugin's memory profile; drop the
    // reference as soon as it can no longer be written.
    holder.body = undefined;
    holder.scan = undefined;
    holder.outgoingKeyMap = undefined;
    holder.outgoingExecutionRequest = undefined;
    holders.delete(request);
  }

  function holderFor(
    executionRequest: ExecutionRequest | undefined,
  ): { request: Request; holder: Holder } | undefined {
    const request = requestOf(executionRequest?.context);
    if (!request) {
      return undefined;
    }
    const holder = holders.get(request);
    if (!holder || !holder.armed) {
      return undefined;
    }
    if (
      executionRequest?.subgraphName != null &&
      holder.subgraphName != null &&
      executionRequest.subgraphName !== holder.subgraphName
    ) {
      // A subgraph the verdict did not account for is contributing to this
      // response after all; relaying one subgraph's bytes would lose it.
      release(request, holder);
      opts.skip('unexpected-subgraph', skipInfo(holder));
      return undefined;
    }
    return { request, holder };
  }

  return {
    /**
     * Batched requests are detected structurally, from the parsed body,
     * rather than by counting executions: with `batching: true` a body that
     * is a JSON array of ONE operation still executes exactly once, so a
     * counting guard never fires for it — but its result reaches the result
     * processor wrapped in an array, which no relay can represent.
     */
    onRequestParse({ request }) {
      return {
        onRequestParseDone({ requestParserResult }) {
          if (Array.isArray(requestParserResult)) {
            batchedRequests.add(request);
          }
        },
      };
    },

    onExecute({ args, executeFn, setExecuteFn }) {
      const request = requestOf(args.contextValue);
      if (!request) {
        return;
      }

      if (batchedRequests.has(request)) {
        opts.skip('batched-request', {
          operationName: args.operationName ?? undefined,
        });
        return;
      }

      const existing = holders.get(request);
      if (existing) {
        // One HTTP request carrying several operations — a batched request, or
        // a dedupe follower sharing this one. The holder is keyed by request,
        // so a second operation would overwrite the first one's state and the
        // client would receive one operation's bytes for both. Refuse both.
        release(request, existing);
        opts.skip('multiple-operations-per-request', skipInfo(existing));
        return;
      }

      const verdict = verdictFor(args);
      if (!verdict.eligible || !verdict.rootKeyMap) {
        opts.skip(verdict.reason ?? 'ineligible', skipInfo(verdict));
        return;
      }

      // Decided before arming: writing JSON to a client that asked for SSE, or
      // that we would otherwise have refused with a 406, is not this plugin's
      // call to make.
      const mediaType = negotiatedJsonMediaType(request);
      if (!mediaType) {
        opts.skip('client-does-not-accept-json', skipInfo(verdict));
        return;
      }

      if (!verdict.subgraphSchema || !verdict.operation || !verdict.policy) {
        opts.skip('incomplete-verdict', skipInfo(verdict));
        return;
      }

      const holder: Holder = {
        operationName: verdict.operationName,
        subgraphName: verdict.subgraphName,
        rootKeyMap: verdict.rootKeyMap,
        armed: true,
        mediaType,
        unifiedSchema: args.schema,
        subgraphSchema: verdict.subgraphSchema,
        clientDocument: args.document,
        clientOperation: verdict.operation,
        clientFragments: collectFragments(args.document),
        policy: verdict.policy,
        document: args.document,
      };
      holders.set(request, holder);

      // `executeFn` may already be a wrapper — graceful schema reload pins the
      // generation an operation runs against by replacing it — so it is called,
      // never replaced.
      setExecuteFn((executionArgs) => {
        // The verdict describes the document seen at `onExecute`. A plugin
        // registered after this one may hand execution a different one — the
        // response cache rewrites the document to inject `__responseCacheTypeName`
        // aliases, whose values would then be relayed to the client as though
        // the client had asked for them. Any rewrite invalidates the verdict.
        if (executionArgs.document !== holder.document) {
          release(request, holder);
          opts.skip('document-rewritten', skipInfo(holder));
        }
        return handleMaybePromise(
          () => executeFn(executionArgs),
          (result) => {
            if (!holder.armed) {
              // Released above (the document was rewritten); the reason was
              // already reported.
              return result;
            }

            // Nothing was kept, or the result streams incrementally: either way
            // the response will be written the ordinary way. Report it, so an
            // operation that quietly stops being relayed is visible.
            if (!holder.body || isAsyncIterable(result)) {
              const reason = isAsyncIterable(result)
                ? 'incremental-result'
                : 'no-subgraph-response';
              release(request, holder);
              opts.skip(reason, skipInfo(holder));
              return result;
            }

            // The stub was synthesized to complete with zero errors, so any
            // error on this result was put there deliberately — by a plugin
            // wrapping execution inside this one. It is real, and a relay
            // would drop it. Decline instead, restoring the subgraph's actual
            // data so the ordinary path serializes truth plus the error.
            if (result.errors?.length) {
              const data = holder.outgoingKeyMap
                ? recoverRealData(holder.body, holder.outgoingKeyMap)
                : null;
              release(request, holder);
              opts.skip('result-has-errors', skipInfo(holder));
              return { ...result, data };
            }

            // The result's own data is the completed stub. It is never
            // serialized — the relay replaces it — but it can escape through
            // result-sharing plugins, so it is branded for `onResultProcess`
            // to recognize wherever it surfaces.
            markStubResult(result);
            return result;
          },
          (error) => {
            release(request, holder);
            throw error;
          },
        );
      });
    },

    /**
     * Refuses to relay when the subgraph response could be shared with another
     * client request.
     *
     * The HTTP executor deduplicates in-flight subgraph requests by default,
     * so two concurrent identical queries are answered by ONE fetch whose
     * result both share. Relaying replaces that shared response with a stub,
     * which poisons every request except the one that installed it — the others
     * are served `{"data":null}`. The plugin cannot detect the sharing from
     * `onFetch`, because the followers never reach it.
     *
     * Fails closed: pass-through stays off unless deduplication is explicitly
     * disabled for the subgraph.
     */
    onSubgraphExecute({
      executionRequest,
      transportEntry,
      executor,
      setExecutor,
    }) {
      const entry = holderFor(executionRequest);
      if (!entry) {
        return;
      }
      const dedupe = (
        transportEntry?.options as
          | { deduplicateInflightRequests?: boolean }
          | undefined
      )?.deduplicateInflightRequests;
      if (dedupe !== false) {
        release(entry.request, entry.holder);
        opts.skip('upstream-dedupe-enabled', skipInfo(entry.holder));
        return;
      }
      const { holder } = entry;
      // A hook after this one may swap the execution request for a rewritten
      // one (`setExecutionRequest`). The fetch phase cannot see that swap:
      // its `executionRequest` is resolved through `info`, which still names
      // the original request. Wrapping the executor records the request that
      // is actually executed, so the outgoing-document check judges what the
      // subgraph really receives.
      setExecutor((outgoingRequest) => {
        holder.outgoingExecutionRequest = outgoingRequest;
        return executor(outgoingRequest);
      });
      return;
    },

    onFetch({ executionRequest }) {
      const entry = holderFor(executionRequest);
      if (!entry) {
        return;
      }
      const { request, holder } = entry;

      // Prefer the request the executor wrapper recorded: it reflects any
      // swap a later `onSubgraphExecute` hook made, which the `executionRequest`
      // resolved through `info` does not.
      const outgoingRequest =
        holder.outgoingExecutionRequest ?? executionRequest;

      const outgoingKeyMap = outgoingRequest
        ? outgoingKeyMapFor(outgoingRequest, holder.rootKeyMap)
        : undefined;
      if (!outgoingKeyMap) {
        // Declining here, before the response exists, leaves it untouched.
        release(request, holder);
        opts.skip('partial-subgraph-request', skipInfo(holder));
        return;
      }

      // `compareShape` proved what the gateway *alone* would send. Plugins
      // registered after this one execute inside its wrapper, so their edits
      // are invisible there — the response cache rewrites the document to add
      // `__responseCacheTypeName` aliases, and relaying those would hand the
      // client fields it never asked for. The document that is actually going
      // out is therefore checked again here, while declining is still free.
      const outgoingMismatch = outgoingRequest
        ? compareOutgoingShape({
            unifiedSchema: holder.unifiedSchema,
            subgraphSchema: holder.subgraphSchema,
            clientDocument: holder.clientDocument,
            clientOperation: holder.clientOperation,
            outgoingDocument: outgoingRequest.document,
            outgoingOperationName: outgoingRequest.operationName,
            outgoingKeyMap,
            // Without EXACT_FIELDS an injected unaliased `__typename` is
            // tolerated (and relayed); every other added key still declines.
            tolerateAddedTypename: !holder.policy.checks.has('EXACT_FIELDS'),
          })
        : 'no execution request';
      if (outgoingMismatch) {
        release(request, holder);
        opts.skip(outgoingMismatch, skipInfo(holder));
        return;
      }

      holder.outgoingKeyMap = outgoingKeyMap;

      return async function onResponsePassthroughFetchDone({
        response,
        setResponse,
      }) {
        if (!holder.armed) {
          return;
        }

        // A compressed body would have to be inflated to be scanned, which is
        // the cost this plugin exists to avoid, and inflating it here would
        // also step on whichever hook normally does it.
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding !== 'identity') {
          release(request, holder);
          opts.skip('encoded-response', skipInfo(holder));
          return;
        }

        if (!isJsonResponse(response)) {
          // SSE or multipart/mixed: incremental delivery, handled normally.
          release(request, holder);
          opts.skip('non-json-response', skipInfo(holder));
          return;
        }

        let body: Uint8Array;
        try {
          body = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          release(request, holder);
          opts.skip(
            error instanceof Error ? error.message : String(error),
            skipInfo(holder),
          );
          return;
        }

        // The body has been consumed, so the response has to be rebuilt before
        // anything below can decline.
        setResponse(respondWith(response, body));

        if (holder.body) {
          // A second subgraph response for one operation: the first one's bytes
          // are no longer the whole answer.
          release(request, holder);
          opts.skip('multiple-subgraph-responses', skipInfo(holder));
          return;
        }

        if (body.length < opts.minBytes) {
          release(request, holder);
          opts.skip('below-min-bytes', skipInfo(holder));
          return;
        }

        // Structure is always checked (the relay re-frames the bytes, so the
        // scanner must at least understand them); content-level validation is
        // what the JSON check buys.
        const scan = scanJsonResponse(body, {
          validate: holder.policy.checks.has('JSON'),
        });
        if (!scan) {
          release(request, holder);
          opts.skip('unscannable-response', skipInfo(holder));
          return;
        }
        if (scan.keys.has('errors')) {
          // Errors must be annotated with the client's path and merged with the
          // gateway's own; only the normal path can do that.
          release(request, holder);
          opts.skip('errors-present', skipInfo(holder));
          return;
        }
        if (!scan.dataFields) {
          release(request, holder);
          opts.skip('data-not-object', skipInfo(holder));
          return;
        }

        // Last chance to refuse: after the stub is installed the real payload
        // exists only here, so the writer must not be able to fail later.
        const { dataFields } = scan;
        if (
          dataFields.size !== outgoingKeyMap.size ||
          [...outgoingKeyMap.keys()].some((key) => !dataFields.has(key))
        ) {
          release(request, holder);
          opts.skip('root-keys-mismatch', skipInfo(holder));
          return;
        }

        // The stub must execute with ZERO errors — that is what lets the
        // wrapper above treat any error on the result as real. A selection
        // no error-free value exists for is a decline, not a commitment.
        const stubBody = stubBodyFor(holder, outgoingKeyMap);
        if (!stubBody) {
          release(request, holder);
          opts.skip('stub-not-synthesizable', skipInfo(holder));
          return;
        }

        holder.body = body;
        holder.scan = scan;
        setResponse(respondWith(response, stubBody));
      };
    },

    onResultProcess({ request, result, setResultProcessor }) {
      const holder = holders.get(request);

      if (!holder || !holder.body || !holder.scan || !holder.outgoingKeyMap) {
        if (holder) {
          // Armed, but nothing was kept, or execution was bypassed entirely —
          // an outer wrapper (inbound request deduplication) answered from
          // another request's execution without ever calling this one's.
          release(request, holder);
        }
        if (isStubResult(result)) {
          // This request is about to serialize a result that only ever
          // described another request's placeholder. Serializing it would be
          // a fabricated all-null 200; failing loudly is the only honest
          // option left, because the real bytes belong to the request that
          // kept them.
          opts.skip('stub-result-shared', skipInfo(holder ?? {}));
          setResultProcessor(
            (_result, fetchAPI) => stubLeakResponse(fetchAPI),
            holder?.mediaType ?? JSON_MEDIA_TYPE,
          );
        }
        return;
      }

      const {
        body,
        scan,
        outgoingKeyMap,
        operationName,
        subgraphName,
        mediaType,
      } = holder;
      const info = skipInfo(holder);

      if (isAsyncIterable(result) || Array.isArray(result)) {
        // A post-execution plugin replaced the single result this holder
        // committed to. Whatever it is now, the relay cannot represent it.
        release(request, holder);
        if (isStubResult(result)) {
          opts.skip('stub-result-shared', info);
          setResultProcessor(
            (_result, fetchAPI) => stubLeakResponse(fetchAPI),
            mediaType,
          );
        } else {
          opts.skip('result-not-a-single-result', info);
        }
        return;
      }

      // Errors attached after execution — an authorization plugin's
      // `onExecutionResult`, typically — are real: the stub cannot produce
      // any. They must reach the client through the ordinary error path, and
      // alongside the subgraph's actual data, not the stub's.
      if (result.errors?.length) {
        result.data = recoverRealData(body, outgoingKeyMap);
        unmarkStubResult(result);
        release(request, holder);
        opts.skip('result-has-errors', info);
        return;
      }

      // Everything that can still fail happens NOW, while declining is an
      // option. Replacing the result processor bypasses Yoga's own, and with
      // it the two things it does for every other response: deriving status
      // and headers from `extensions.http`, and stripping that block so it
      // never reaches the client — so both are reproduced here.
      let init: ReturnType<typeof buildResponseInit>;
      let chunks: Uint8Array[];
      try {
        init = buildResponseInit(result, mediaType);
        chunks = buildResponseChunks({
          body,
          scan,
          rootKeyMap: outgoingKeyMap,
          extensions: init.extensions,
        });
      } catch (error) {
        // Declining this late means the ordinary path serializes the result,
        // so its data must be made real first. If the extensions are what
        // refused to serialize, the ordinary path will refuse them too —
        // exactly as it would have without this plugin.
        result.data = recoverRealData(body, outgoingKeyMap);
        unmarkStubResult(result);
        release(request, holder);
        opts.skip(error instanceof Error ? error.message : String(error), info);
        return;
      }

      let contentLength = 0;
      for (const chunk of chunks) {
        contentLength += chunk.length;
      }
      // The whole payload is known, so say so; a streamed body would
      // otherwise go out chunked with no length.
      init.headers['content-length'] = String(contentLength);

      // Hand ownership of the bytes to the processor closure so the holder
      // stops retaining them for the lifetime of the request object.
      release(request, holder);

      setResultProcessor((_result, fetchAPI) => {
        // Nothing in here may fail into serializing the stub: the chunks and
        // init above are prebuilt, and streaming prebuilt chunks cannot
        // throw. The catch is a last-ditch guard for a hostile fetch
        // implementation — it answers with an explicit error, never with a
        // fallback that would serialize fabricated data as a success.
        try {
          opts.passedThrough({
            operationName,
            subgraphName,
            bytes: body.length,
          });
          return new fetchAPI.Response(streamChunks(chunks), {
            status: init.status,
            headers: init.headers,
          });
        } catch (error) {
          opts.skip(
            error instanceof Error ? error.message : String(error),
            info,
          );
          return new fetchAPI.Response(
            JSON.stringify({
              errors: [
                {
                  message: 'response pass-through failed to write the response',
                },
              ],
            }),
            {
              status: 500,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            },
          );
        }
      }, mediaType);
    },
  };
}

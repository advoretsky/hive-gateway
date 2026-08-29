# Response pass-through

Relays a single-subgraph JSON response straight to the client, without
deserializing it, walking it with graphql-js, or re-serializing it. When an
operation can be answered by one subgraph and nothing needs merging, the
gateway has nothing to contribute to the payload — so the subgraph's bytes are
written to the socket unchanged, re-keyed only at the top level.

Measured on a 1.1 MB response over HTTP: **62.8 ms → 21.3 ms mean (2.95x),
p99 81.8 ms → 22.8 ms**. The p99 improvement is larger than the mean because
the parsed object graph is never built: 300 requests through the normal path
triggered 31 garbage collections, and the same 300 through this path triggered
none.

The saving scales with payload size. On small responses there is nothing to
win, which is what `minBytes` is for.

## Usage

```ts
// gateway.config.ts
import { defineConfig } from '@graphql-hive/gateway';
import { useResponsePassthrough } from './response-passthrough';

export const gatewayConfig = defineConfig({
  // REQUIRED. See "Upstream request deduplication" below — without this the
  // plugin declines every operation.
  transportEntries: {
    '*': { options: { deduplicateInflightRequests: false } },
  },
  plugins: () => [
    useResponsePassthrough({
      minBytes: 32_768,
      onSkip(reason, info) {
        console.debug('passthrough declined', reason, info);
      },
    }),
  ],
});
```

### Upstream request deduplication

The HTTP executor deduplicates in-flight subgraph requests **by default**
(`deduplicateInflightRequests`, default `true`). Two concurrent identical
queries are then answered by a single subgraph fetch whose result both requests
share — and a shared response cannot be relayed, because relaying replaces it
with a stub that would poison every request except the one that installed it.

The plugin cannot detect this from the response, because the other requests
never reach its fetch hook. So it **fails closed**: unless deduplication is
explicitly disabled for the subgraph, every operation is declined with
`upstream-dedupe-enabled` and the gateway behaves exactly as though the plugin
were not installed.

Disabling deduplication means concurrent identical queries each hit the
subgraph. For workloads where responses are per-user or otherwise unique — the
workloads this plugin is for — deduplication rarely fires anyway, so the cost is
usually nil. If your traffic genuinely benefits from it, keep it and do not use
this plugin.

The same reasoning applies to the gateway's inbound in-flight deduplication
(`inboundInflightRequestDeduplication`): it shares one execution result between
client requests, and is **mutually exclusive** for the same reason — do not
enable both. The plugin cannot decline this one up front (the sharing happens
in a plugin appended after all user plugins), but it fails loudly instead of
silently: every execution result produced over a pass-through stub is branded,
and a request about to serialize a result that only ever described _another_
request's stub is answered with an explicit 500 (`stub-result-shared`) rather
than fabricated all-null data.

## What it does, and does not, apply to

The plugin is silent and conservative: when anything about an operation cannot
be proven safe, it does nothing at all and the request takes the ordinary path.
A declined operation is never slower than it would have been without the plugin
installed, but it is also no faster — so if you expect a query to be relayed and
it is not, wire up `onSkip` and read the reason.

It applies only to operations that are **all** of:

- a `query` (not a mutation or subscription), alone in its document;
- answerable by exactly **one** subgraph, with no entity resolution or type
  merging;
- free of interfaces and unions anywhere in the selection;
- answered with a JSON body, uncompressed, carrying no `errors`;
- requested by a client that accepts JSON.

## Implications you are accepting

This is the part worth reading twice. The gateway normally walks every value in
a subgraph response and rebuilds it. Skipping that walk is the entire point of
this plugin, and it has consequences that are **inherent, not bugs**. The plugin
declines the cases below rather than changing behaviour silently — but you
should understand what it is protecting you from, because the protection is
what costs you coverage.

### Leaf values are not coerced

Normally every leaf goes through `parseValue` on the way in and `serialize` on
the way out. Relayed bytes go through neither. **By default the plugin trusts
the subgraph here**; opting into the `LEAF_VALUES` check (via the
`@passthrough` directive or the `checks` option, see below) declines the
hazardous cases instead:

- **Custom scalars** are declined under `LEAF_VALUES`
  (`custom-scalar-serializer`). A custom scalar whose serializer is the
  identity would be safe, but that cannot be determined by inspection, so all
  of them are refused.
- **Enums with `@inaccessible` values** are declined under `LEAF_VALUES`
  (`inaccessible-enum-value`). The subgraph, not the client, chooses which enum
  value to return; normally an inaccessible member is coerced to `null` before
  the client sees it. Relayed bytes would carry it through, so any enum that
  has such a member disqualifies the operation.

### Null propagation is not enforced

The gateway does not check the relayed payload against the schema. If a subgraph
omits a field the schema declares non-null, or returns a value of the wrong
type, that reaches the client as sent instead of being nulled or errored. A
conformant subgraph never does this; a misbehaving one is not caught here.

### Post-execution result transforms are honoured by declining

The stub handed to the executor is synthesized so that executing over it
raises **zero** errors, which makes every error on the result real by
construction. A plugin that attaches an error after execution — an
authorization plugin's `onExecutionResult`, say — therefore causes the relay
to be declined (`result-has-errors`): the kept subgraph bytes are parsed back
into `result.data` and the ordinary path serializes real data plus the error,
exactly as it would without this plugin.

A plugin that edits `result.data` _without_ adding an error still has no
effect on a relayed response, because the gateway never produces that payload.
Plugins that only add `extensions` are unaffected, and `extensions.http` is
still honoured for the response status and headers.

### JSON key order follows the subgraph

An executed response emits keys in the client's selection order. A relayed one
emits them in the subgraph's order. This has no meaning in JSON, but it will
break snapshot tests that compare response _strings_ rather than parsed values.
Root-level keys are the exception — those are re-keyed, so they keep the
client's order and aliases.

## Interactions with other features

| Feature                                                 | Effect                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Response caching**                                    | Injects `__responseCacheTypeName` / `__responseCacheId` aliases into the document. Detected and declined; caching itself continues to work normally. |
| **Hive usage reporting**                                | With error-coordinate tracking it injects `__hive_typename__` aliases. Declined the same way.                                                        |
| **`@defer` / `@stream`**                                | Declined (`incremental-delivery`).                                                                                                                   |
| **Subscriptions, SSE, multipart**                       | Declined; the response never reaches the JSON path.                                                                                                  |
| **Batched HTTP requests**                               | Declined (`batched-request`) — detected structurally from the array body, so a one-element batch is declined too.                                    |
| **Compressed subgraph responses**                       | Declined; inflating to scan would cost what the plugin exists to save.                                                                               |
| **Graceful schema reload**                              | Composes with it. Verdicts are keyed by schema, so a reload invalidates them.                                                                        |
| **HMAC signing, header propagation, retries, timeouts** | Unaffected; the plugin observes `onFetch` rather than replacing the fetch.                                                                           |

Subgraph `extensions` are **never** relayed. The gateway discards them today,
and this plugin preserves that — only `data` and the gateway's own extensions
are written.

## The `@passthrough` directive and its checks

A subgraph can carry its own pass-through policy by declaring, importing (via
`@link` from `https://the-guild.dev/mesh/v1.0`) and composing (via
`@composeDirective`) a schema-level directive:

```graphql
directive @passthrough(check: [PassthroughCheck!]) on SCHEMA | OBJECT

enum PassthroughCheck {
  JSON
  LEAF_VALUES
  EXACT_FIELDS
}
```

The default — a bare `@passthrough`, or no directive plus an empty `checks`
option — is **maximum performance**: the gateway relays the subgraph's bytes
trusting it for both values and JSON validity. Each named check adds one
specific verification back, at a cost:

| Check          | What it buys back                                                                                                                                                                                                         | What it costs                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `JSON`         | The scanner validates string escapes, number grammar, literals and UTF-8, refusing everything `JSON.parse` refuses. Without it only the JSON _structure_ is checked and content-level malformations are relayed verbatim. | ~27% of the scan                         |
| `LEAF_VALUES`  | Declines selections reaching a custom scalar or an enum with `@inaccessible` values — the leaves the normal path would have coerced.                                                                                      | Coverage: those operations relay no more |
| `EXACT_FIELDS` | Declines a relay whose outgoing document gained an unaliased `__typename` the client did not ask for. Without it that one extra key may reach the client.                                                                 | Coverage                                 |

Regardless of `EXACT_FIELDS`, **any other added key always declines** — an
aliased `__typename` such as the response cache's `__responseCacheTypeName`
included.

For subgraphs that carry no directive, the plugin's `checks` option supplies
the fallback; a subgraph's own directive always wins over that list.

## Options

| Option          | Type                              | Default | Meaning                                                                              |
| --------------- | --------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `enabled`       | `boolean \| (payload) => boolean` | `true`  | Whether pass-through may be attempted. A predicate is consulted once per root field. |
| `minBytes`      | `number`                          | `0`     | Responses smaller than this take the normal path.                                    |
| `checks`        | `PassthroughCheck[]`              | `[]`    | Checks for subgraphs without a `@passthrough` directive of their own.                |
| `onSkip`        | `(reason, info) => void`          | —       | Called when pass-through was declined.                                               |
| `onPassthrough` | `(info) => void`                  | —       | Called when a response was relayed.                                                  |

The `enabled` predicate receives `{ subgraphName, typeName, fieldName,
operationName }` and must return exactly `true` to allow. Every root field must
be allowed: relaying replaces the whole response, so it cannot be applied to
part of an operation.

There is one gate rather than a list of subgraphs and a list of fields, because
a predicate covers both polarities and has nothing to keep in sync:

```ts
enabled: false; // off
enabled: ({ subgraphName }) => subgraphName === 'products'; // one subgraph
enabled: ({ fieldName }) => fieldName === 'orders'; // staged rollout
enabled: ({ fieldName }) => fieldName !== 'brokenThing'; // exclude one field
```

An allow-list in configuration would age badly: a root field added later would
silently never be relayed, and the only symptom is a slower response.

## Finding out whether it is working

`onPassthrough` fires for every relayed response; `onSkip` fires with a reason
for every declined one. Counting reasons is the fastest way to discover why a
query you expected to be fast is not:

```ts
useResponsePassthrough({
  onSkip(reason, { operationName }) {
    metrics.increment('passthrough.skipped', { reason, operationName });
  },
  onPassthrough({ operationName, bytes }) {
    metrics.increment('passthrough.relayed', { operationName });
    metrics.histogram('passthrough.bytes', bytes);
  },
});
```

### Skip reasons

Decided before the subgraph is called:

| Reason                            | Meaning                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `not-a-query`                     | A mutation or subscription.                                                  |
| `multiple-operations`             | The document holds more than one operation.                                  |
| `incremental-delivery`            | `@defer` or `@stream` present.                                               |
| `no-root-fields`                  | Nothing to relay.                                                            |
| `root-field-not-owned`            | No single subgraph declares the root field, or it is introspection.          |
| `root-fields-span-subgraphs`      | Root fields belong to different subgraphs.                                   |
| `not-enabled-by-config`           | Your `enabled` predicate returned false.                                     |
| `abstract-type-in-selection`      | An interface or union appears in the selection.                              |
| `fields-missing-from-subgraph`    | The subgraph cannot answer part of the selection.                            |
| `merged-type-dependency`          | A type in the selection carries `@requires` / `@provides` / computed fields. |
| `custom-scalar-serializer`        | Under `LEAF_VALUES`; see _Leaf values are not coerced_.                      |
| `inaccessible-enum-value`         | Under `LEAF_VALUES`; see _Leaf values are not coerced_.                      |
| `subschema-transforms`            | The subgraph has request/result transforms configured.                       |
| `dynamic-selection-set`           | A field has a dynamic selection set.                                         |
| `gateway-side-resolver`           | A field is resolved by the gateway, not the subgraph.                        |
| `client-does-not-accept-json`     | The client asked for a media type this cannot produce.                       |
| `batched-request`                 | The HTTP body was a JSON array (even with a single element).                 |
| `multiple-operations-per-request` | One HTTP request carrying several operations.                                |

Decided from the outgoing request or the subgraph's response — these are also
what you will see when another plugin rewrites the document:

| Reason                                                    | Meaning                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subgraph document adds "X" at Y`                         | A plugin injected a field the client did not request.                                                                                             |
| `subgraph document drops "X" at Y`                        | The outgoing document no longer covers the selection.                                                                                             |
| `partial-subgraph-request`                                | This request is not the whole answer.                                                                                                             |
| `multiple-subgraph-responses`                             | More than one subgraph replied.                                                                                                                   |
| `unexpected-subgraph`                                     | A subgraph the verdict did not account for replied.                                                                                               |
| `errors-present`                                          | The response carries `errors`; they need the normal error path.                                                                                   |
| `non-json-response`                                       | SSE or multipart.                                                                                                                                 |
| `encoded-response`                                        | The body is compressed.                                                                                                                           |
| `unscannable-response`                                    | The body is not a JSON object this can read.                                                                                                      |
| `data-not-object`                                         | `data` is null or not an object.                                                                                                                  |
| `root-keys-mismatch`                                      | The response's root keys are not the ones expected.                                                                                               |
| `below-min-bytes`                                         | Smaller than `minBytes`.                                                                                                                          |
| `document-rewritten`                                      | The document changed between the verdict and execution.                                                                                           |
| `stub-not-synthesizable` (incl. a non-null custom scalar) | No error-free placeholder exists for this selection; declined before committing.                                                                  |
| `result-has-errors`                                       | A real error was attached to the result; real data is restored and the ordinary path serializes it.                                               |
| `result-not-a-single-result`                              | A post-execution plugin replaced the result with something the relay cannot represent.                                                            |
| `stub-result-shared`                                      | The result reaching serialization was another request's stub (inbound request deduplication); answered with an explicit 500, never with the stub. |
| `incomplete-verdict`                                      | Internal: the verdict lacked what the writer needs.                                                                                               |

## When not to use this

- Your responses are small. Below a few tens of kilobytes there is nothing to
  recover, and the plugin adds a scan.
- Most of your traffic spans subgraphs. Those operations are declined, so the
  ceiling is set by how much of your traffic is genuinely single-subgraph.
- Your responses are served from the response cache. A cache hit already skips
  execution and parsing; this plugin cannot improve on that, and is declined
  when caching is active anyway.
- You depend on the gateway coercing leaf values from a subgraph you do not
  control. The declines above cover the cases that can be detected statically,
  not a subgraph that returns values contradicting its own schema.

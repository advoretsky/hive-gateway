import type {
  GatewayContext,
  GatewayPlugin,
  LogLevel,
} from '@graphql-hive/gateway-runtime';
import {
  getOperationAST,
  isInputObjectType,
  isInputType,
  isListType,
  isNonNullType,
  isScalarType,
  typeFromAST,
  type ExecutionArgs,
  type GraphQLInputObjectType,
  type GraphQLInputType,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';

/**
 * Matches an exact, plain decimal representation of an integer.
 *
 * Deliberately stricter than `Number`: no surrounding whitespace, no exponent
 * notation, no decimal point and no leading `+`. `"42"` coerces, `" 42 "`,
 * `"1e3"`, `"42.0"` and `"+42"` do not and keep failing as they do today.
 */
const INTEGER_STRING = /^-?\d+$/;

/** A single string value that was coerced to `Int`. */
export interface IntCoercion {
  /** Where the value sat, e.g. `$first`, `$filter.paging.first` or `$ids[2]`. */
  path: string;
  /** The string the client sent. */
  from: string;
  /** The integer it was coerced to. */
  to: number;
}

export interface CoerceIntFromStringOptions {
  /**
   * Level to log coercions at.
   *
   * @default 'warn'
   */
  level?: LogLevel;
}

/** The variables of an operation that are worth walking, and their types. */
type CoercionPlan = { name: string; type: GraphQLInputType }[];

function containsInt(
  type: GraphQLInputType,
  visited: Set<GraphQLInputObjectType>,
): boolean {
  if (isNonNullType(type) || isListType(type)) {
    return containsInt(type.ofType, visited);
  }
  if (isInputObjectType(type)) {
    // Input types may reference themselves. Revisiting a type cannot find an
    // Int the first visit missed, so stopping here is safe.
    if (visited.has(type)) {
      return false;
    }
    visited.add(type);
    return Object.values(type.getFields()).some((field) =>
      containsInt(field.type, visited),
    );
  }
  return isScalarType(type) && type.name === 'Int';
}

/**
 * Most operations cannot contain an `Int` anywhere in their variables, and for
 * those the plugin should cost nothing. Resolving that is pure schema work, so
 * it is done once per operation rather than once per request — Yoga caches
 * parsed documents, which keeps the operation node identity stable.
 */
const plans = new WeakMap<
  GraphQLSchema,
  WeakMap<OperationDefinitionNode, CoercionPlan>
>();

function getCoercionPlan(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
): CoercionPlan {
  let byOperation = plans.get(schema);
  if (!byOperation) {
    byOperation = new WeakMap();
    plans.set(schema, byOperation);
  }
  let plan = byOperation.get(operation);
  if (!plan) {
    plan = [];
    for (const definition of operation.variableDefinitions || []) {
      const type = typeFromAST(schema, definition.type);
      if (type && isInputType(type) && containsInt(type, new Set())) {
        plan.push({ name: definition.variable.name.value, type });
      }
    }
    byOperation.set(operation, plan);
  }
  return plan;
}

/**
 * Walks `value` against `type`, replacing integer-like strings sitting at `Int`
 * positions with actual numbers.
 *
 * Copies on write: subtrees that did not change are returned by reference, so a
 * request that coerces nothing allocates nothing. Callers rely on that identity
 * to detect whether anything happened.
 */
function coerceValue(
  value: unknown,
  type: GraphQLInputType,
  path: string,
  coercions: IntCoercion[],
): unknown {
  if (isNonNullType(type)) {
    return coerceValue(value, type.ofType, path, coercions);
  }

  if (value == null) {
    return value;
  }

  if (isListType(type)) {
    // GraphQL coerces a non-list value into a list of one, so a bare value is
    // still checked against the item type.
    if (!Array.isArray(value)) {
      return coerceValue(value, type.ofType, path, coercions);
    }
    let items = value;
    for (let i = 0; i < value.length; i++) {
      const coerced = coerceValue(
        value[i],
        type.ofType,
        `${path}[${i}]`,
        coercions,
      );
      if (coerced !== value[i]) {
        if (items === value) {
          items = value.slice();
        }
        items[i] = coerced;
      }
    }
    return items;
  }

  if (isInputObjectType(type)) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      // Not a valid input object, leave it for GraphQL to report.
      return value;
    }
    const source = value as Record<string, unknown>;
    const fields = type.getFields();
    let obj = source;
    for (const key of Object.keys(source)) {
      const field = fields[key];
      // Unknown fields are left alone, GraphQL rejects them itself.
      if (!field) {
        continue;
      }
      const coerced = coerceValue(
        source[key],
        field.type,
        `${path}.${key}`,
        coercions,
      );
      if (coerced !== source[key]) {
        if (obj === source) {
          obj = { ...source };
        }
        obj[key] = coerced;
      }
    }
    return obj;
  }

  if (
    isScalarType(type) &&
    type.name === 'Int' &&
    typeof value === 'string' &&
    INTEGER_STRING.test(value)
  ) {
    const int = Number(value);
    // Anything outside the safe range does not round trip. Leave it a string so
    // GraphQL reports it instead of us silently handing over a wrong number.
    if (Number.isSafeInteger(int)) {
      coercions.push({ path, from: value, to: int });
      return int;
    }
  }

  return value;
}

/**
 * Accepts integer values sent as strings in request **variables** and coerces
 * them to `Int`, logging every coercion so offending clients can be found and
 * fixed.
 *
 * Only exact integer strings are coerced (`"42"`, `"-7"`). Everything GraphQL
 * already rejects — `"42.5"`, `"abc"`, `""`, `"1e3"`, `" 42 "`, booleans — keeps
 * being rejected, with the same error as before.
 *
 * This is a migration aid, not a permanent relaxation. It covers variables only:
 * inline literals (`field(first: "10")`) are rejected during validation, before
 * any plugin hook runs, so they are out of reach here.
 *
 * Deliberately self-contained: it imports nothing but `graphql` and types from
 * the gateway's public entrypoint, and nothing in the gateway imports it. Copy
 * this single file next to your `gateway.config.ts` and register it there:
 *
 * ```ts
 * import { defineConfig } from '@graphql-hive/gateway';
 * import { useCoerceIntFromString } from './useCoerceIntFromString';
 *
 * export const gatewayConfig = defineConfig({
 *   plugins: () => [useCoerceIntFromString()],
 * });
 * ```
 *
 * Delete the file when the offending clients are fixed.
 */
export function useCoerceIntFromString<TContext extends Record<string, any>>({
  level = 'warn',
}: CoerceIntFromStringOptions = {}): GatewayPlugin<TContext> {
  function handle(args: ExecutionArgs) {
    const { variableValues } = args;
    if (!variableValues) {
      return;
    }

    const operation = getOperationAST(args.document, args.operationName);
    if (!operation) {
      return;
    }
    const plan = getCoercionPlan(args.schema, operation);
    if (!plan.length) {
      return;
    }

    const coercions: IntCoercion[] = [];
    let variables = variableValues;
    for (const { name, type } of plan) {
      if (!(name in variableValues)) {
        continue;
      }
      const value = variableValues[name];
      const coerced = coerceValue(value, type, `$${name}`, coercions);
      if (coerced !== value) {
        if (variables === variableValues) {
          variables = { ...variableValues };
        }
        (variables as Record<string, unknown>)[name] = coerced;
      }
    }
    if (variables === variableValues) {
      return;
    }

    args.variableValues = variables;

    const context = args.contextValue as Partial<GatewayContext> | undefined;
    const headers = context?.headers;
    context?.log?.[level](
      {
        // Prefer the name in the document: clients are not required to send
        // `operationName`, but triage needs the operation identified.
        operationName: operation.name?.value ?? args.operationName ?? undefined,
        clientName:
          headers?.['graphql-client-name'] ||
          headers?.['x-graphql-client-name'],
        clientVersion:
          headers?.['graphql-client-version'] ||
          headers?.['x-graphql-client-version'],
        coercions,
      },
      'Coerced %s String variable value(s) to Int. The client should send Int values, not strings.',
      coercions.length,
    );
  }

  return {
    onExecute({ args }) {
      handle(args);
    },
    onSubscribe({ args }) {
      handle(args);
    },
  };
}

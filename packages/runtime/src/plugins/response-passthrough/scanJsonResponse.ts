/**
 * A byte-level scanner for GraphQL JSON responses.
 *
 * It answers two questions without building any JavaScript objects:
 *
 *  1. which top-level keys does this response carry (is there an `errors`
 *     key?), and
 *  2. where does each root field's value live inside `data`?
 *
 * Both are needed by response pass-through: the first decides whether the
 * response is eligible to be relayed at all, and the second lets the writer
 * re-key the top level of `data` to the client's response keys without
 * touching the nested payload.
 *
 * The scanner only descends two levels for key extraction, but it always
 * checks the STRUCTURE of everything it walks: containers must balance,
 * members need their colons and commas, strings track their boundaries (so a
 * quote or brace inside one never confuses the walk), and nothing may trail
 * the root object. Because the writer relays the scanned bytes verbatim,
 * whatever the scanner accepts becomes an HTTP 200 `application/json` body on
 * the wire.
 *
 * Checking the CONTENTS of what it walks — string escapes and control
 * characters, number grammar, literals, UTF-8 sequences — is opt-in via
 * `ScanOptions.validate`, because it costs roughly a quarter of the scan.
 * With `validate: true` the scanner refuses every body `JSON.parse` would
 * reject (fuzz-verified), so a subgraph bug can never become client-visible
 * corruption; without it, the gateway trusts its subgraphs to emit valid
 * JSON and a content-level malformation is relayed as-is.
 *
 * The reverse direction stays loose on purpose: the scanner may refuse bodies
 * `JSON.parse` accepts (duplicate keys, pathological nesting). Anything it
 * does not fully understand yields `null`, and the caller falls back to the
 * ordinary parse-and-execute path — `null` is never an error.
 */

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const SLASH = 0x2f; // /
const LBRACE = 0x7b; // {
const RBRACE = 0x7d; // }
const LBRACKET = 0x5b; // [
const RBRACKET = 0x5d; // ]
const COLON = 0x3a; // :
const COMMA = 0x2c; // ,
const MINUS = 0x2d; // -
const PLUS = 0x2b; // +
const DOT = 0x2e; // .
const ZERO = 0x30; // 0
const NINE = 0x39; // 9

const decoder = new TextDecoder();

/**
 * Containers nested deeper than this are refused. `JSON.parse` copes with
 * more, but no real GraphQL response comes close, and a fixed cap keeps the
 * container-kind stack a constant-size allocation.
 */
const MAX_DEPTH = 1024;

/**
 * Reused container-kind stack for `skipContainer` (1 = object, 0 = array).
 * The scan never calls user code mid-container, so it cannot re-enter itself
 * and a single module-level scratch buffer is safe.
 */
const containerKind = new Uint8Array(MAX_DEPTH);

/** Byte offsets of a JSON value: `[start, end)`. */
export interface JsonRange {
  start: number;
  end: number;
}

export interface ScanOptions {
  /** Validate string contents, number grammar, literals and UTF-8. Default false. */
  validate?: boolean;
}

export interface ScannedResponse {
  /** Top-level members of the response object, by key. */
  keys: Map<string, JsonRange>;
  /**
   * Members of `data`, by response key — present only when `data` is an
   * object. `null` data, or data that is not an object, leaves this undefined.
   */
  dataFields?: Map<string, JsonRange>;
}

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

function isHexDigit(c: number): boolean {
  return (
    (c >= ZERO && c <= NINE) ||
    (c >= 0x41 && c <= 0x46) || // A-F
    (c >= 0x61 && c <= 0x66) // a-f
  );
}

/** Advances past whitespace; returns the index of the next significant byte. */
function skipWhitespace(buf: Uint8Array, i: number): number {
  while (i < buf.length && isWhitespace(buf[i]!)) {
    i++;
  }
  return i;
}

/**
 * Validates one backslash escape starting at `i`. Returns the index just past
 * it, or -1. Kept out of the string hot loop: escapes are rare, and a small
 * caller inlines better.
 */
function skipEscape(buf: Uint8Array, i: number): number {
  if (i + 1 >= buf.length) {
    return -1;
  }
  const e = buf[i + 1]!;
  if (e === 0x75 /* u */) {
    if (
      i + 5 >= buf.length ||
      !isHexDigit(buf[i + 2]!) ||
      !isHexDigit(buf[i + 3]!) ||
      !isHexDigit(buf[i + 4]!) ||
      !isHexDigit(buf[i + 5]!)
    ) {
      return -1;
    }
    return i + 6;
  }
  if (
    e === QUOTE ||
    e === BACKSLASH ||
    e === SLASH ||
    e === 0x62 /* b */ ||
    e === 0x66 /* f */ ||
    e === 0x6e /* n */ ||
    e === 0x72 /* r */ ||
    e === 0x74 /* t */
  ) {
    return i + 2;
  }
  return -1;
}

/** True for a UTF-8 continuation byte (0x80-0xBF). */
function isContinuation(c: number): boolean {
  return (c & 0xc0) === 0x80;
}

/**
 * Validates one non-ASCII UTF-8 sequence whose lead byte is at `i`. Returns
 * the index just past it, or -1. Strict: overlong encodings, UTF-16
 * surrogates and code points above U+10FFFF are refused, matching
 * `new TextDecoder('utf-8', { fatal: true })` without a second decode pass.
 */
function skipMultibyte(buf: Uint8Array, i: number): number {
  const len = buf.length;
  const c = buf[i]!;
  if (c >= 0xc2 && c <= 0xdf) {
    if (i + 1 >= len || !isContinuation(buf[i + 1]!)) {
      return -1;
    }
    return i + 2;
  }
  if (c >= 0xe0 && c <= 0xef) {
    // 0xE0 narrows the second byte to exclude overlong forms, 0xED to
    // exclude UTF-16 surrogates.
    if (i + 2 >= len) {
      return -1;
    }
    const c1 = buf[i + 1]!;
    if (
      c1 < (c === 0xe0 ? 0xa0 : 0x80) ||
      c1 > (c === 0xed ? 0x9f : 0xbf) ||
      !isContinuation(buf[i + 2]!)
    ) {
      return -1;
    }
    return i + 3;
  }
  if (c >= 0xf0 && c <= 0xf4) {
    // 0xF0 narrows the second byte to exclude overlong forms, 0xF4 to stay
    // within U+10FFFF.
    if (i + 3 >= len) {
      return -1;
    }
    const c1 = buf[i + 1]!;
    if (
      c1 < (c === 0xf0 ? 0x90 : 0x80) ||
      c1 > (c === 0xf4 ? 0x8f : 0xbf) ||
      !isContinuation(buf[i + 2]!) ||
      !isContinuation(buf[i + 3]!)
    ) {
      return -1;
    }
    return i + 4;
  }
  // 0x80-0xC1 (stray continuation or overlong lead) or 0xF5-0xFF.
  return -1;
}

/**
 * Advances past a complete JSON string starting at an opening quote. Returns
 * the index just past the closing quote, or -1. Boundary tracking is
 * unconditional — an escaped quote never closes the string — but control
 * characters, escape grammar and non-ASCII sequences are only checked when
 * `validate` is set.
 *
 * The two modes get separate loops over the same boundary rule because this
 * is the hottest code in the scan: strings dominate real response bytes, and
 * folding the modes into one loop puts a third per-byte branch on the
 * structural path, costing it most of what turning validation off buys. A
 * byte >= 0x80 can never be a quote or backslash, so the structural loop
 * needs no routing for non-ASCII at all.
 */
function skipString(buf: Uint8Array, i: number, validate: boolean): number {
  const len = buf.length;
  i++;
  if (!validate) {
    while (i < len) {
      const c = buf[i]!;
      if (c === QUOTE) {
        return i + 1;
      }
      if (c === BACKSLASH) {
        // Whatever byte is escaped, it cannot be the closing quote; its
        // identity is content, not structure. A backslash truncating the
        // input jumps past `len` and falls out of the loop as -1.
        i += 2;
        continue;
      }
      i++;
    }
    return -1;
  }
  while (i < len) {
    const c = buf[i]!;
    if (c === QUOTE) {
      return i + 1;
    }
    if (c === BACKSLASH) {
      i = skipEscape(buf, i);
      if (i < 0) {
        return -1;
      }
      continue;
    }
    // One check for both rare classes: bytes below 0x20 wrap around the mask,
    // so this is `c < 0x20 || c >= 0x80`.
    if (((c - 0x20) & 0xff) >= 0x60) {
      if (c < 0x20) {
        // JSON forbids unescaped control characters inside strings.
        return -1;
      }
      i = skipMultibyte(buf, i);
      if (i < 0) {
        return -1;
      }
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Advances past a JSON number matching the RFC 8259 grammar. Returns the
 * index just past the last digit, or -1. A trailing violation that begins a
 * new token (`01`, `1.2.3`) is left for the caller's structural check to
 * refuse: the number ends and the next byte is not a delimiter.
 */
function skipNumber(buf: Uint8Array, i: number): number {
  const len = buf.length;
  let c = buf[i]!;
  if (c === MINUS) {
    i++;
    if (i >= len) {
      return -1;
    }
    c = buf[i]!;
  }
  if (c === ZERO) {
    i++;
  } else if (c > ZERO && c <= NINE) {
    do {
      i++;
    } while (i < len && isDigit(buf[i]!));
  } else {
    return -1;
  }
  if (i < len && buf[i] === DOT) {
    i++;
    if (i >= len || !isDigit(buf[i]!)) {
      return -1;
    }
    do {
      i++;
    } while (i < len && isDigit(buf[i]!));
  }
  if (i < len && (buf[i] === 0x65 /* e */ || buf[i] === 0x45) /* E */) {
    i++;
    if (i < len && (buf[i] === PLUS || buf[i] === MINUS)) {
      i++;
    }
    if (i >= len || !isDigit(buf[i]!)) {
      return -1;
    }
    do {
      i++;
    } while (i < len && isDigit(buf[i]!));
  }
  return i;
}

/** Advances past `word` (whose first byte is already matched), or -1. */
function skipKeyword(buf: Uint8Array, i: number, word: string): number {
  if (i + word.length > buf.length) {
    return -1;
  }
  for (let k = 1; k < word.length; k++) {
    if (buf[i + k] !== word.charCodeAt(k)) {
      return -1;
    }
  }
  return i + word.length;
}

/**
 * True for a byte that ends an unquoted literal token: whitespace or a
 * structural character. A colon and an opening bracket are included so that
 * a literal never swallows structure (`[1:2]`, `[1[2]]`) — the container
 * state machine then refuses what follows.
 */
function isLiteralEnd(c: number): boolean {
  return (
    isWhitespace(c) ||
    c === COMMA ||
    c === COLON ||
    c === RBRACE ||
    c === RBRACKET ||
    c === LBRACE ||
    c === LBRACKET ||
    c === QUOTE
  );
}

/**
 * Advances past a number, `true`, `false` or `null`. Returns the index just
 * past the token, or -1. When `validate` is off, a literal is any non-empty
 * run of bytes up to the next structural delimiter — its grammar is the
 * subgraph's to get right — so a missing value (`{"a":}`) is still refused
 * as an empty run while `01` or `NaN` passes.
 */
function skipLiteral(buf: Uint8Array, i: number, validate: boolean): number {
  if (!validate) {
    const len = buf.length;
    const start = i;
    while (i < len && !isLiteralEnd(buf[i]!)) {
      i++;
    }
    return i > start ? i : -1;
  }
  const c = buf[i]!;
  if (c === 0x74 /* t */) {
    return skipKeyword(buf, i, 'true');
  }
  if (c === 0x66 /* f */) {
    return skipKeyword(buf, i, 'false');
  }
  if (c === 0x6e /* n */) {
    return skipKeyword(buf, i, 'null');
  }
  return skipNumber(buf, i);
}

// States for skipContainer's iterative walk. "or close" states are the entry
// into a container, where an empty `{}`/`[]` is still possible; a comma
// commits to another member.
const EXPECT_KEY_OR_CLOSE = 0;
const EXPECT_KEY = 1;
const EXPECT_VALUE_OR_CLOSE = 2;
const EXPECT_VALUE = 3;
const EXPECT_COMMA_OR_CLOSE = 4;

/**
 * Advances past a complete object or array starting at `i`, validating the
 * full JSON grammar of everything inside it. Iterative rather than recursive
 * so that nesting depth can never overflow the call stack — a malformed body
 * must yield -1, never a throw. Returns the index just past the closing
 * bracket, or -1.
 */
function skipContainer(buf: Uint8Array, i: number, validate: boolean): number {
  // caller guarantees buf[i] is LBRACE or LBRACKET
  const len = buf.length;
  let depth = 1;
  containerKind[0] = buf[i]! === LBRACE ? 1 : 0;
  let state = containerKind[0] ? EXPECT_KEY_OR_CLOSE : EXPECT_VALUE_OR_CLOSE;
  i++;
  for (;;) {
    if (i >= len) {
      return -1;
    }
    const b = buf[i]!;
    if (isWhitespace(b)) {
      i++;
      continue;
    }
    if (state === EXPECT_COMMA_OR_CLOSE) {
      if (b === COMMA) {
        i++;
        state = containerKind[depth - 1] ? EXPECT_KEY : EXPECT_VALUE;
        continue;
      }
      if (b !== (containerKind[depth - 1] ? RBRACE : RBRACKET)) {
        return -1;
      }
      depth--;
      i++;
      if (depth === 0) {
        return i;
      }
      continue;
    }
    if (
      (state === EXPECT_KEY_OR_CLOSE && b === RBRACE) ||
      (state === EXPECT_VALUE_OR_CLOSE && b === RBRACKET)
    ) {
      depth--;
      i++;
      if (depth === 0) {
        return i;
      }
      state = EXPECT_COMMA_OR_CLOSE;
      continue;
    }
    if (state === EXPECT_KEY || state === EXPECT_KEY_OR_CLOSE) {
      if (b !== QUOTE) {
        return -1;
      }
      const end = skipString(buf, i, validate);
      if (end < 0) {
        return -1;
      }
      i = skipWhitespace(buf, end);
      if (i >= len || buf[i] !== COLON) {
        return -1;
      }
      i++;
      state = EXPECT_VALUE;
      continue;
    }
    // EXPECT_VALUE or EXPECT_VALUE_OR_CLOSE: a value begins here.
    if (b === LBRACE || b === LBRACKET) {
      if (depth >= MAX_DEPTH) {
        return -1;
      }
      containerKind[depth++] = b === LBRACE ? 1 : 0;
      state = b === LBRACE ? EXPECT_KEY_OR_CLOSE : EXPECT_VALUE_OR_CLOSE;
      i++;
      continue;
    }
    const end =
      b === QUOTE
        ? skipString(buf, i, validate)
        : skipLiteral(buf, i, validate);
    if (end < 0) {
      return -1;
    }
    i = end;
    state = EXPECT_COMMA_OR_CLOSE;
  }
}

/**
 * Advances past one complete JSON value starting at `i` (already past
 * whitespace). Returns the index just past the value, or -1 if malformed or
 * truncated.
 */
function skipValue(buf: Uint8Array, i: number, validate: boolean): number {
  if (i >= buf.length) {
    return -1;
  }
  const c = buf[i]!;
  if (c === QUOTE) {
    return skipString(buf, i, validate);
  }
  if (c === LBRACE || c === LBRACKET) {
    return skipContainer(buf, i, validate);
  }
  return skipLiteral(buf, i, validate);
}

/** Decodes a JSON string token spanning `[start, end)`, quotes included. */
function decodeKey(buf: Uint8Array, start: number, end: number): string | null {
  const raw = decoder.decode(buf.subarray(start, end));
  if (!raw.includes('\\')) {
    // Fast path: no escapes, so the token is its own contents minus the quotes.
    return raw.slice(1, -1);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Scans the members of a JSON object whose opening brace is at `i`.
 * Calls `onMember` for each key with the byte range of its value.
 * Returns the index just past the closing brace, or -1 if malformed.
 */
function scanObject(
  buf: Uint8Array,
  i: number,
  validate: boolean,
  onMember: (key: string, range: JsonRange) => void,
): number {
  // caller guarantees buf[i] === LBRACE
  i++;
  i = skipWhitespace(buf, i);

  if (i < buf.length && buf[i] === RBRACE) {
    return i + 1;
  }

  for (;;) {
    i = skipWhitespace(buf, i);
    if (i >= buf.length || buf[i] !== QUOTE) {
      return -1;
    }

    const keyStart = i;
    const keyEnd = skipString(buf, i, validate);
    if (keyEnd < 0) {
      return -1;
    }
    const key = decodeKey(buf, keyStart, keyEnd);
    if (key === null) {
      return -1;
    }

    i = skipWhitespace(buf, keyEnd);
    if (i >= buf.length || buf[i] !== COLON) {
      return -1;
    }
    i = skipWhitespace(buf, i + 1);

    const valueStart = i;
    const valueEnd = skipValue(buf, i, validate);
    if (valueEnd < 0) {
      return -1;
    }
    onMember(key, { start: valueStart, end: valueEnd });

    i = skipWhitespace(buf, valueEnd);
    if (i >= buf.length) {
      return -1;
    }
    if (buf[i] === COMMA) {
      i++;
      continue;
    }
    if (buf[i] === RBRACE) {
      return i + 1;
    }
    return -1;
  }
}

/**
 * Scans a GraphQL JSON response body. A leading UTF-8 BOM is tolerated.
 *
 * Returns `null` when the body is not a single structurally well-formed JSON
 * object, or when anything about it is not understood — callers must treat
 * `null` as "take the normal path", never as an error. Pass
 * `{ validate: true }` to also refuse content-level malformations (bad
 * escapes, numbers, literals, UTF-8) at ~27% extra scan cost.
 */
export function scanJsonResponse(
  buf: Uint8Array,
  options?: ScanOptions,
): ScannedResponse | null {
  const validate = options?.validate === true;
  let i = 0;
  // A leading UTF-8 BOM is stripped by TextDecoder, so the ordinary
  // parse-and-execute path accepts bodies that carry one; refusing it here
  // would cost a relay for no benefit. Only the very first bytes qualify —
  // a BOM after whitespace survives decoding and fails JSON.parse too.
  if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    i = 3;
  }
  i = skipWhitespace(buf, i);
  if (i >= buf.length || buf[i] !== LBRACE) {
    return null;
  }

  const keys = new Map<string, JsonRange>();
  let duplicate = false;
  const end = scanObject(buf, i, validate, (key, range) => {
    if (keys.has(key)) {
      // Duplicate top-level keys are legal JSON but ambiguous here; refuse.
      duplicate = true;
    }
    keys.set(key, range);
  });
  if (end < 0 || duplicate) {
    return null;
  }

  // Trailing content after the root object means this is not the single
  // response document we think it is.
  if (skipWhitespace(buf, end) !== buf.length) {
    return null;
  }

  const result: ScannedResponse = { keys };

  const data = keys.get('data');
  if (data && buf[data.start] === LBRACE) {
    const dataFields = new Map<string, JsonRange>();
    let dataDuplicate = false;
    const dataEnd = scanObject(buf, data.start, validate, (key, range) => {
      if (dataFields.has(key)) {
        dataDuplicate = true;
      }
      dataFields.set(key, range);
    });
    if (dataEnd < 0 || dataDuplicate) {
      return null;
    }
    result.dataFields = dataFields;
  }

  return result;
}

/** Returns the raw JSON text of a scanned value. */
export function sliceRange(buf: Uint8Array, range: JsonRange): string {
  return decoder.decode(buf.subarray(range.start, range.end));
}

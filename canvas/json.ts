// Convert a live in-memory value into a strict JSON document.
//
// Why this is necessary: the plugin RPC boundary validates that every payload
// is a real JSON value and rejects anything else with "... is not a JSON
// value". Excalidraw element objects are NOT JSON documents as they exist in
// memory — they are plain objects that routinely carry values JSON cannot
// express:
//
//   * `customData` is typed `Record<string, any>` and holds `undefined` for
//     keys the app has not set. That value survives to the server validator,
//     which correctly rejects the whole scene.
//   * `NaN` / `Infinity` can appear in geometry and are not JSON numbers.
//   * `Date`, `Map`, `Set`, class instances and functions have no JSON form.
//
// `JSON.parse(JSON.stringify(x))` is NOT a safe fallback: it throws on BigInt
// and on cyclic references, which would break the save outright rather than
// degrade. This walk instead rebuilds the value using JavaScript's own
// serialization rules, and never throws:
//
//   * `undefined` / function / symbol in an object -> key dropped
//   * the same in an array                         -> null (indices preserved)
//   * `NaN` / `Infinity` / `-Infinity`             -> null
//   * BigInt                                       -> decimal string
//   * a cyclic branch                              -> dropped
//
// Excalidraw's loader tolerates missing optional fields, so dropping an
// unrepresentable `customData` key is safe; the drawing is unaffected.
//
// Exported for tests: the cycle, BigInt, and array-hole paths regress easily.
export function toJsonValue(value: unknown): unknown {
  return sanitize(value, []);
}

/** Values `JSON.stringify` would omit from an object entirely. */
function isUnrepresentable(value: unknown): boolean {
  const kind = typeof value;
  return kind === "undefined" || kind === "function" || kind === "symbol";
}

/**
 * @param stack Objects on the current path, used to detect true cycles. A
 * value that appears twice in sibling branches is shared, not cyclic, and is
 * serialized twice — only re-entering an ancestor is a cycle.
 */
function sanitize(value: unknown, stack: object[]): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // JSON has no NaN/Infinity; `null` is what JSON.stringify produces too.
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  const object = value as object;
  if (stack.includes(object)) return undefined;

  stack.push(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => {
        const next = sanitize(item, stack);
        // `undefined` (a hole, or a cycle) becomes null so indices align.
        return next === undefined ? null : next;
      });
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (isUnrepresentable(item)) continue;
      const next = sanitize(item, stack);
      if (next !== undefined) out[key] = next;
    }
    return out;
  } finally {
    stack.pop();
  }
}

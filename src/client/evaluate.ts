// Works out the live value of a simple expression as written in the source (a hook's argument),
// from values the panel already knows by name. It never runs the app's code: it understands
// literals, names and property paths, array and object literals and template strings, and shows
// functions as functions. Anything else (a call, arithmetic, an unknown name) is kept as the code
// itself, shown muted, so a value is never guessed.

/** Placeholder for code that couldn't be worked out; value.ts shows it as the code, muted. */
export const code = (text: string) => `[Code ${text.trim()}]`;
const FUNCTION = "[Function anonymous]";

export interface Evaluated {
  value: unknown;
  /** Whether any part of it was worked out (a literal, or a known value). */
  resolved: boolean;
}

/** `known`: values by name (props, state, refs, memos, context, names taken from hooks), already serialized. */
export function evaluate(text: string, known: Map<string, unknown>): Evaluated {
  const src = text.trim();
  let i = 0;
  let resolved = false;

  class Bail extends Error {}
  const bail = (): never => {
    throw new Bail();
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = () => src[i];
  const eat = (c: string) => {
    ws();
    if (src[i] !== c) bail();
    i++;
  };

  /** Moves past a string or template starting at `i` (its quote), including `${…}` inside templates. */
  const skipString = () => {
    const quote = src[i++];
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") i += 2;
      else if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        skipTo("}");
        i++;
      } else i++;
    }
    i++;
  };
  /** Moves to the end of the current expression: the next `,` or closing bracket at this level (or `stop`). */
  const skipTo = (stop = "") => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        skipString();
        continue;
      }
      if (depth === 0 && (c === stop || (!stop && ",)]}".includes(c)))) return;
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      i++;
    }
  };

  const expression = (): unknown => {
    ws();
    const start = i;
    // Functions have no value to show: `() => …`, `(a, b) => …`, `x => …`, `function …`.
    if (/^(async\s+)?(\([^()]*\)|[\w$]+)\s*=>|^(async\s+)?function\b/.test(src.slice(i))) {
      skipTo();
      return FUNCTION;
    }
    const resolvedBefore = resolved;
    try {
      const value = primary();
      ws();
      // An operator follows (`a + b`, `x ? y : z`, `a && b`): more than a value, so kept as code.
      if (i < src.length && !",)]}".includes(peek())) bail();
      return value;
    } catch (e) {
      if (!(e instanceof Bail)) throw e;
      resolved = resolvedBefore;
      i = start;
      skipTo();
      return code(src.slice(start, i));
    }
  };

  const primary = (): unknown => {
    ws();
    const c = peek();
    if (c === '"' || c === "'") return stringLiteral();
    if (c === "`") return template();
    if (c === "[") return array();
    if (c === "{") return object();
    if (c === "(") {
      i++;
      const inner = expression();
      eat(")");
      return postfix(inner);
    }
    const num = src.slice(i).match(/^-?(\d[\d_]*\.?\d*(e[+-]?\d+)?|\.\d+)/i);
    if (num) {
      i += num[0].length;
      resolved = true;
      return Number(num[0].replace(/_/g, ""));
    }
    const id = src.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (!id) return bail();
    i += id[0].length;
    const literals: Record<string, unknown> = { true: true, false: false, null: null, undefined: undefined };
    if (id[0] in literals) {
      resolved = true;
      return literals[id[0]];
    }
    if (!known.has(id[0])) return bail();
    resolved = true;
    return postfix(known.get(id[0]));
  };

  /** `.name`, `?.name`, `[0]`, `["key"]` after a value; a call (`(…)`) can't be worked out. */
  const postfix = (value: unknown): unknown => {
    for (;;) {
      ws();
      const optional = src.startsWith("?.", i);
      if (optional) i += 2;
      if (peek() === "[") {
        i++;
        const key = expression();
        eat("]");
        if (typeof key !== "string" && typeof key !== "number") return bail();
        value = member(value, key, optional);
      } else if (peek() === "(") return bail();
      else if (optional || (peek() === "." && src[i + 1] !== ".")) {
        if (!optional) i++;
        ws();
        const name = src.slice(i).match(/^[A-Za-z_$][\w$]*/);
        if (!name) return bail();
        i += name[0].length;
        value = member(value, name[0], optional);
      } else return value;
    }
  };
  const member = (value: unknown, key: string | number, optional: boolean): unknown => {
    if (value === null || value === undefined) return optional ? undefined : bail();
    if (Array.isArray(value) && key === "length") return value.length;
    if (typeof value === "string" && key === "length") return value.length;
    if (typeof value !== "object" || !(key in (value as object))) return bail();
    return (value as Record<string | number, unknown>)[key];
  };

  const stringLiteral = (): string => {
    const quote = src[i++];
    let out = "";
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") {
        const next = src[i + 1];
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 2;
      } else out += src[i++];
    }
    i++;
    resolved = true;
    return out;
  };

  const template = (): string => {
    i++; // `
    let out = "";
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") {
        out += src[i + 1];
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        const part = expression();
        // A string can't be partly worked out.
        if (typeof part === "string" && part.startsWith("[Code ")) bail();
        out += typeof part === "object" && part !== null ? JSON.stringify(part) : String(part);
        eat("}");
      } else out += src[i++];
    }
    i++;
    resolved = true;
    return out;
  };

  const array = (): unknown[] => {
    i++; // [
    const out: unknown[] = [];
    for (;;) {
      ws();
      if (peek() === "]") break;
      if (src.startsWith("...", i)) {
        i += 3;
        const spread = expression();
        if (Array.isArray(spread)) out.push(...spread);
        else out.push(typeof spread === "string" && spread.startsWith("[Code ") ? code(`...${spread.slice(6, -1)}`) : bail());
      } else out.push(expression());
      ws();
      if (peek() === ",") i++;
      else break;
    }
    eat("]");
    return out;
  };

  const object = (): Record<string, unknown> => {
    i++; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      ws();
      if (peek() === "}") break;
      if (src.startsWith("...", i)) {
        i += 3;
        const spread = expression();
        if (spread && typeof spread === "object" && !Array.isArray(spread)) Object.assign(out, spread);
        else out["…"] = typeof spread === "string" && spread.startsWith("[Code ") ? code(`...${spread.slice(6, -1)}`) : spread;
      } else {
        const keyStart = i;
        let key: string;
        if (peek() === '"' || peek() === "'") key = stringLiteral();
        else if (peek() === "[") {
          // A computed key: kept as written.
          skipTo(":");
          key = src.slice(keyStart, i).trim();
        } else {
          const name = src.slice(i).match(/^[A-Za-z_$][\w$]*|^\d+/);
          if (!name) return bail();
          key = name[0];
          i += key.length;
        }
        ws();
        if (peek() === ":") {
          i++;
          out[key] = expression();
        } else if (peek() === "(") {
          // A method: `load() { … }`.
          skipTo();
          out[key] = FUNCTION;
        } else {
          // Shorthand: `{ count }`.
          out[key] = known.has(key) ? ((resolved = true), known.get(key)) : code(key);
        }
      }
      ws();
      if (peek() === ",") i++;
      else break;
    }
    eat("}");
    return out;
  };

  const value = expression();
  return { value, resolved };
}

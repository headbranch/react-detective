import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as TS from "typescript";
import type { Card, OutlineItem } from "./card";

/**
 * Types the source can't spell out (`const online = useSyncExternalStore(…, () => navigator.onLine)`,
 * a computed value, a package hook's return) from TypeScript's own checker, using the project's
 * `typescript` and `tsconfig.json`. Optional: without TypeScript installed, nothing changes.
 *
 * Building the checker takes a moment and blocks while it does, so it's started a little after the
 * dev server and never waited for: until it's ready, cards go without these types. After that,
 * edits only re-check what changed.
 */
interface Service {
  ts: typeof TS;
  service: TS.LanguageService;
}

const services = new Map<string, Service | null | "starting">();
const WARM_UP_DELAY = 3000;
/** Longer types are cut short in the row (the full one is on hover there); beyond this they're not worth showing. */
const MAX_TYPE = 120;

/** Starts building the checker for `root` in the background, once. Resolves when it's ready (or known to be unavailable). */
export function warmUpTypes(root: string, delay = WARM_UP_DELAY): Promise<void> {
  if (services.has(root)) return Promise.resolve();
  services.set(root, "starting");
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        services.set(root, createService(root));
      } catch {
        services.set(root, null);
      }
      resolve();
    }, delay).unref();
  });
}

function createService(root: string): Service | null {
  let ts: typeof TS;
  try {
    ts = createRequire(path.join(root, "package.json"))("typescript");
  } catch {
    return null; // not a TypeScript project
  }
  const configFile = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  const config = configFile
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configFile, ts.sys.readFile).config, ts.sys, path.dirname(configFile))
    : { fileNames: [], options: { jsx: ts.JsxEmit.ReactJSX, allowJs: true, strict: true } as TS.CompilerOptions };
  const files = new Set(config.fileNames.map((f) => path.resolve(f)));
  const version = (f: string) => {
    try {
      return String(fs.statSync(f).mtimeMs);
    } catch {
      return "0";
    }
  };
  const host: TS.LanguageServiceHost = {
    getScriptFileNames: () => [...files],
    getScriptVersion: version,
    getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ ...config.options, noEmit: true }),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  service.getProgram(); // the slow part: done now, while warming up
  return { ts, service };
}

/** Fills in the types an outline is missing, if the checker for `root` is ready. */
export function withCheckedTypes(root: string, file: string | undefined, card: Card): Card {
  const entry = services.get(root);
  if (!file || !entry || entry === "starting") return card;
  const { ts, service } = entry;
  const abs = path.resolve(root, file);
  const program = service.getProgram();
  const sf = program?.getSourceFile(abs);
  if (!program || !sf) return card;
  const checker = program.getTypeChecker();
  const lines = sf.text.split("\n");

  /** The identifier `name` declared on or just after `line` (destructuring can span lines). */
  const identifierAt = (name: string, line: number): TS.Identifier | null => {
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
    for (let l = line - 1; l < Math.min(lines.length, line + 9); l++) {
      const col = lines[l]?.search(word) ?? -1;
      if (col < 0) continue;
      const pos = sf.getPositionOfLineAndCharacter(l, col);
      const node = deepest(ts, sf, pos);
      if (node && ts.isIdentifier(node) && node.text === name) return node;
    }
    return null;
  };
  const show = (type: TS.Type, at: TS.Node) => {
    const text = checker.typeToString(type, at, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
    return text.length > MAX_TYPE || text === "any" ? "" : text;
  };

  const fill = (item: OutlineItem): OutlineItem => {
    const children = item.children.map(fill);
    if (item.type) return { ...item, children };
    let type = "";
    try {
      if (item.kind === "hook") {
        // A package's hook: what it's called with and gives back, `(options) => UseQueryResult<…>`.
        const callee = identifierAt(item.name.replace(/\(.*$/s, ""), item.line);
        const call = callee?.parent && ts.isCallExpression(callee.parent) ? callee.parent : null;
        const sig = call && checker.getResolvedSignature(call);
        if (sig) {
          const ret = show(sig.getReturnType(), call!);
          if (ret) type = `(${sig.parameters.map((p) => p.name).join(", ")}) => ${ret}`;
        }
      } else if (["state", "ref", "derived", "memo", "context", "store", "constant", "function", "callback"].includes(item.kind) && /^[\w$]+$/.test(item.name)) {
        const id = identifierAt(item.name, item.line);
        if (id) type = show(checker.getTypeAtLocation(id), id);
      }
    } catch {
      // A checker hiccup on one item shouldn't cost the card.
    }
    return { ...item, type, children };
  };
  return { ...card, outline: card.outline.map(fill) };
}

function deepest(ts: typeof TS, sf: TS.SourceFile, pos: number): TS.Node | null {
  let found: TS.Node | null = null;
  const visit = (node: TS.Node) => {
    if (pos < node.getStart(sf) || pos >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

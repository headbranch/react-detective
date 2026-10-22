import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Card } from "./card";

/** Project-relative path → git blob id of its content at the time it was read. */
export type Deps = Record<string, string>;

/** Where in git history an answer was produced. */
export interface GitStamp {
  commit: string;
  branch: string;
  /** The files the answer relied on had uncommitted changes. */
  dirty: boolean;
}

export interface ExplanationEntry {
  /** Markdown version (prompt context, readable diffs in git). */
  markdown: string;
  /** Structured explanation rendered by the panel. */
  card?: Card;
  deps: Deps;
  createdAt: number;
  model?: string;
  git?: GitStamp;
}

export interface QuestionEntry {
  question: string;
  answer: string;
  deps: Deps;
  createdAt: number;
  git?: GitStamp;
}

export interface ComponentRecord {
  component: string;
  file: string | null;
  explanation?: ExplanationEntry;
  questions: QuestionEntry[];
}

export interface FileNote {
  hash: string;
  summary: string;
  /** Exported name (`default` for the default export) → what importers need to know about it. */
  exports?: Record<string, string>;
  updatedAt: number;
}

export interface Freshness {
  fresh: boolean;
  /** Dependencies whose content changed or that were deleted. */
  changed: string[];
}

const README = `# .react-detective

Knowledge collected by [react-detective](https://github.com/) while explaining this codebase.

- \`components/\` holds one file per component: the explanation and every question asked about it.
  Each answer records the files the AI read and their git blob ids, so it is only reused while
  that code is unchanged, and the commit it was written at.
- \`files.json\` holds short AI-written summaries of source files and of each thing they export,
  keyed by content hash. They let the AI skip re-reading files that haven't changed, including
  when it explains another component that imports from them.

Commit this folder so your team shares explanations instead of paying for them again.
Delete any file to force it to be regenerated.
`;

/**
 * Persistent, version-aware knowledge base stored in `<root>/.react-detective`.
 * Everything is plain, stably-ordered JSON so it diffs and merges reasonably in git.
 */
export class KnowledgeStore {
  readonly dir: string;
  private root: string;
  /** Local-only copies of file versions we explained, so we can diff against them later. */
  private blobDir: string;
  private hashMemo = new Map<string, { mtimeMs: number; size: number; hash: string }>();
  private notes: Record<string, FileNote> | null = null;

  constructor(root: string, dirName = ".react-detective") {
    this.root = root;
    this.dir = path.join(root, dirName);
    this.blobDir = path.join(root, "node_modules", ".cache", "react-detective", "blobs");
  }

  // ---------- hashing ----------

  /** Normalized content of a project file, or null if it doesn't exist. */
  readFile(rel: string): string | null {
    try {
      return fs.readFileSync(path.join(this.root, rel), "utf8").replace(/\r\n/g, "\n");
    } catch {
      return null;
    }
  }

  /**
   * Fingerprint of a project file (its git blob id), or null if it doesn't exist.
   * Line endings are normalized so Windows and Unix checkouts agree.
   */
  hashFile(rel: string): string | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(this.root, rel));
    } catch {
      return null;
    }
    const memo = this.hashMemo.get(rel);
    if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.hash;
    const content = this.readFile(rel);
    if (content === null) return null;
    const hash = blobHash(content);
    this.hashMemo.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  }

  /** Keeps a local copy of each dependency's current content, so later diffs work even for never-committed versions. */
  saveBlobs(deps: Deps) {
    for (const [rel, hash] of Object.entries(deps)) {
      const file = path.join(this.blobDir, hash);
      if (fs.existsSync(file)) continue;
      const content = this.readFile(rel);
      if (content === null || blobHash(content) !== hash) continue;
      try {
        fs.mkdirSync(this.blobDir, { recursive: true });
        fs.writeFileSync(file, content);
      } catch {}
    }
  }

  readBlob(hash: string): string | null {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    try {
      return fs.readFileSync(path.join(this.blobDir, hash), "utf8");
    } catch {
      return null;
    }
  }

  snapshot(files: Iterable<string>): Deps {
    const deps: Deps = {};
    for (const f of [...new Set(files)].sort()) {
      const h = this.hashFile(f);
      if (h) deps[f] = h;
    }
    return deps;
  }

  check(deps: Deps): Freshness {
    const changed = Object.entries(deps)
      .filter(([f, h]) => this.hashFile(f) !== h)
      .map(([f]) => f);
    return { fresh: changed.length === 0, changed };
  }

  // ---------- components ----------

  getComponent(component: string, file: string | undefined): ComponentRecord {
    try {
      return JSON.parse(fs.readFileSync(this.componentPath(component, file), "utf8"));
    } catch {
      return { component, file: file ?? null, questions: [] };
    }
  }

  saveExplanation(component: string, file: string | undefined, entry: ExplanationEntry) {
    const rec = this.getComponent(component, file);
    rec.explanation = entry;
    this.writeComponent(rec, file);
  }

  saveQuestion(component: string, file: string | undefined, entry: QuestionEntry) {
    const rec = this.getComponent(component, file);
    const key = normalizeQuestion(entry.question);
    // A re-asked question replaces its outdated answer instead of piling up duplicates.
    rec.questions = rec.questions.filter((q) => normalizeQuestion(q.question) !== key);
    rec.questions.push(entry);
    this.writeComponent(rec, file);
  }

  findQuestion(rec: ComponentRecord, question: string): QuestionEntry | undefined {
    const key = normalizeQuestion(question);
    return rec.questions.find((q) => normalizeQuestion(q.question) === key);
  }

  /** Every saved component record, for finding knowledge about related components. */
  listComponents(): ComponentRecord[] {
    const dir = path.join(this.dir, "components");
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: ComponentRecord[] = [];
    for (const name of names) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
      } catch {}
    }
    return out;
  }

  private componentPath(component: string, file: string | undefined) {
    const safeFile = (file ?? "_unknown").replace(/[\\/]/g, "--").replace(/[^\w.\-[\]()@]/g, "_");
    return path.join(this.dir, "components", `${safeFile}--${component.replace(/[^\w]/g, "_")}.json`);
  }

  private writeComponent(rec: ComponentRecord, file: string | undefined) {
    this.write(this.componentPath(rec.component, file), rec);
  }

  // ---------- file notes ----------

  /** Notes whose file content is unchanged since they were written. */
  validNotes(files: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of files) {
      const note = this.validNote(f);
      if (note) out[f] = note.summary;
    }
    return out;
  }

  /** Saved descriptions of a file's exports, if the file is unchanged since they were written. */
  validExports(file: string): Record<string, string> {
    return this.validNote(file)?.exports ?? {};
  }

  private validNote(file: string): FileNote | undefined {
    const note = this.loadNotes()[file];
    return note && this.hashFile(file) === note.hash ? note : undefined;
  }

  noteFiles(): string[] {
    return Object.keys(this.loadNotes());
  }

  saveNotes(summaries: Record<string, string>, deps: Deps, exports: Record<string, Record<string, string>> = {}) {
    const all = this.loadNotes();
    let changed = false;
    for (const [file, summary] of Object.entries(summaries)) {
      // Only trust a note for a file we have a hash for, i.e. one the agent actually read.
      const hash = deps[file];
      if (!hash || !summary?.trim()) continue;
      // Export descriptions written for this same version stay valid if this run didn't redo them.
      const kept = all[file]?.hash === hash ? all[file].exports : undefined;
      const described = Object.entries(exports[file] ?? {}).filter(([name, d]) => name.trim() && d?.trim());
      const merged = { ...kept, ...Object.fromEntries(described.map(([name, d]) => [name.trim(), d.trim()])) };
      all[file] = { hash, summary: summary.trim(), ...(Object.keys(merged).length ? { exports: merged } : {}), updatedAt: Date.now() };
      changed = true;
    }
    if (changed) this.write(path.join(this.dir, "files.json"), sortKeys(all));
  }

  private loadNotes(): Record<string, FileNote> {
    if (!this.notes) {
      try {
        this.notes = JSON.parse(fs.readFileSync(path.join(this.dir, "files.json"), "utf8"));
      } catch {
        this.notes = {};
      }
    }
    return this.notes!;
  }

  // ---------- io ----------

  private write(file: string, data: unknown) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const readme = path.join(this.dir, "README.md");
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    } catch (err) {
      console.warn(`[react-detective] could not write ${file}: ${(err as Error).message}`);
    }
  }
}

/**
 * The id git itself gives this (LF-normalized) content. Using git's blob id as the
 * fingerprint means any version that was ever committed, including by teammates,
 * can be recovered with `git cat-file` to show what changed.
 */
export function blobHash(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Relative / alias imports of a source file, resolved to project paths. Used to pick
 * which file notes are worth handing to the agent up front.
 */
export function localImports(root: string, rel: string): string[] {
  let code: string;
  try {
    code = fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) {
    const hit = resolveImport(root, rel, m[1]);
    if (hit) out.push(hit);
  }
  return [...new Set(out)];
}

/**
 * Like resolveImport, but also follows a package name (`@tanstack/react-query`, `zustand/react`) into
 * node_modules, to its ES module entry. Only for reading hooks' source: packages aren't project files.
 * The result is relative to `root` and may start with `../` when node_modules sits above it.
 */
export function resolveModule(root: string, fromRel: string, spec: string): string | null {
  return resolveImport(root, fromRel, spec) ?? resolvePackage(root, fromRel, spec);
}

function resolvePackage(root: string, fromRel: string, spec: string): string | null {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = spec.slice(name.length + 1);
  if (!name || name.startsWith(".")) return null;
  // Node's lookup: node_modules in the importing file's folder, then each folder above it.
  for (let dir = path.dirname(path.join(root, fromRel)); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, "node_modules", name);
    let pkg: any = null;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    } catch {}
    if (pkg) {
      const entry = exportTarget(pkg.exports, sub ? `./${sub}` : ".") ?? (sub ? `./${sub}` : pkg.module ?? pkg.main ?? "index.js");
      const hit = resolveFile(root, path.relative(root, path.join(pkgDir, entry)));
      if (hit) return hit;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** The file package.json's `exports` gives for `subpath`, preferring ES modules: `import`, then `module`, then `default`. */
function exportTarget(exports: any, subpath: string): string | null {
  const pick = (t: any): string | null =>
    typeof t === "string" ? t : t && typeof t === "object" ? (pick(t.import) ?? pick(t.module) ?? pick(t.browser) ?? pick(t.default) ?? null) : null;
  if (typeof exports === "string") return subpath === "." ? exports : null;
  if (!exports || typeof exports !== "object") return null;
  // Conditions only (`{ import, require }`) describe ".".
  if (!Object.keys(exports).some((k) => k.startsWith("."))) return subpath === "." ? pick(exports) : null;
  return pick(exports[subpath]);
}

/** Resolves a relative or `@/` / `~/` import specifier from `fromRel` to a project file. */
export function resolveImport(root: string, fromRel: string, spec: string): string | null {
  const bases: string[] = [];
  if (spec.startsWith(".")) bases.push(path.join(path.dirname(fromRel), spec));
  else if (spec.startsWith("@/") || spec.startsWith("~/")) bases.push(spec.slice(2), path.join("src", spec.slice(2)));
  for (const base of bases) {
    const hit = resolveFile(root, base);
    if (hit) return hit;
  }
  return null;
}

const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
function resolveFile(root: string, base: string): string | null {
  for (const ext of EXTS) {
    const candidate = base + ext;
    try {
      if (fs.statSync(path.join(root, candidate)).isFile()) return candidate.split(path.sep).join("/");
    } catch {}
  }
  return null;
}

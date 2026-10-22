import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import launchEditor from "launch-editor";
import { createTwoFilesPatch } from "diff";
import { KnowledgeStore, localImports, type ComponentRecord, type Deps, type GitStamp, type QuestionEntry } from "./store";
import { explainComponent, type ExplainContext, type ExplainRequest, type FileChange, type ImportedExport } from "./explain";
import { exportsOf, importsOf } from "./exports";
import { cardToMarkdown, isCurrentCard, type Card } from "./card";
import { Git } from "./git";
import { resolveTypes } from "./types";
import { hookSlots } from "./hookslots";
import { findUsages, mergeWithSource, skeletonCard } from "./skeleton";
import { describeCallSites } from "./callsites";
import { warmUpTypes, withCheckedTypes } from "./tstypes";
import { findApiKey, MISSING_KEY_MESSAGE } from "./env";

const MAX_FILE_DIFF = 8_000;
const MAX_TOTAL_DIFF = 20_000;
// Source handed to the agent up front (characters), so it doesn't spend steps opening files.
const MAX_PRELOAD_FILE = 16_000;
const MAX_PRELOAD_TOTAL = 36_000;
// Saved descriptions of imported exports handed to the agent (characters).
const MAX_IMPORT_NOTES = 8_000;

export interface DetectiveServerOptions {
  /** Project root; source paths and the agent's working directory are relative to it. */
  root: string;
  /**
   * Model for explanations: an alias (`"sonnet"`, `"haiku"`, `"opus"`) or a full model ID.
   * Default `"sonnet"`.
   */
  model?: string;
  maxTurns?: number;
  /** Knowledge folder name inside the project root. Default `.react-detective`. */
  storeDir?: string;
  /** URL prefix the handler answers on. */
  base?: string;
}

/** Used when no `model` option is given: good explanations at a fraction of Opus' price. */
const DEFAULT_MODEL = "sonnet";

type Next = (err?: unknown) => void;

/**
 * Connect-style middleware shared by the Vite plugin (mounted on Vite's own
 * server) and the standalone server used for Next.js and other bundlers.
 */
export function createDetectiveHandler(opts: DetectiveServerOptions) {
  const base = opts.base ?? "/__detective";
  const root = path.resolve(opts.root);
  const store = new KnowledgeStore(root, opts.storeDir);
  warmUpTypes(root);
  const git = new Git(root);

  return async function handle(req: IncomingMessage, res: ServerResponse, next?: Next) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(base)) return next ? next() : notFound(res);

    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) return send(res, 403, { error: "Only local origins may use react-detective." });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return send(res, 204);

    const route = url.pathname.slice(base.length);
    try {
      if (route === "/health" && req.method === "GET") return send(res, 200, { ok: true, root });
      if (route === "/open" && req.method === "POST") {
        const body = await readJson(req);
        const file = safeResolve(root, body.file);
        if (!file) return send(res, 400, { error: "Invalid file" });
        launchEditor(`${file}:${Number(body.line) || 1}:${Number(body.column) || 1}`);
        return send(res, 200, { ok: true });
      }
      if (route === "/explain" && req.method === "POST") return explain(await readJson(req), res);
    } catch (err) {
      return send(res, 500, { error: String((err as Error)?.message ?? err) });
    }
    return notFound(res);
  };

  async function explain(body: ExplainRequest & { refresh?: boolean }, res: ServerResponse) {
    if (!body?.component || typeof body.component !== "string") return send(res, 400, { error: "component is required" });
    if (body.file && !safeResolve(root, body.file)) return send(res, 400, { error: "Invalid file" });

    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    const emit = (event: object) => res.write(JSON.stringify(event) + "\n");

    const rec = store.getComponent(body.component, body.file);
    // Explanations saved in an older card format are regenerated as if there were none.
    const saved = isCurrentCard(rec.explanation?.card) ? rec.explanation : undefined;
    const context: ExplainContext = {};
    // Files whose state the answer will rely on even if the agent never opens them.
    const reliedOn = new Set<string>(body.file ? [body.file] : []);
    // Names for the live hook values (read from source), so the panel can label them.
    const slotsFor = () => hookSlots(root, body.file, body.component);
    // Read fresh from the source each time: what each place it's rendered passes (only the listed
    // files are read), and types TypeScript's checker can add (once it has warmed up).
    const fromSource = <C extends Card | null>(card: C): C =>
      (card ? withCheckedTypes(root, body.file, { ...card, usedIn: describeCallSites(root, body.component, card.usedIn) }) : card) as C;
    // Custom types mentioned in an answer, resolved from source so the panel can show their definitions.
    const typesFor = (content: unknown) => resolveTypes(root, body.file, typeof content === "string" ? content : JSON.stringify(content));

    // Git calls are slow to spawn (especially on Windows), so start them now but never
    // make a saved answer wait for them: the "who changed it" info follows separately.
    const gitInfo = (async () => {
      const isRepo = await git.isRepo();
      if (!isRepo || !body.file) return { isRepo, history: [] as Awaited<ReturnType<Git["recentCommits"]>>, uncommitted: false };
      const [history, uncommitted] = await Promise.all([git.recentCommits(body.file, 5), body.question ? false : git.isDirty([body.file])]);
      return { isRepo, history, uncommitted };
    })();
    let contextSent = false;
    const sendContext = async () => {
      const g = await gitInfo;
      if (contextSent || body.question || !g.isRepo || !body.file) return;
      contextSent = true;
      emit({ type: "context", lastChange: g.history[0] ?? null, uncommitted: g.uncommitted });
    };
    const finishCached = async (event: object) => {
      emit(event);
      await sendContext();
      res.end();
    };

    // A question asked before, whose saved answer is left out of the past answers handed over.
    let prev: QuestionEntry | undefined;
    if (body.question) {
      prev = store.findQuestion(rec, body.question);
      if (prev && !body.refresh && store.check(prev.deps).fresh) {
        return finishCached({ type: "result", markdown: prev.answer, types: typesFor(prev.answer), cached: true, createdAt: prev.createdAt, git: prev.git });
      }
      if (saved && store.check(saved.deps).fresh) {
        context.explanation = saved.markdown;
        Object.keys(saved.deps).forEach((f) => reliedOn.add(f));
      }
    } else {
      emit({
        type: "history",
        questions: rec.questions.map((q) => ({
          question: q.question,
          answer: q.answer,
          createdAt: q.createdAt,
          stale: !store.check(q.deps).fresh,
        })),
      });
      if (saved?.card && !body.refresh) {
        const { fresh, changed } = store.check(saved.deps);
        // Fill in the card's structure from the current source (cheap: the parse is cached). If the code
        // is unchanged that's exactly what it described; otherwise the explanations stay as written.
        const card = fromSource(mergeWithSource(saved.card, skeletonCard(root, body.file, body.component)));
        if (fresh) {
          return finishCached({ type: "result", markdown: saved.markdown, card, types: typesFor(card), slots: slotsFor(), cached: true, createdAt: saved.createdAt, git: saved.git });
        }
        // Show the outdated answer and what changed immediately, then update it from the diffs.
        const changes = await describeChanges(saved.deps, changed);
        emit({ type: "stale", markdown: saved.markdown, card, types: typesFor(card), slots: slotsFor(), changes, createdAt: saved.createdAt, git: saved.git });
        context.previous = { markdown: saved.markdown, changes, unchanged: Object.keys(saved.deps) };
        Object.keys(saved.deps).forEach((f) => reliedOn.add(f));
      }
    }

    // From here on the agent runs. Where it's rendered is found with a plain text scan, so
    // the agent doesn't spend a step grepping for it.
    const usages = findUsages(root, body.component);
    if (!body.question && !context.previous) {
      // An outline read straight from the source, shown while the agent writes the explanations.
      const skeleton = fromSource(skeletonCard(root, body.file, body.component, usages));
      if (skeleton) emit({ type: "skeleton", card: skeleton, types: typesFor(skeleton), slots: slotsFor() });
    }
    // New answers need an API key; the outline above and saved answers don't.
    const apiKey = findApiKey(root);
    if (!apiKey) {
      emit({ type: "error", code: "no-api-key", message: MISSING_KEY_MESSAGE(root) });
      await sendContext();
      return void res.end();
    }
    await sendContext();
    const { isRepo, history } = await gitInfo;
    if (history.length) context.history = history;
    const related = relatedRecords(rec, body);

    // Answers build on earlier ones, and explanations learn from them too (e.g. a bug found in a Q&A).
    context.pastQuestions = pastAnswers(rec, related, reliedOn, prev);

    // Notes are verified against file fingerprints, so they're safe to reuse even on ↻.
    context.notes = relevantNotes(rec, body.file, related);
    Object.keys(context.notes).forEach((f) => reliedOn.add(f));
    // What it imports, described when those files were read for earlier explanations.
    context.imports = importedExports(body.file, reliedOn);
    // Hand over the files the agent would open first anyway, so it skips those steps.
    context.usages = usages;
    context.sources = preloadSources(body.file, context);
    Object.keys(context.sources).forEach((f) => reliedOn.add(f));

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    try {
      const model = opts.model ?? DEFAULT_MODEL;
      const result = await explainComponent(body, {
        root,
        model,
        maxTurns: opts.maxTurns,
        signal: abort.signal,
        context,
        apiKey,
        git: isRepo ? git : undefined,
        onProgress: (text) => emit({ type: "progress", text }),
      });
      // The model writes the prose; structure (names, lines, types, missing items) comes from the source.
      if (result.card) {
        result.card = fromSource(mergeWithSource(result.card, skeletonCard(root, body.file, body.component, usages)));
        result.markdown = cardToMarkdown(result.card);
      }
      const deps = store.snapshot([...reliedOn, ...result.filesRead]);
      store.saveBlobs(deps);
      // Preloaded files count as read: the agent writes notes for them too.
      store.saveNotes(result.notes, store.snapshot([...result.filesRead, ...Object.keys(context.sources ?? {})]), result.exports);
      const stamp = await gitStamp(Object.keys(deps));
      const now = Date.now();
      if (body.question) {
        store.saveQuestion(body.component, body.file, { question: body.question, answer: result.markdown, deps, createdAt: now, git: stamp });
      } else {
        store.saveExplanation(body.component, body.file, { markdown: result.markdown, card: result.card, deps, createdAt: now, model: result.model ?? model, git: stamp });
      }
      emit({
        type: "result",
        markdown: result.markdown,
        card: result.card,
        types: typesFor(result.card ?? result.markdown),
        slots: body.question ? undefined : slotsFor(),
        cached: false,
        costUsd: result.costUsd,
        turns: result.turns,
        model: result.model ?? model,
        filesRead: result.filesRead.length,
        notesReused: Object.keys(context.notes ?? {}).length,
        exportsReused: context.imports?.length ?? 0,
        answersReused: context.pastQuestions?.length ?? 0,
        git: stamp,
      });
    } catch (err) {
      if (!abort.signal.aborted) emit({ type: "error", message: friendlyError(err) });
    }
    res.end();
  }

  /**
   * Diffs each changed dependency against the version that was explained. The old
   * content comes from our local snapshot, or from git if that version was committed
   * (e.g. the answer was generated by a teammate).
   */
  async function describeChanges(deps: Deps, changed: string[]): Promise<FileChange[]> {
    let budget = MAX_TOTAL_DIFF;
    const out: FileChange[] = [];
    for (const file of changed) {
      const now = store.readFile(file);
      if (now === null) {
        out.push({ file, deleted: true });
        continue;
      }
      const old = store.readBlob(deps[file]) ?? (await git.catBlob(deps[file]))?.replace(/\r\n/g, "\n") ?? null;
      if (old === null) {
        out.push({ file });
        continue;
      }
      const diff = createTwoFilesPatch(`a/${file}`, `b/${file}`, old, now, "explained version", "now", { context: 3 })
        .replace(/^=+\n/, "")
        .trimEnd();
      // Huge diffs cost more than just re-reading the file.
      if (diff.length > MAX_FILE_DIFF || diff.length > budget) out.push({ file });
      else {
        budget -= diff.length;
        out.push({ file, diff });
      }
    }
    return out;
  }

  async function gitStamp(files: string[]): Promise<GitStamp | undefined> {
    const head = await git.head();
    return head ? { ...head, dirty: await git.isDirty(files) } : undefined;
  }

  /**
   * Saved knowledge about components connected to this one: its parents and children
   * on the page, components in files it imports, the files that render it, and other
   * components in the same file.
   */
  function relatedRecords(rec: ComponentRecord, body: ExplainRequest): ComponentRecord[] {
    const names = new Set((body.chain ?? []).filter((c) => c !== body.component));
    const files = new Set<string>(body.file ? localImports(root, body.file) : []);
    callerFiles(rec).forEach((f) => files.add(f));
    if (body.file) files.add(body.file);
    return store
      .listComponents()
      .filter((r) => !(r.component === body.component && r.file === (body.file ?? null)))
      .filter((r) => names.has(r.component) || (r.file && files.has(r.file)));
  }

  /** Files that render this component, from its last explanation's "Used in". */
  function callerFiles(rec: ComponentRecord): string[] {
    const usedIn = isCurrentCard(rec.explanation?.card) ? rec.explanation!.card!.usedIn : [];
    return usedIn.map((u) => u.ref.replace(/:\d+(:\d+)?$/, "")).filter((f) => !!safeResolve(root, f));
  }

  /**
   * Still-valid answers to questions about this component (most recent first), then
   * about related ones, within a prompt budget. Only this component's own answers add
   * to `reliedOn`, so a change in a related component doesn't mark this answer outdated.
   */
  function pastAnswers(rec: ComponentRecord, related: ComponentRecord[], reliedOn: Set<string>, exclude?: QuestionEntry) {
    type Candidate = { entry: QuestionEntry; component?: string };
    const own: Candidate[] = rec.questions
      .filter((q) => q !== exclude && store.check(q.deps).fresh)
      .slice(-5)
      .reverse()
      .map((entry) => ({ entry }));
    const others: Candidate[] = related
      .flatMap((r) => r.questions.map((entry) => ({ entry, component: r.component })))
      .filter((c) => store.check(c.entry.deps).fresh)
      .sort((a, b) => b.entry.createdAt - a.entry.createdAt)
      .slice(0, 4);
    const out: { question: string; answer: string; component?: string }[] = [];
    let budget = 8_000;
    for (const { entry, component } of [...own, ...others]) {
      const answer = entry.answer.slice(0, 1500);
      if ((budget -= answer.length + entry.question.length) < 0) break;
      out.push({ question: entry.question, answer, component });
      if (!component) Object.keys(entry.deps).forEach((f) => reliedOn.add(f));
    }
    return out;
  }

  /**
   * Full source to put in the prompt: the component's file (unless an unchanged-file diff
   * already covers it), then files it imports directly that have no saved note yet.
   * Small files only, within a budget: big ones are cheaper to read in part.
   */
  function preloadSources(file: string | undefined, ctx: ExplainContext): Record<string, string> {
    const out: Record<string, string> = {};
    if (!file) return out;
    const changedWithDiff = new Set((ctx.previous?.changes ?? []).filter((c) => c.diff).map((c) => c.file));
    const unchanged = new Set(ctx.previous?.unchanged ?? []);
    let budget = MAX_PRELOAD_TOTAL;
    // Imports whose every imported name already has a saved description don't need their source.
    const described = new Set<string>();
    for (const { file: from, names } of importsOf(root, file)) {
      if (!names.includes("*") && names.every((n) => ctx.imports?.some((i) => i.from === from && i.name === n))) described.add(from);
    }
    const add = (f: string) => {
      if (out[f] !== undefined || changedWithDiff.has(f) || unchanged.has(f) || ctx.notes?.[f] || described.has(f)) return;
      const text = store.readFile(f);
      if (text === null || text.length > MAX_PRELOAD_FILE || text.length > budget) return;
      budget -= text.length;
      out[f] = text;
    };
    // The component's own file is always needed for exact line numbers, even if a note exists.
    const own = store.readFile(file);
    if (own !== null && own.length <= MAX_PRELOAD_FILE && !changedWithDiff.has(file) && !(ctx.previous && unchanged.has(file))) {
      budget -= own.length;
      out[file] = own;
    }
    if (!ctx.previous) localImports(root, file).forEach(add);
    return out;
  }

  /**
   * Saved descriptions of what `file` imports from project files, for the exports whose
   * declaring file is unchanged since they were written. Re-exports through barrel files
   * are followed to the declaration; the barrel's own note is the fallback.
   */
  function importedExports(file: string | undefined, reliedOn: Set<string>): ImportedExport[] {
    if (!file) return [];
    const out: ImportedExport[] = [];
    let budget = MAX_IMPORT_NOTES;
    for (const { file: from, names } of importsOf(root, file)) {
      const exported = exportsOf(root, from);
      const wanted = names.includes("*") ? [...exported.keys()] : names;
      for (const name of wanted) {
        const e = exported.get(name);
        if (!e) continue;
        const own = store.validExports(e.file);
        const description = own[e.declaredAs] ?? (e.declaredAs === "default" ? own[e.local] : undefined) ?? (e.file !== from ? store.validExports(from)[name] : undefined);
        if (!description) continue;
        const entry: ImportedExport = { name, from, declaredIn: e.file !== from ? e.file : undefined, line: e.line, kind: e.kind, signature: e.signature, description };
        if ((budget -= description.length + e.signature.length + name.length + from.length) < 0) return out;
        out.push(entry);
        reliedOn.add(e.file);
        reliedOn.add(from);
      }
    }
    return out;
  }

  /** Still-valid notes for the files this component most likely touches, within a prompt budget. */
  function relevantNotes(rec: ComponentRecord, file: string | undefined, related: ComponentRecord[]): Record<string, string> {
    const candidates = new Set<string>();
    if (file) {
      candidates.add(file);
      localImports(root, file).forEach((f) => candidates.add(f));
    }
    // Callers and related components are what the agent otherwise opens to trace props.
    callerFiles(rec).forEach((f) => candidates.add(f));
    related.forEach((r) => r.file && candidates.add(r.file));
    Object.keys(rec.explanation?.deps ?? {}).forEach((f) => candidates.add(f));
    rec.questions.forEach((q) => Object.keys(q.deps).forEach((f) => candidates.add(f)));

    // Closely related files first, then any other still-valid notes while budget remains,
    // since parents/callers (which we can't find without searching) are often in there.
    const out: Record<string, string> = {};
    let budget = 12_000;
    const close = store.validNotes(candidates);
    const rest = store.validNotes(store.noteFiles().filter((f) => !candidates.has(f)));
    for (const [f, summary] of [...Object.entries(close), ...Object.entries(rest)]) {
      if ((budget -= summary.length + f.length) < 0) break;
      out[f] = summary;
    }
    return out;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Resolves a project-relative path, refusing anything that escapes the root. */
function safeResolve(root: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const abs = path.resolve(root, rel);
  const relative = path.relative(root, abs);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? abs : null;
}

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/auth|api key|x-api-key|invalid.*key|401|credential/i.test(msg)) {
    return `${msg}\n\nThe Anthropic API key was rejected. Check ANTHROPIC_API_KEY in your .env.local (or environment) and try again.`;
  }
  return msg;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: object) {
  res.statusCode = status;
  if (body) res.setHeader("Content-Type", "application/json");
  res.end(body ? JSON.stringify(body) : undefined);
}

function notFound(res: ServerResponse) {
  send(res, 404, { error: "Not found" });
}

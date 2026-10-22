import path from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CommitInfo, Git } from "./git";
import { AnswerSchema, answerJsonSchema, CARD_VERSION, CardSchema, cardJsonSchema, cardToMarkdown, type Card } from "./card";

export interface ExplainRequest {
  component: string;
  /** Project-relative path, e.g. `src/components/UserCard.tsx`. May be absent for parents we only know by name. */
  file?: string;
  line?: number;
  /** Outer → inner component names, as seen in the page. */
  chain?: string[];
  /** Serialized live props / state from the running app (client components only). */
  props?: unknown;
  state?: unknown;
  /** Text of the element the developer pointed at, to anchor "this button" style questions. */
  elementText?: string;
  /** Free-form follow-up question about this component. */
  question?: string;
}

/** What we already know, so the agent can skip work. */
export interface ExplainContext {
  /** Summaries of files whose content is verified unchanged since they were written. */
  notes?: Record<string, string>;
  /** A previous explanation that is outdated because some files it relied on changed. */
  previous?: { markdown: string; changes: FileChange[]; unchanged: string[] };
  /** Recent commits touching the component's file, newest first. */
  history?: CommitInfo[];
  /** The current (fresh) explanation of the component, as background for a question. */
  explanation?: string;
  /** Still-valid Q&A about this component, then about related ones (those have `component` set). */
  pastQuestions?: { question: string; answer: string; component?: string }[];
  /** Full source of files the agent would open first (the component's own file, imports without notes). Counts as read. */
  sources?: Record<string, string>;
  /** Where the component is rendered, from a text search: `path:line`. */
  usages?: string[];
  /** What the component's file imports from project files, with saved descriptions still valid for the current code. */
  imports?: ImportedExport[];
}

export interface ImportedExport {
  /** Name as imported (`default` for a default import). */
  name: string;
  /** The file the import statement points at. */
  from: string;
  /** Where it is declared, when that differs from `from` (re-exported through a barrel file). */
  declaredIn?: string;
  line: number;
  kind: string;
  signature: string;
  description: string;
}

export interface FileChange {
  file: string;
  /** Unified diff from the explained version to now, when the old version could be recovered. */
  diff?: string;
  deleted?: boolean;
}

export interface ExplainOptions {
  root: string;
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  context?: ExplainContext;
  /** When set, the agent also gets read-only git history tools. */
  git?: Git;
  /** Anthropic API key the agent signs in with. */
  apiKey: string;
}

export interface ExplainResult {
  /** Markdown answer (questions) or a markdown rendering of the card (explanations). */
  markdown: string;
  /** Structured explanation, rendered as visual sections by the panel. */
  card?: Card;
  /** Project-relative files the agent opened. */
  filesRead: string[];
  /** Per-file summaries the agent wrote for the files it read. */
  notes: Record<string, string>;
  /** Per-file descriptions of each export (file → export name → description). */
  exports: Record<string, Record<string, string>>;
  costUsd?: number;
  /** Agent steps (model calls) the run took. */
  turns?: number;
  /** The model that actually answered (resolved from an alias like "sonnet"). */
  model?: string;
}

const SYSTEM_PROMPT = `You are a senior engineer onboarding a developer onto a React codebase they did not write (often it was AI-generated). The developer pointed at a component in the running app and wants to understand it.

Explore the code with your read-only tools. Files whose source is included in the message are already read: do not open them again. Otherwise open the component's file, then follow imports, hooks, contexts, stores and API calls as far as needed, and grep for where the component is rendered. Prefer a few targeted reads over reading everything. Never guess about code you have not opened.

You may be given "verified file notes": summaries of files whose content has not changed since the summary was written. Trust them and do not re-read those files unless you need exact lines or details the note doesn't cover. This saves the developer time and money.

You may also be given "imported exports": what the component imports from project files, each with its signature (read from the current source) and a verified description. Trust them like file notes: don't open a file just to learn what an imported function, hook, component or constant does.

You may have read-only git tools (log, blame, show). Commit messages often explain intent, especially in AI-written code. Use them when the developer asks why, when or who, or when code looks odd and history would explain it; otherwise don't spend calls on them.

Your final answer is structured data that is rendered as a visual panel, not prose. The developer reads it top to bottom: overview, then props, then an IDE-style outline of the component's internals they can click to expand.
- Write in plain language for someone who has never seen this code. Short, concrete strings; no filler; don't repeat the same fact in two places.
- Whenever you mention a prop, state, ref, function, value or constant of this component by name, wrap it in backticks (\`focused\`, \`clear()\`, \`MIN_QUERY\`): the panel turns those into hoverable links to their definitions.
- Props and outline explanations describe what a thing is and does. Do not put file paths or line references in them; refer to other parts of the component by name instead.
- The outline mirrors the component's source in order, like VS Code's outline view. Include every state, ref, context read, custom hook call, derived value, memo, callback, handler and effect, plus what it renders: one render item per component element in the returned JSX (named as written, e.g. \`<UserRow>\`) and per conditional or list branch that is a plain element (e.g. \`<p>\` shown if \`error\`), nested like the JSX so the developer sees which component sits inside which. Use exact line numbers from the component's file. Do not add the component itself as an item; its internals are the top level. Otherwise nest only items declared inside another item (e.g. a helper inside an effect).
- If something is surprising or likely a bug, say so briefly in the relevant item's explanation.
- usedIn uses project-relative \`path:line\` references so they become clickable links.
- history holds only commits whose message explains intent; leave it empty otherwise.
- fileNotes must cover every file you opened with Read and every file whose source was included in the message, and describe every export of each of those files: other components that import them rely on these descriptions instead of reading the file.

When the developer asks a specific question, the answer field is short markdown: the direct answer first, then a few bullets at most.`;

export async function explainComponent(req: ExplainRequest, opts: ExplainOptions): Promise<ExplainResult> {
  const abortController = new AbortController();
  opts.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const stream = query({
    prompt: buildPrompt(req, opts.context),
    options: {
      cwd: opts.root,
      systemPrompt: SYSTEM_PROMPT,
      // Read-only: the agent may look at code but never change or execute anything.
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read", "Grep", "Glob", ...(opts.git ? GIT_TOOL_NAMES : [])],
      mcpServers: opts.git ? { git: gitServer(opts.git, opts.root) } : undefined,
      permissionMode: "dontAsk",
      // Isolate from the developer's personal hooks/settings; we only want code exploration.
      settingSources: [],
      env: agentEnv(opts.apiKey),
      maxTurns: opts.maxTurns ?? 30,
      model: opts.model,
      outputFormat: { type: "json_schema", schema: req.question ? answerJsonSchema : cardJsonSchema },
      abortController,
    },
  });

  let raw = "";
  let structured: unknown;
  let costUsd: number | undefined;
  let turns: number | undefined;
  let modelUsed: string | undefined;
  const filesRead = new Set<string>();
  for await (const msg of stream as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      for (const block of msg.message.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input as Record<string, any>;
        if (block.name === "Read" && typeof input.file_path === "string") {
          const rel = toRelative(opts.root, input.file_path);
          if (rel) filesRead.add(rel);
        }
        opts.onProgress?.(describeToolUse(block.name, input, opts.root));
      }
    } else if (msg.type === "result") {
      costUsd = msg.total_cost_usd;
      turns = msg.num_turns;
      modelUsed = Object.keys(msg.modelUsage ?? {})[0];
      if (process.env.DETECTIVE_DEBUG) console.log("[react-detective] usage", JSON.stringify({ turns, costUsd, usage: msg.usage, models: msg.modelUsage }));
      if (msg.subtype === "success") {
        raw = msg.result;
        structured = msg.structured_output;
      } else throw new Error(`Explanation failed (${msg.subtype})`);
    }
  }

  const base = { filesRead: [...filesRead], costUsd, turns, model: modelUsed };
  if (req.question) {
    const parsed = AnswerSchema.safeParse(structured);
    if (parsed.success) return { ...base, markdown: parsed.data.answer, ...notesRecord(parsed.data.fileNotes) };
  } else {
    const parsed = CardSchema.safeParse(structured);
    if (parsed.success) {
      const { fileNotes, ...fields } = parsed.data;
      const card: Card = { ...fields, v: CARD_VERSION };
      return { ...base, card, markdown: cardToMarkdown(card), ...notesRecord(fileNotes) };
    }
  }
  // Structured output missing or malformed: an answer can fall back to whatever text came back.
  if (!req.question || !raw.trim()) throw new Error("The agent returned no usable explanation.");
  return { ...base, markdown: raw.trim(), notes: {}, exports: {} };
}

function notesRecord(list: { file: string; summary: string; exports?: { name: string; description: string }[] }[]) {
  const notes: Record<string, string> = {};
  const exports: Record<string, Record<string, string>> = {};
  for (const n of list) {
    const file = n.file.replace(/\\/g, "/");
    notes[file] = n.summary;
    if (n.exports?.length) exports[file] = Object.fromEntries(n.exports.map((e) => [e.name, e.description]));
  }
  return { notes, exports };
}

function buildPrompt(req: ExplainRequest, ctx: ExplainContext = {}): string {
  const lines: string[] = [];
  const where = req.file ? `defined in \`${req.file}${req.line ? `:${req.line}` : ""}\`` : "(file unknown, so find it with Grep first)";
  lines.push(`The developer is looking at the React component \`<${req.component}>\` ${where}.`);
  if (req.chain?.length) lines.push(`In the page it is rendered inside: ${req.chain.map((c) => `<${c}>`).join(" > ")}.`);
  if (req.elementText) lines.push(`They pointed at an element showing the text: "${req.elementText.slice(0, 200)}".`);
  if (req.props !== undefined) lines.push(`Live props right now (serialized, may be truncated):\n\`\`\`json\n${JSON.stringify(req.props, null, 2).slice(0, 4000)}\n\`\`\``);
  if (req.state !== undefined) lines.push(`Live hook state values, in hook order:\n\`\`\`json\n${JSON.stringify(req.state, null, 2).slice(0, 2000)}\n\`\`\``);

  const notes = Object.entries(ctx.notes ?? {});
  if (notes.length) {
    lines.push(`\nVerified file notes (these files are unchanged since summarized):`);
    for (const [file, summary] of notes) lines.push(`- \`${file}\`: ${summary}`);
  }

  if (ctx.imports?.length) {
    lines.push(`\nImported exports (what \`${req.file}\` imports from project files; signatures are read from the current source, descriptions are verified unchanged):`);
    for (const i of ctx.imports) {
      const where = `\`${i.declaredIn ?? i.from}:${i.line}\`${i.declaredIn ? ` (via \`${i.from}\`)` : ""}`;
      lines.push(`- ${i.kind} \`${i.name}\`${i.signature ? ` \`${i.signature}\`` : ""} from ${where}: ${i.description}`);
    }
  }

  if (ctx.usages) {
    lines.push(
      ctx.usages.length
        ? `\nWhere \`<${req.component}>\` is rendered (text search for \`<${req.component}\` across the project; no need to grep for this again):\n${ctx.usages.map((u) => `- \`${u}\``).join("\n")}`
        : `\nA text search found no \`<${req.component}\` in the project source (it may be rendered under another name, e.g. via a variable or re-export).`,
    );
  }

  for (const [file, text] of Object.entries(ctx.sources ?? {})) {
    const numbered = text
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(4)}\t${l}`)
      .join("\n");
    lines.push(`\nSource of \`${file}\` (line-numbered, current version; this counts as having read it, so do not open it with Read):\n\`\`\`\n${numbered}\n\`\`\``);
  }

  if (ctx.history?.length) {
    lines.push(`\nRecent commits touching \`${req.file}\` (newest first):`);
    for (const c of ctx.history) lines.push(`- \`${c.sha}\` ${c.date} ${c.author}: ${c.subject}`);
  }

  if (ctx.explanation) lines.push(`\nCurrent explanation of this component (still accurate):\n<explanation>\n${ctx.explanation}\n</explanation>`);
  const own = ctx.pastQuestions?.filter((q) => !q.component) ?? [];
  const others = ctx.pastQuestions?.filter((q) => q.component) ?? [];
  if (own.length || others.length) {
    lines.push(
      req.question
        ? `\nQuestions developers already asked (answers verified still accurate: the code they relied on is unchanged). Build on them instead of re-investigating what they already established:`
        : `\nQuestions developers already asked (answers verified still accurate: the code they relied on is unchanged). Use what they established: put any findings that belong to this component (bugs, gotchas, why something works the way it does) into the relevant prop or outline explanation, briefly, and skip re-investigating them:`,
    );
    for (const q of own) lines.push(`<qa about="${req.component}">\nQ: ${q.question}\nA: ${q.answer}\n</qa>`);
    for (const q of others) lines.push(`<qa about="${q.component}" related="true">\nQ: ${q.question}\nA: ${q.answer}\n</qa>`);
  }

  if (req.question) {
    lines.push(`\nThe developer's question: ${req.question}`);
  } else if (ctx.previous) {
    const { changes, markdown } = ctx.previous;
    const changedFiles = changes.map((c) => c.file);
    const unchanged = ctx.previous.unchanged.filter((f) => !changedFiles.includes(f));
    lines.push(`\nAn earlier explanation of this component exists, but some files it relied on have changed since it was written:`);
    for (const c of changes) {
      if (c.deleted) lines.push(`- \`${c.file}\` was deleted.`);
      else if (c.diff) lines.push(`- \`${c.file}\` changed. Diff from the explained version to now:\n\`\`\`diff\n${c.diff}\n\`\`\``);
      else lines.push(`- \`${c.file}\` changed (no diff available, so re-read it).`);
    }
    if (unchanged.length) {
      lines.push(
        `These files it relied on are unchanged, so do NOT open them again; the previous explanation and the notes above already cover them: ${unchanged.map((f) => `\`${f}\``).join(", ")}.`,
      );
    }
    lines.push(
      `Where a diff is shown, use it instead of re-reading the file unless you need surrounding context. Then produce the updated explanation, keeping everything that is still correct.`,
      `<previous_explanation>\n${markdown}\n</previous_explanation>`,
    );
  } else {
    lines.push(`\nExplain this component.`);
  }
  return lines.join("\n");
}

function toRelative(root: string, file: string): string | null {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

const GIT_TOOL_NAMES = ["mcp__git__log", "mcp__git__blame", "mcp__git__show"];

/** Read-only git history exposed to the agent as in-process tools (no shell access). */
function gitServer(git: Git, root: string) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const outside = text("Path is outside the project.");
  return createSdkMcpServer({
    name: "git",
    tools: [
      tool(
        "log",
        "Commit history (hash, date, author, full message) for a project file, newest first. Use it to learn why code was written or changed.",
        { path: z.string().describe("Project-relative file path"), limit: z.number().int().min(1).max(30).optional() },
        async ({ path: p, limit }) => {
          const rel = toRelative(root, p);
          return rel ? text(await git.logText(rel, limit ?? 10)) : outside;
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "blame",
        "Which commit last changed each line in a range of a project file.",
        { path: z.string().describe("Project-relative file path"), start_line: z.number().int().min(1), end_line: z.number().int().min(1) },
        async ({ path: p, start_line, end_line }) => {
          const rel = toRelative(root, p);
          return rel ? text(await git.blameText(rel, start_line, end_line)) : outside;
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "show",
        "Full message, changed files and patch of one commit.",
        { commit: z.string().describe("Commit hash (short or full)") },
        async ({ commit }) => text(await git.showText(commit)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}

function describeToolUse(name: string, input: Record<string, any>, root: string): string {
  const rel = (p?: string) => (p ? (toRelative(root, p) ?? p) : "");
  switch (name) {
    case "mcp__git__log":
      return `Checking git history of ${rel(input.path)}`;
    case "mcp__git__blame":
      return `Running git blame on ${rel(input.path)}:${input.start_line}-${input.end_line}`;
    case "mcp__git__show":
      return `Reading commit ${input.commit}`;
    case "Read":
      return `Reading ${rel(input.file_path)}`;
    case "Grep":
      return `Searching for “${input.pattern}”${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "Glob":
      return `Looking for files matching ${input.pattern}`;
    default:
      return `Using ${name}`;
  }
}

/**
 * The agent's environment: the dev server's, signed in with the API key only. Login tokens are
 * removed so a Claude Code sign-in on this machine is never used (third-party tools may not use
 * claude.ai logins), and runs are billed to the key's account.
 */
function agentEnv(apiKey: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

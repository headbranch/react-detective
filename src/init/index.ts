import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import { structuredPatch } from "diff";
import { findApiKey } from "../server/env";
import {
  addGitIgnore,
  addToApp,
  addToLayout,
  addVitePlugin,
  isGitIgnored,
  newAppFile,
  optionsLiteral,
  setEnvVar,
  wrapNextConfig,
  type DetectiveOptions,
  type EditResult,
} from "./edits";

const ENV_FILE = ".env.local";
const MODELS = ["sonnet", "haiku", "opus"];
const JS_EXTS = [".ts", ".mts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

/** A file the wizard will write; `before` is null for a new file. */
interface Change {
  file: string;
  before: string | null;
  after: string;
  /** Show this instead of a diff (for files holding secrets). */
  summary?: string;
}

/** Something the wizard couldn't do itself, with the snippet to paste. */
interface ManualStep {
  file: string;
  reason: string;
  snippet: string;
}

type Framework = "vite" | "next";

export async function runInit(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", short: "r" },
      model: { type: "string", short: "m" },
      yes: { type: "boolean", short: "y" },
      "skip-install": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`Usage: react-detective init [--root .] [--model sonnet|haiku|opus|<id>] [--yes] [--skip-install]

Sets up React Detective in a Vite or Next.js project: installs it, adds it to your config,
and saves your Anthropic API key to ${ENV_FILE}. Shows every change before writing it.

  --yes, -y        accept the defaults and apply without asking (no API key is asked for)
  --skip-install   don't install the package`);
    return;
  }

  const root = path.resolve(values.root ?? process.cwd());
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) fail(`No package.json in ${root}. Run this from your project's folder, or pass --root.`);

  console.log(`\n${bold("React Detective setup")} ${dim(root)}\n`);

  const framework = detectFramework(root, pkg);
  if (!framework) {
    console.log(`Couldn't find Vite or Next.js in this project. React Detective works with those two for now.
Using something else? Open an issue so we know to support it.`);
    return;
  }
  console.log(`${green("✓")} Found ${framework === "next" ? "Next.js" : "Vite"}`);

  const prompt = values.yes ? null : new Prompt();
  try {
    const model = values.model ?? (prompt ? await prompt.choose("Model for explanations and questions", MODELS, "sonnet") : "sonnet");
    const opts: DetectiveOptions = { model };

    const changes: Change[] = [];
    const manual: ManualStep[] = [];
    if (framework === "vite") planVite(root, opts, changes, manual);
    else planNext(root, opts, changes, manual);

    const pm = detectPackageManager(root);
    const installed = !!(pkg.dependencies?.["react-detective"] || pkg.devDependencies?.["react-detective"]);
    const install = installed || values["skip-install"] ? null : installCommand(pm);

    let installFailed = false;
    if (!changes.length && !install && !manual.length) console.log(`${green("✓")} Already set up`);
    else {
      console.log(`\n${bold("Changes")}`);
      if (install) console.log(`\n${cyan("$")} ${install.join(" ")}`);
      for (const change of changes) printChange(change);
      if (!changes.length && !install) console.log(dim("\nNothing to change automatically."));

      if (changes.length || install) {
        const ok = prompt ? await prompt.confirm("\nApply these changes?", true) : true;
        if (!ok) {
          console.log("Nothing was changed.");
          return;
        }
      }

      for (const change of changes) writeChange(root, change);

      if (install) {
        console.log(`\n${cyan("$")} ${install.join(" ")}`);
        const result = spawnSync(install[0], install.slice(1), { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
        installFailed = result.status !== 0;
        if (installFailed) console.log(red(`\nInstall failed. Run it yourself: ${install.join(" ")}`));
      }

      for (const step of manual) {
        console.log(`\n${yellow("!")} ${bold(step.file)}: ${step.reason}. Add this yourself:\n\n${step.snippet}`);
      }
    }

    // Last, because it's optional: saved explanations work without a key.
    const hasKey = await askForApiKey(root, prompt);

    console.log(`\n${bold("Next")}`);
    if (!hasKey) console.log(`  • Add ANTHROPIC_API_KEY=sk-ant-... to ${ENV_FILE} when you're ready (make sure it's in .gitignore). No restart needed.`);
    console.log(`  • Start your dev server as usual, then press ${bold("Alt")} (or click the Detective badge) and click a component`);
    console.log(`  • Commit the ${bold(".react-detective/")} folder once it appears so your team shares explanations`);
    if (installFailed || manual.length) process.exitCode = 1;
  } finally {
    prompt?.close();
  }
}

// ---------------------------------------------------------------------------
// Planning

function planVite(root: string, opts: DetectiveOptions, changes: Change[], manual: ManualStep[]) {
  const file = findFile(root, ["vite.config"], [".ts", ".mts", ".js", ".mjs", ".cjs"]);
  const snippet = `  import detective from "react-detective/vite";\n\n  plugins: [detective(${optionsLiteral(opts)}), react()],`;
  if (!file) {
    manual.push({ file: "vite.config.ts", reason: "no Vite config found", snippet });
    return;
  }
  apply(root, file, addVitePlugin, opts, changes, manual, snippet);
}

function planNext(root: string, opts: DetectiveOptions, changes: Change[], manual: ManualStep[]) {
  const configFile = findFile(root, ["next.config"], [".ts", ".mts", ".js", ".mjs", ".cjs"]);
  const extra = optionsLiteral(opts);
  const configSnippet = `  import { withDetective } from "react-detective/next";\n\n  export default withDetective(nextConfig${extra ? `, ${extra}` : ""});`;
  if (configFile) apply(root, configFile, wrapNextConfig, opts, changes, manual, configSnippet);
  else changes.push({ file: "next.config.mjs", before: null, after: `import { withDetective } from "react-detective/next";\n\n/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default withDetective(nextConfig${extra ? `, ${extra}` : ""});\n` });

  const appDir = ["app", "src/app"].find((d) => isDir(path.join(root, d)));
  const pagesDir = ["pages", "src/pages"].find((d) => isDir(path.join(root, d)));
  const layoutSnippet = `  import { Detective } from "react-detective/react";\n\n  <body>\n    {children}\n    <Detective />\n  </body>`;
  const appSnippet = `  import { Detective } from "react-detective/react";\n\n  return (\n    <>\n      <Component {...pageProps} />\n      <Detective />\n    </>\n  );`;

  if (appDir) {
    const layout = findFile(root, [`${appDir}/layout`], JS_EXTS);
    if (layout) apply(root, layout, (code, name) => addToLayout(code, name), opts, changes, manual, layoutSnippet);
    else manual.push({ file: `${appDir}/layout.tsx`, reason: "no root layout found", snippet: layoutSnippet });
  }
  // Pages Router: only when there are real pages, not just API routes.
  if (pagesDir && (!appDir || hasPages(path.join(root, pagesDir)))) {
    const app = findFile(root, [`${pagesDir}/_app`], JS_EXTS);
    if (app) apply(root, app, (code, name) => addToApp(code, name), opts, changes, manual, appSnippet);
    else {
      const ts = fs.existsSync(path.join(root, "tsconfig.json"));
      changes.push({ file: `${pagesDir}/_app.${ts ? "tsx" : "jsx"}`, before: null, after: newAppFile(ts) });
    }
  }
  if (!appDir && !pagesDir) manual.push({ file: "app/layout.tsx", reason: "no app/ or pages/ folder found", snippet: layoutSnippet });
}

function apply(
  root: string,
  file: string,
  edit: (code: string, filename: string, opts: DetectiveOptions) => EditResult,
  opts: DetectiveOptions,
  changes: Change[],
  manual: ManualStep[],
  snippet: string,
) {
  const before = fs.readFileSync(path.join(root, file), "utf8");
  const result = edit(before, file, opts);
  if (result.status === "changed") changes.push({ file, before, after: result.code });
  else if (result.status === "already") console.log(`${green("✓")} ${file} already set up`);
  else manual.push({ file, reason: result.reason, snippet });
}

function writeChange(root: string, change: Change) {
  fs.mkdirSync(path.dirname(path.join(root, change.file)), { recursive: true });
  fs.writeFileSync(path.join(root, change.file), change.after);
  console.log(`${green("✓")} ${change.before === null ? "Created" : "Updated"} ${change.file}${change.summary ? dim(` (${change.summary})`) : ""}`);
}

/** Asks for the API key (optional) and saves it. Returns whether a key is now available. */
async function askForApiKey(root: string, prompt: Prompt | null): Promise<boolean> {
  if (findApiKey(root)) {
    console.log(`${green("✓")} Anthropic API key already set`);
    return true;
  }
  if (!prompt) return false;
  console.log(`\n${bold("API key")} ${dim("(optional)")}`);
  console.log(`New explanations are written by Claude using your own Anthropic API key. Saved ones work without it.`);
  console.log(dim(`Get one at https://console.anthropic.com/settings/keys. Leave blank to add it later.`));
  const key = await prompt.secret("API key");
  if (!key) return false;
  if (!key.startsWith("sk-ant-")) console.log(yellow(`  That doesn't look like an Anthropic key (they start with sk-ant-), saving it anyway.`));
  const changes: Change[] = [];
  planApiKey(root, key, changes);
  for (const change of changes) writeChange(root, change);
  return true;
}

function planApiKey(root: string, key: string, changes: Change[]) {
  const envPath = path.join(root, ENV_FILE);
  const before = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : null;
  changes.push({ file: ENV_FILE, before, after: setEnvVar(before ?? "", "ANTHROPIC_API_KEY", key), summary: `ANTHROPIC_API_KEY=${mask(key)}` });

  if (gitIgnores(root, ENV_FILE)) return;
  const gitignorePath = path.join(root, ".gitignore");
  const gi = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : null;
  changes.push({ file: ".gitignore", before: gi, after: addGitIgnore(gi ?? "", ENV_FILE) });
}

function gitIgnores(root: string, file: string): boolean {
  try {
    // Exit 0 = ignored, 1 = not ignored; anything else (not a repo, no git) falls through.
    execFileSync("git", ["check-ignore", "-q", file], { cwd: root, stdio: "ignore" });
    return true;
  } catch (err: any) {
    if (err?.status === 1) return false;
  }
  try {
    return isGitIgnored(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), file);
  } catch {
    return false;
  }
}

const mask = (key: string) => (key.length > 14 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…");

// ---------------------------------------------------------------------------
// Detection

function detectFramework(root: string, pkg: any): Framework | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next || findFile(root, ["next.config"], JS_EXTS)) return "next";
  if (deps.vite || findFile(root, ["vite.config"], JS_EXTS)) return "vite";
  return null;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function detectPackageManager(root: string): PackageManager {
  const lockfiles: [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  // Walk up so workspaces in a monorepo use the repo's lockfile.
  for (let dir = root; ; dir = path.dirname(dir)) {
    for (const [file, pm] of lockfiles) if (fs.existsSync(path.join(dir, file))) return pm;
    if (path.dirname(dir) === dir) break;
  }
  const agent = process.env.npm_config_user_agent ?? "";
  return (["pnpm", "yarn", "bun"] as const).find((pm) => agent.startsWith(pm)) ?? "npm";
}

function installCommand(pm: PackageManager): string[] {
  if (pm === "npm") return ["npm", "install", "--save-dev", "react-detective"];
  return [pm, "add", pm === "bun" ? "-d" : "-D", "react-detective"];
}

function findFile(root: string, bases: string[], exts: string[]): string | null {
  for (const base of bases) for (const ext of exts) if (fs.existsSync(path.join(root, base + ext))) return base + ext;
  return null;
}

function hasPages(dir: string): boolean {
  return fs.readdirSync(dir).some((name) => name !== "api" && !name.startsWith("_"));
}

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function fail(message: string): never {
  console.error(red(message));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output and prompts

function printChange(change: Change) {
  const label = change.before === null ? green("new") : yellow("edit");
  console.log(`\n${label} ${bold(change.file)}`);
  if (change.summary) {
    console.log(`  ${green(`+ ${change.summary}`)}`);
    return;
  }
  const patch = structuredPatch(change.file, change.file, change.before ?? "", change.after, "", "", { context: 2 });
  for (const hunk of patch.hunks) {
    console.log(dim(`  @@ line ${hunk.newStart}`));
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const text = `  ${line[0]} ${line.slice(1)}`;
      console.log(line[0] === "+" ? green(text) : line[0] === "-" ? red(text) : dim(text));
    }
  }
}

/**
 * Line-at-a-time prompts. Lines are queued rather than read with `rl.question`, so answers
 * piped in ahead of time aren't dropped; once input ends, every question takes its default.
 */
class Prompt {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  private lines: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;
  private muted = false;

  constructor() {
    this.rl.on("line", (line) => {
      if (this.waiting) this.take(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.take(null);
    });
    // Hide typed characters while `muted` (for the API key).
    const rl = this.rl as any;
    const write = rl._writeToOutput?.bind(rl);
    if (write) {
      rl._writeToOutput = (s: string) => {
        if (!this.muted) write(s);
        else if (s.includes("\n")) write("\n");
        else if (s.length === 1) write("*");
      };
    }
  }

  private take(line: string | null) {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.(line);
  }

  private async ask(question: string, muted = false): Promise<string> {
    this.rl.setPrompt(question);
    this.rl.prompt();
    let line: string | null;
    if (this.lines.length) line = this.lines.shift()!;
    else if (this.closed) line = null;
    else {
      this.muted = muted;
      line = await new Promise<string | null>((resolve) => (this.waiting = resolve));
      this.muted = false;
    }
    // Echo piped answers so the transcript reads like an interactive run.
    if (!process.stdin.isTTY) process.stdout.write(`${line === null ? "" : muted ? "*".repeat(line.length) : line}\n`);
    return (line ?? "").trim();
  }

  async choose(question: string, options: string[], fallback: string): Promise<string> {
    const list = options.map((o) => (o === fallback ? bold(o) : o)).join(" / ");
    return (await this.ask(`${cyan("?")} ${question} (${list}, or a model ID) ${dim(fallback)} `)) || fallback;
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const answer = (await this.ask(`${question} ${dim(fallback ? "(Y/n)" : "(y/N)")} `)).toLowerCase();
    return answer ? answer.startsWith("y") : fallback;
  }

  secret(question: string): Promise<string> {
    return this.ask(`${cyan("?")} ${question}: `, true);
  }

  close() {
    this.rl.close();
  }
}

import { execFile } from "node:child_process";

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface HeadInfo {
  commit: string;
  branch: string;
}

const SEP = "\x1f";

/** Thin, read-only, never-throwing wrapper around the git CLI. */
export class Git {
  private repo: Promise<boolean> | null = null;
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  isRepo(): Promise<boolean> {
    this.repo ??= this.run(["rev-parse", "--is-inside-work-tree"]).then((out) => out?.trim() === "true");
    return this.repo;
  }

  async head(): Promise<HeadInfo | null> {
    if (!(await this.isRepo())) return null;
    const [commit, branch] = await Promise.all([
      this.run(["rev-parse", "--short", "HEAD"]),
      this.run(["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    // A repo with no commits yet has no HEAD.
    return commit ? { commit: commit.trim(), branch: branch?.trim() ?? "" } : null;
  }

  /** True if any of the files have uncommitted changes (or are untracked). */
  async isDirty(files: string[]): Promise<boolean> {
    if (!files.length || !(await this.isRepo())) return false;
    const out = await this.run(["status", "--porcelain", "--", ...files]);
    return !!out?.trim();
  }

  async catBlob(sha: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/.test(sha) || !(await this.isRepo())) return null;
    return this.run(["cat-file", "blob", sha]);
  }

  async recentCommits(file: string, limit = 5): Promise<CommitInfo[]> {
    if (!(await this.isRepo())) return [];
    const out = await this.run(["log", `-n${limit}`, "--follow", "--date=short", `--format=%h${SEP}%an${SEP}%ad${SEP}%s`, "--", file]);
    return (out ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, subject] = line.split(SEP);
        return { sha, author, date, subject };
      });
  }

  // ---------- agent tools (formatted text, size-capped) ----------

  async logText(file: string, limit: number): Promise<string> {
    const out = await this.run([
      "log",
      `-n${Math.min(Math.max(limit, 1), 30)}`,
      "--follow",
      "--date=short",
      "--format=commit %h  %ad  %an%n%B%n---",
      "--",
      file,
    ]);
    return cap(out?.trim() || `No commits found for ${file}.`, 12_000);
  }

  async blameText(file: string, start: number, end: number): Promise<string> {
    const s = Math.max(1, Math.floor(start));
    const e = Math.min(Math.max(s, Math.floor(end)), s + 300);
    const out = await this.run(["blame", "-L", `${s},${e}`, "--date=short", "--", file]);
    return cap(out?.trim() || `Could not blame ${file}:${s}-${e} (uncommitted file or out of range).`, 12_000);
  }

  async showText(commit: string): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) return "Invalid commit hash.";
    const out = await this.run(["show", "--stat", "--patch", "--date=short", "--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B", commit]);
    return cap(out?.trim() || `Commit ${commit} not found.`, 15_000);
  }

  private run(args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("git", ["-c", "core.quotepath=off", ...args], { cwd: this.cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
        resolve(err ? null : stdout),
      );
    });
  }
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length - max} more characters)` : text;
}

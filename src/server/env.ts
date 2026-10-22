import fs from "node:fs";
import path from "node:path";

/** Env files checked for the key, most specific first (same precedence as Vite and Next.js). */
const ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];

/**
 * The Anthropic API key: from the dev server's environment, else from the project's env
 * files. Read on every run, so adding the key takes effect without restarting the server.
 */
export function findApiKey(root: string): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const name of ENV_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    const value = parseEnv(text).ANTHROPIC_API_KEY;
    if (value) return value;
  }
  return undefined;
}

/** Minimal `.env` parser: `KEY=value`, optional `export`, quotes, and `#` comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(["'`])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

export const MISSING_KEY_MESSAGE = (root: string) =>
  `React Detective needs an Anthropic API key to write new explanations and answers.\n\nAdd this line to .env.local in ${root} (create the file if needed, and make sure it's in .gitignore):\n\nANTHROPIC_API_KEY=sk-ant-...\n\nGet a key at https://console.anthropic.com/settings/keys. No restart needed: just try again. Saved explanations and answers keep working without a key.`;

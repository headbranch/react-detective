import { test } from "node:test";
import assert from "node:assert/strict";
import { addGitIgnore, addToApp, addToLayout, addVitePlugin, isGitIgnored, setEnvVar, wrapNextConfig, type EditResult } from "../src/init/edits.ts";

const code = (r: EditResult) => {
  assert.equal(r.status, "changed", r.status === "manual" ? r.reason : r.status);
  return (r as { code: string }).code;
};

// --- Vite -------------------------------------------------------------------

test("vite: adds the import and puts detective() first in plugins", () => {
  const out = code(addVitePlugin(`import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`, "vite.config.ts"));
  assert.equal(
    out,
    `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport detective from "react-detective/vite";\n\nexport default defineConfig({\n  plugins: [detective(), react()],\n});\n`,
  );
});

test("vite: keeps one plugin per line in multi-line arrays", () => {
  const out = code(addVitePlugin(`export default defineConfig({\n  plugins: [\n    react(),\n    tsconfigPaths(),\n  ],\n});\n`, "vite.config.ts"));
  assert.match(out, /plugins: \[\n    detective\(\),\n    react\(\),\n    tsconfigPaths\(\),\n  \]/);
});

test("vite: passes a non-default model", () => {
  assert.match(code(addVitePlugin(`export default { plugins: [react()] };`, "vite.config.js", { model: "opus" })), /plugins: \[detective\(\{ model: "opus" \}\), react\(\)\]/);
  assert.match(code(addVitePlugin(`export default { plugins: [react()] };`, "vite.config.js", { model: "sonnet" })), /detective\(\), react/);
});

test("vite: finds the config through functions and variables", () => {
  assert.match(code(addVitePlugin(`export default defineConfig(({ mode }) => ({ plugins: [react()] }));`, "vite.config.ts")), /\[detective\(\), react\(\)\]/);
  assert.match(code(addVitePlugin(`export default defineConfig(async ({ mode }) => {\n  const x = 1;\n  return { plugins: [react()] };\n});`, "vite.config.ts")), /\[detective\(\), react\(\)\]/);
  assert.match(code(addVitePlugin(`const config = defineConfig({ plugins: [react()] });\nexport default config;`, "vite.config.ts")), /\[detective\(\), react\(\)\]/);
  assert.match(code(addVitePlugin(`export default { plugins: [react()] } satisfies UserConfig;`, "vite.config.ts")), /\[detective\(\), react\(\)\]/);
});

test("vite: adds a plugins array when there isn't one", () => {
  assert.match(code(addVitePlugin(`export default defineConfig({\n  server: { port: 3000 },\n});`, "vite.config.ts")), /\{\n  plugins: \[detective\(\)\],\n  server/);
  assert.match(code(addVitePlugin(`export default defineConfig({});`, "vite.config.ts")), /\{ plugins: \[detective\(\)\] \}/);
});

test("vite: avoids clashing with an existing `detective` name", () => {
  const out = code(addVitePlugin(`import detective from "./detective";\nexport default { plugins: [detective()] };`, "vite.config.js"));
  assert.match(out, /import reactDetective from "react-detective\/vite"/);
  assert.match(out, /\[reactDetective\(\), detective\(\)\]/);
});

test("vite: already set up / can't edit safely", () => {
  assert.equal(addVitePlugin(`import detective from "react-detective/vite";`, "vite.config.ts").status, "already");
  assert.equal(addVitePlugin(`export default defineConfig({ plugins: getPlugins() });`, "vite.config.ts").status, "manual");
  assert.equal(addVitePlugin(`export default makeConfig();`, "vite.config.ts").status, "manual");
  assert.equal(addVitePlugin(`export default {`, "vite.config.ts").status, "manual");
});

// --- Next.js config ---------------------------------------------------------

test("next config: wraps an ESM default export", () => {
  const out = code(wrapNextConfig(`/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`, "next.config.mjs"));
  assert.equal(out, `import { withDetective } from "react-detective/next";\n/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default withDetective(nextConfig);\n`);
});

test("next config: wraps after the last import, with options", () => {
  const out = code(wrapNextConfig(`import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`, "next.config.ts", { model: "haiku" }));
  assert.match(out, /^import type \{ NextConfig \} from "next";\nimport \{ withDetective \} from "react-detective\/next";\n/);
  assert.match(out, /export default withDetective\(nextConfig, \{ model: "haiku" \}\);/);
});

test("next config: wraps other wrappers and function configs", () => {
  assert.match(code(wrapNextConfig(`export default withMDX(nextConfig);`, "next.config.mjs")), /export default withDetective\(withMDX\(nextConfig\)\);/);
  assert.match(code(wrapNextConfig(`export default (phase) => ({ reactStrictMode: true });`, "next.config.mjs")), /export default withDetective\(\(phase\) => \(\{ reactStrictMode: true \}\)\);/);
  assert.match(code(wrapNextConfig(`export default function config(phase) {\n  return {};\n}`, "next.config.mjs")), /export default withDetective\(function config\(phase\) \{\n  return \{\};\n\}\)/);
});

test("next config: wraps CommonJS module.exports", () => {
  const out = code(wrapNextConfig(`/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nmodule.exports = nextConfig;\n`, "next.config.js"));
  assert.match(out, /^const \{ withDetective \} = require\("react-detective\/next"\);\n/);
  assert.match(out, /module\.exports = withDetective\(nextConfig\);/);
});

test("next config: already set up / can't edit safely", () => {
  assert.equal(wrapNextConfig(`import { withDetective } from "react-detective/next";`, "next.config.mjs").status, "already");
  assert.equal(wrapNextConfig(`export const config = {};`, "next.config.mjs").status, "manual");
});

// --- Next.js layout and _app ------------------------------------------------

test("layout: adds <Detective /> as the last child of <body>, matching indentation", () => {
  const out = code(
    addToLayout(
      `import "./globals.css";\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n`,
      "app/layout.tsx",
    ),
  );
  assert.equal(
    out,
    `import "./globals.css";\nimport { Detective } from "react-detective/react";\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Detective />\n      </body>\n    </html>\n  );\n}\n`,
  );
});

test("layout: single-line body", () => {
  assert.match(code(addToLayout(`export default function L({ children }) { return <html><body className="x">{children}</body></html>; }`, "app/layout.jsx")), /<body className="x">\{children\}<Detective \/><\/body>/);
});

test("layout: already set up / no body", () => {
  assert.equal(addToLayout(`import { Detective } from "react-detective/react";`, "app/layout.tsx").status, "already");
  assert.equal(addToLayout(`export default function L({ children }) { return <Shell>{children}</Shell>; }`, "app/layout.tsx").status, "manual");
});

test("_app: wraps a single root element in a fragment", () => {
  const out = code(addToApp(`import type { AppProps } from "next/app";\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />;\n}\n`, "pages/_app.tsx"));
  assert.match(out, /import \{ Detective \} from "react-detective\/react";/);
  assert.match(out, /return <><Component \{\.\.\.pageProps\} \/><Detective \/><\/>;/);
});

test("_app: adds to an existing fragment, and follows a named default export", () => {
  const out = code(addToApp(`const MyApp = ({ Component, pageProps }) => (\n  <>\n    <Component {...pageProps} />\n  </>\n);\nexport default MyApp;\n`, "pages/_app.jsx"));
  assert.match(out, /<Component \{\.\.\.pageProps\} \/>\n    <Detective \/>\n  <\/>/);
});

test("_app: can't edit safely", () => {
  assert.equal(addToApp(`export default withThing(App);`, "pages/_app.tsx").status, "manual");
});

// --- Env and .gitignore -----------------------------------------------------

test("setEnvVar adds or replaces a key", () => {
  assert.equal(setEnvVar("", "ANTHROPIC_API_KEY", "sk-ant-1"), "ANTHROPIC_API_KEY=sk-ant-1\n");
  assert.equal(setEnvVar("FOO=1", "ANTHROPIC_API_KEY", "sk-ant-1"), "FOO=1\nANTHROPIC_API_KEY=sk-ant-1\n");
  assert.equal(setEnvVar("FOO=1\nANTHROPIC_API_KEY=\nBAR=2\n", "ANTHROPIC_API_KEY", "sk-ant-1"), "FOO=1\nANTHROPIC_API_KEY=sk-ant-1\nBAR=2\n");
  assert.equal(setEnvVar("export ANTHROPIC_API_KEY=old\n", "ANTHROPIC_API_KEY", "new"), "ANTHROPIC_API_KEY=new\n");
});

test("isGitIgnored understands common env patterns", () => {
  assert.equal(isGitIgnored("node_modules\n.env*\n!.env.example\n", ".env.local"), true);
  assert.equal(isGitIgnored(".env*.local\n", ".env.local"), true);
  assert.equal(isGitIgnored("/.env.local\n", ".env.local"), true);
  assert.equal(isGitIgnored("*.local\n", ".env.local"), true);
  assert.equal(isGitIgnored(".env\n", ".env.local"), false);
  assert.equal(isGitIgnored(".env*\n!.env.local\n", ".env.local"), false);
  assert.equal(isGitIgnored("# .env.local\n", ".env.local"), false);
  assert.equal(isGitIgnored("", ".env.local"), false);
});

test("addGitIgnore appends on its own line", () => {
  assert.equal(addGitIgnore("", ".env.local"), ".env.local\n");
  assert.equal(addGitIgnore("node_modules", ".env.local"), "node_modules\n.env.local\n");
});

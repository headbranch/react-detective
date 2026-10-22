import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDetectiveHandler, type DetectiveServerOptions } from "./handler";

type Handler = ReturnType<typeof createDetectiveHandler>;

/**
 * The request handler, picking up a rebuild of react-detective itself without restarting the dev
 * server: for working on react-detective (the package linked into a project from a local folder).
 * Restarting wouldn't help anyway, since Node keeps the first copy of an imported module.
 *
 * Installed from npm (the package sits in node_modules) it's just the handler: nothing is watched.
 * `onReload` runs once a rebuild has been picked up (the Vite plugin reloads the page with it).
 */
export function reloadingHandler(opts: DetectiveServerOptions, onReload?: () => void): Handler {
  let handler = createDetectiveHandler(opts);
  const here = fileURLToPath(import.meta.url);
  // Built into dist/ (vite.js, server.js); from source (tests), there's nothing to reload.
  if (here.split(path.sep).includes("node_modules") || path.basename(path.dirname(here)) !== "dist") return handler;

  const entry = path.join(path.dirname(here), "server.js");
  const mtime = () => {
    try {
      return fs.statSync(entry).mtimeMs;
    } catch {
      return 0; // mid-build: dist/ is cleared first
    }
  };
  let loaded = mtime();
  let seen = loaded;
  // Polled, not watched: the build deletes and recreates dist/, which ends a file watcher.
  const timer = setInterval(async () => {
    const now = mtime();
    // Reload once a new build has stopped changing (seen twice in a row).
    if (!now || now === loaded || now !== seen) return void (seen = now);
    loaded = now;
    try {
      const mod = await import(`${pathToFileURL(entry).href}?t=${now}`);
      handler = mod.createDetectiveHandler(opts);
      console.log("[react-detective] rebuilt: reloaded the server code");
      onReload?.();
    } catch (err) {
      console.warn("[react-detective] couldn't reload the rebuilt server code:", err);
    }
  }, 1000);
  timer.unref();

  return ((req: IncomingMessage, res: ServerResponse, next?: () => void) => handler(req, res, next)) as Handler;
}

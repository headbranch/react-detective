import http from "node:http";
import type { DetectiveServerOptions } from "./handler";
import { reloadingHandler } from "./reload";

export { createDetectiveHandler, type DetectiveServerOptions } from "./handler";
export { explainComponent, type ExplainRequest } from "./explain";

export const DEFAULT_PORT = 5899;

/**
 * Starts the explain server on 127.0.0.1. Resolves to `null` (without throwing)
 * if the port is already taken, which happens when frameworks evaluate their
 * config in several processes. The first one wins and the others reuse it.
 */
export function startDetectiveServer(opts: DetectiveServerOptions & { port?: number; silent?: boolean }): Promise<http.Server | null> {
  const port = opts.port ?? DEFAULT_PORT;
  const handler = reloadingHandler(opts);
  const server = http.createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(null) : reject(err)));
    server.listen(port, "127.0.0.1", () => {
      server.unref();
      if (!opts.silent) console.log(`[react-detective] explain server on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

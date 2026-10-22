import type { Plugin } from "vite";
import { reloadingHandler } from "./server/reload";
import { transformJsx } from "./transform";

export interface DetectiveViteOptions {
  /** Model for explanations: an alias (`"sonnet"`, `"haiku"`, `"opus"`) or a full model ID. Default `"sonnet"`. */
  model?: string;
  maxTurns?: number;
  /** Knowledge folder inside the project root. Default `.react-detective`. */
  storeDir?: string;
  /** Inject the overlay into index.html automatically. Default true. */
  injectClient?: boolean;
  /** Show the Detective badge in the corner. Default true. */
  showLauncher?: boolean;
}

const VIRTUAL_ID = "virtual:react-detective";
const BASE = "/__detective";

/** Vite plugin: dev-only. Production builds are left completely untouched. */
export default function detective(options: DetectiveViteOptions = {}): Plugin {
  let root = process.cwd();
  return {
    name: "react-detective",
    apply: "serve",
    // Run before @vitejs/plugin-react so we see the original JSX.
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      return transformJsx(code, id, root);
    },
    configureServer(server) {
      const opts = { root, model: options.model, maxTurns: options.maxTurns, storeDir: options.storeDir, base: BASE };
      // After a rebuild of react-detective (when working on it), reload the page too: Vite may have
      // reloaded it mid-build, while the overlay's file was briefly gone.
      server.middlewares.use(reloadingHandler(opts, () => server.ws.send({ type: "full-reload" })));
    },
    resolveId(id) {
      if (id === VIRTUAL_ID || id === `/@id/${VIRTUAL_ID}`) return "\0" + VIRTUAL_ID;
    },
    load(id) {
      if (id === "\0" + VIRTUAL_ID) return `import { init } from "react-detective/client";\ninit({ endpoint: ${JSON.stringify(BASE)}, showLauncher: ${options.showLauncher !== false} });`;
    },
    transformIndexHtml() {
      if (options.injectClient === false) return;
      return [{ tag: "script", attrs: { type: "module", src: `/@id/${VIRTUAL_ID}` }, injectTo: "body" }];
    },
  };
}

export { detective };

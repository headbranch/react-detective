import { createRequire } from "node:module";
import path from "node:path";

export interface DetectiveNextOptions {
  /** Port for the local explain server. Default 5899. */
  port?: number;
  /** Model for explanations: an alias (`"sonnet"`, `"haiku"`, `"opus"`) or a full model ID. Default `"sonnet"`. */
  model?: string;
  maxTurns?: number;
  /** Knowledge folder inside the project root. Default `.react-detective`. */
  storeDir?: string;
  /** Show the Detective badge in the corner. Default true. */
  showLauncher?: boolean;
}

type NextConfig = Record<string, any>;
type NextConfigInput = NextConfig | ((phase: string, ctx: any) => NextConfig | Promise<NextConfig>);

/** Must match DEFAULT_PORT in ./server (not imported here, so the server stays out of the config bundle). */
const DEFAULT_PORT = 5899;
const PHASE_DEVELOPMENT_SERVER = "phase-development-server";
const JSX_FILES = ["*.jsx", "*.tsx", "*.js"];

/**
 * Wraps your Next.js config. In `next dev` it:
 *  - adds a loader (webpack and Turbopack) that tags DOM elements with their source location
 *  - starts the local explain server on 127.0.0.1
 * In every other phase (build, start) your config is returned untouched.
 */
export function withDetective(nextConfig: NextConfigInput = {}, options: DetectiveNextOptions = {}) {
  return async (phase: string, ctx: any): Promise<NextConfig> => {
    const config: NextConfig = typeof nextConfig === "function" ? await nextConfig(phase, ctx) : { ...nextConfig };
    if (phase !== PHASE_DEVELOPMENT_SERVER) return config;

    const root = process.cwd();
    const loader = resolveLoader();
    const loaderEntry = { loader, options: { root } };

    // Turbopack (default dev bundler since Next 15)
    const turbopack = config.turbopack ?? {};
    const rules = { ...(turbopack.rules ?? {}) };
    for (const glob of JSX_FILES) {
      if (rules[glob]) continue; // never clobber a user's own rule
      rules[glob] = { condition: { not: "foreign" }, loaders: [loaderEntry] };
    }
    config.turbopack = { ...turbopack, rules };

    // webpack (`next dev --webpack`, older Next versions)
    const userWebpack = config.webpack;
    config.webpack = (wpConfig: any, wpCtx: any) => {
      const out = userWebpack ? userWebpack(wpConfig, wpCtx) : wpConfig;
      out.module.rules.unshift({
        test: /\.[cm]?[jt]sx?$/,
        exclude: /node_modules/,
        enforce: "pre",
        use: [loaderEntry],
      });
      return out;
    };

    // <Detective /> reads these at build time (Next inlines `env` into the client bundle), so it needs no props.
    const port = options.port ?? DEFAULT_PORT;
    config.env = {
      ...config.env,
      REACT_DETECTIVE_PORT: String(port),
      REACT_DETECTIVE_LAUNCHER: options.showLauncher === false ? "0" : "1",
    };

    // Imported lazily by package name so the Agent SDK is only loaded in dev.
    const { startDetectiveServer } = await import("react-detective/server");
    await startDetectiveServer({ root, port, model: options.model, maxTurns: options.maxTurns, storeDir: options.storeDir });
    return config;
  };
}

function resolveLoader(): string {
  try {
    return createRequire(path.join(process.cwd(), "package.json")).resolve("react-detective/next/loader");
  } catch {
    return createRequire(import.meta.url).resolve("react-detective/next/loader");
  }
}

export default withDetective;

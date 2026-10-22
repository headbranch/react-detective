import { transformJsx } from "./transform";

/**
 * webpack / Turbopack loader used by `withDetective` in Next.js dev.
 * Kept free of any server dependencies so it stays cheap to load in every worker.
 */
export default function detectiveLoader(this: any, source: string, inputMap?: any) {
  const opts = (this.getOptions?.() ?? {}) as { root?: string };
  const root = opts.root ?? this.rootContext ?? process.cwd();
  const result = transformJsx(source, this.resourcePath, root);
  if (!result) return this.callback(null, source, inputMap);
  this.callback(null, result.code, result.map);
}

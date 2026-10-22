import { useEffect } from "react";

/**
 * Mounts the inspector overlay. Renders nothing and loads nothing outside
 * development, so it is safe to leave in your root layout. It takes no props:
 * the port and badge setting come from `withDetective(config, options)`.
 *
 *   // app/layout.tsx
 *   <body>{children}<Detective /></body>
 */
export function Detective() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    // Inlined at build time by Next from the `env` that withDetective sets.
    const port = process.env.REACT_DETECTIVE_PORT || "5899";
    const showLauncher = process.env.REACT_DETECTIVE_LAUNCHER !== "0";
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    import("react-detective/client").then(({ init }) => {
      if (!cancelled) cleanup = init({ endpoint: `http://127.0.0.1:${port}/__detective`, showLauncher });
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return null;
}

export default Detective;

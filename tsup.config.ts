import { defineConfig } from "tsup";

const external = ["react-detective/client", "react-detective/server", "react-detective/next/loader", "vite", "next", "react"];

export default defineConfig([
  {
    entry: { vite: "src/vite.ts", server: "src/server/index.ts", client: "src/client/index.ts", cli: "src/cli.ts" },
    format: ["esm"],
    dts: { entry: { vite: "src/vite.ts", server: "src/server/index.ts", client: "src/client/index.ts" } },
    target: "node18",
    external,
  },
  {
    entry: { next: "src/next.ts", loader: "src/loader.ts" },
    format: ["esm", "cjs"],
    dts: { entry: { next: "src/next.ts" } },
    target: "node18",
    shims: true,
    cjsInterop: true,
    splitting: true,
    external,
  },
  {
    entry: { react: "src/react.tsx" },
    format: ["esm"],
    dts: true,
    external,
    banner: { js: '"use client";' },
  },
]);

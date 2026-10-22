#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_PORT, startDetectiveServer } from "./server";

if (process.argv[2] === "init") {
  const { runInit } = await import("./init");
  await runInit(process.argv.slice(3));
  process.exit();
}

// Standalone explain server for setups without a plugin (CRA, Remix, Rsbuild…).
const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p" },
    root: { type: "string", short: "r" },
    model: { type: "string", short: "m" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: react-detective init               set up React Detective in this project
       react-detective [--port ${DEFAULT_PORT}] [--root .] [--model sonnet|haiku|opus|<id>]`);
  process.exit(0);
}

const port = values.port ? Number(values.port) : DEFAULT_PORT;
const server = await startDetectiveServer({ root: values.root ?? process.cwd(), port, model: values.model });
if (!server) {
  console.error(`[react-detective] port ${port} is already in use`);
  process.exit(1);
}
server.ref();

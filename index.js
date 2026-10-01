#!/usr/bin/env node
import { runCli } from "./src/cli.js";

runCli().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});

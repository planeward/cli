#!/usr/bin/env node
import { main } from "./commands/main";

process.exitCode = await main(process.argv.slice(2));
// Let pending output drain, but don't wait on stray timers (for example
// app.installed still polling for an app that never came up).
setTimeout(() => process.exit(), 500).unref();

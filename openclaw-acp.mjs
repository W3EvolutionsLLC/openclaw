#!/usr/bin/env node

process.argv.splice(2, 0, "acp", "native");
await import("./openclaw.mjs");

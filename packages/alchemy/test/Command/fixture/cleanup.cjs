"use strict";

const fs = require("node:fs");

const file = process.env.CLEANUP_FILE;
const marker = process.env.MARKER ?? "cleanup";

if (!file) {
  console.error("cleanup.cjs: CLEANUP_FILE env var is required");
  process.exit(1);
}

fs.writeFileSync(file, JSON.stringify({ pid: process.pid, marker }));

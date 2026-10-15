#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { runCli } = require('./release-core');

runCli({
  argv: process.argv,
  environment: process.env,
  repositoryDirectory: process.cwd(),
  spawnSync,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => console.log(`${new Date().toTimeString().slice(0, 8)} ${message}`),
}).catch((error) => {
  console.error(`Release stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

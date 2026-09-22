#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const COMMANDS = new Set([
  'run-tests',
  'check-test-receipt',
  'record-test-receipt',
  'checkpoint-codex-changes',
  'checkpoint-codex-stop',
  'cleanup-ended-session',
  'cleanup-merged-branches',
]);

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!COMMANDS.has(command)) {
    throw new Error(`unknown reusable script: ${command || '(none)'}`);
  }
  const script = path.resolve(__dirname, '..', 'scripts', `${command}.js`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

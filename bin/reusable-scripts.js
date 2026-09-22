#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const COMMANDS = new Map([
  ['run-tests', 'Run configured tests, reusing a valid test receipt.'],
  ['check-test-receipt', 'Check whether a valid test receipt exists.'],
  ['record-test-receipt', 'Record a test receipt without running tests.'],
  ['checkpoint-codex-changes', 'Commit a linked worktree and push an existing remote branch.'],
  ['checkpoint-codex-stop', 'Handle the Codex Stop hook and request a checkpoint if needed.'],
  ['cleanup-ended-session', 'Queue cleanup for a merged Codex session worktree.'],
  ['cleanup-merged-branches', 'Preview or delete merged worktrees and branches.'],
]);

function helpText() {
  const width = Math.max(...[...COMMANDS.keys()].map((command) => command.length));
  const commands = [...COMMANDS]
    .map(([command, description]) => `  ${command.padEnd(width)}  ${description}`)
    .join('\n');
  return `Usage: reusable-scripts <command> [arguments]\n\nCommands:\n${commands}\n\nOptions:\n  -h, --help  Show this help.\n`;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return;
  }
  if (!COMMANDS.has(command)) {
    const detail = command ? `Unknown command: ${command}` : 'A command is required.';
    process.stderr.write(`${detail}\n\n${helpText()}`);
    process.exitCode = 2;
    return;
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

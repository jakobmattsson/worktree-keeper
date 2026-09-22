#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { checkReceipt, successMessage } = require('./check-test-receipt');
const { recordReceipt } = require('./record-test-receipt');
const { projectConfig } = require('./project-config');

function run(command, root) {
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function hasReusableReceipt() {
  try {
    return checkReceipt();
  } catch (error) {
    console.error(error.message);
    return false;
  }
}

function main() {
  const config = projectConfig();
  const force = process.argv.length === 3 && ['rerun', '--force'].includes(process.argv[2]);
  if (process.argv.length !== 2 && !force) {
    console.error('Usage: node scripts/run-tests.js [rerun|--force]');
    process.exitCode = 2;
    return;
  }
  if (!force && !process.env.CI && hasReusableReceipt()) {
    console.log(successMessage(config.root));
    return;
  }
  for (const command of config.tests.commands) {
    const status = run(command, config.root);
    if (status !== 0) {
      process.exitCode = status;
      return;
    }
  }
  recordReceipt();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

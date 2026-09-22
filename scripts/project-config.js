const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'reusable-scripts.config.json';

function repositoryRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function projectConfig(cwd = process.cwd()) {
  const root = repositoryRoot(cwd);
  const file = path.join(root, CONFIG_FILE);
  const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const config = {
    root,
    git: {
      remote: local.git?.remote || 'origin',
      defaultBranch: local.git?.defaultBranch || 'main',
      branchPrefix: local.git?.branchPrefix || 'codex/',
    },
    tests: {
      commands: local.tests?.commands || ['npm run lint', 'node --test'],
      excludedPaths: local.tests?.excludedPaths || [],
      receiptMaxAgeMinutes: local.tests?.receiptMaxAgeMinutes ?? 60,
      rerunCommand: local.tests?.rerunCommand || 'npm test -- rerun',
    },
    loggingDirectory: local.loggingDirectory || 'tmp/logs',
  };

  if (!Array.isArray(config.tests.commands) || config.tests.commands.some(
    (command) => typeof command !== 'string' || command.trim() === '',
  )) {
    throw new Error(`${file}: tests.commands must be an array of nonempty command strings`);
  }
  if (!Array.isArray(config.tests.excludedPaths) || config.tests.excludedPaths.some(
    (prefix) => typeof prefix !== 'string',
  )) {
    throw new Error(`${file}: tests.excludedPaths must be an array of strings`);
  }
  if (!Number.isSafeInteger(config.tests.receiptMaxAgeMinutes)
      || config.tests.receiptMaxAgeMinutes < 1) {
    throw new Error(`${file}: tests.receiptMaxAgeMinutes must be a positive integer`);
  }
  return config;
}

module.exports = { CONFIG_FILE, projectConfig, repositoryRoot };

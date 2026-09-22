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
      mainBranch: local.git?.mainBranch || 'main',
      taskBranchPrefix: local.git?.taskBranchPrefix || 'codex/',
    },
    tests: {
      commands: local.tests?.commands || [
        ['npm', 'run', 'lint'],
        [process.execPath, '--test'],
      ],
      excludedPaths: local.tests?.excludedPaths || [],
      receiptMaxAgeMs: local.tests?.receiptMaxAgeMs || 60 * 60 * 1000,
      receiptDirectory: local.tests?.receiptDirectory || 'reusable-scripts-test-receipts',
      rerunCommand: local.tests?.rerunCommand || 'npm test -- rerun',
    },
    logging: {
      directory: local.logging?.directory || 'tmp/logs',
    },
  };

  if (!Array.isArray(config.tests.commands) || config.tests.commands.some(
    (command) => !Array.isArray(command) || command.length === 0
      || command.some((argument) => typeof argument !== 'string'),
  )) {
    throw new Error(`${file}: tests.commands must be an array of nonempty string arrays`);
  }
  if (!Array.isArray(config.tests.excludedPaths) || config.tests.excludedPaths.some(
    (prefix) => typeof prefix !== 'string',
  )) {
    throw new Error(`${file}: tests.excludedPaths must be an array of strings`);
  }
  return config;
}

module.exports = { CONFIG_FILE, projectConfig, repositoryRoot };

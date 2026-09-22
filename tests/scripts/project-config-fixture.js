const fs = require('node:fs');
const path = require('node:path');

function writeProjectConfig(root, overrides = {}) {
  const config = {
    git: {
      remote: 'origin',
      defaultBranch: 'main',
      branchPrefix: 'codex/',
      ...overrides.git,
    },
    tests: {
      commands: ['npm run lint', 'node --test'],
      receiptMaxAgeMinutes: 60,
      npmTestUsesRunner: false,
      ...overrides.tests,
    },
    loggingDirectory: overrides.loggingDirectory ?? 'tmp/logs',
  };
  fs.writeFileSync(path.join(root, 'worktree-keeper.config.json'), JSON.stringify(config));
  return config;
}

module.exports = { writeProjectConfig };

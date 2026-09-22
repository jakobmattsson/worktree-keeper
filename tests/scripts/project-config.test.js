const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectConfig } = require('../../scripts/project-config');
const { writeProjectConfig } = require('./project-config-fixture');

function createRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

test('project config uses defaults when no file exists and accepts a complete file', (t) => {
  const root = createRepository(t);
  const defaults = projectConfig(root);
  assert.deepEqual(Object.keys(defaults).sort(), ['git', 'loggingDirectory', 'root', 'tests']);
  assert.deepEqual(Object.keys(defaults.tests).sort(), [
    'commands', 'npmTestUsesRunner', 'receiptMaxAgeMinutes',
  ]);

  const fileConfig = writeProjectConfig(root, {
    git: { remote: 'upstream' },
    tests: { commands: ['node --test'], npmTestUsesRunner: true },
  });
  assert.deepEqual(projectConfig(root), { root: fs.realpathSync(root), ...fileConfig });
});

test('project config rejects missing, unknown, and invalid fields', (t) => {
  const root = createRepository(t);
  const valid = writeProjectConfig(root);
  const file = path.join(root, 'worktree-keeper.config.json');
  function rejects(config, message) {
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => projectConfig(root), message);
  }

  rejects({ ...valid, extra: true }, /unknown field config.extra/);
  rejects({ ...valid, tests: { ...valid.tests, excludedPaths: [] } }, /unknown field tests.excludedPaths/);
  rejects({ ...valid, git: { defaultBranch: 'main', branchPrefix: 'codex/' } }, /missing field git.remote/);
  rejects({ ...valid, tests: { commands: ['node --test'], npmTestUsesRunner: false } },
    /missing field tests.receiptMaxAgeMinutes/);
  rejects({ ...valid, tests: { ...valid.tests, commands: [] } },
    /tests.commands must be a nonempty array/);
});

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

test('project config requires a file and accepts a complete file', (t) => {
  const root = createRepository(t);
  assert.throws(
    () => projectConfig(root),
    /configuration file is required; define tests\.commands explicitly/,
  );

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

test('project config accepts optional checkpoint remotes and rejects invalid lists', (t) => {
  const root = createRepository(t);
  for (const remotes of [[], ['origin'], ['origin', 'backup']]) {
    const config = writeProjectConfig(root, { git: { checkpointPushRemotes: remotes } });
    assert.deepEqual(projectConfig(root), { root: fs.realpathSync(root), ...config });
  }
  for (const remotes of [null, 'origin', [1], [''], [' origin'], ['-all'], ['origin', 'origin']]) {
    writeProjectConfig(root, { git: { checkpointPushRemotes: remotes } });
    assert.throws(() => projectConfig(root), /git.checkpointPushRemotes must be an array of unique remote names/);
  }
});

test('project config validates the optional release merge preference', (t) => {
  const root = createRepository(t);
  for (const method of ['merge', 'squash', 'rebase']) {
    writeProjectConfig(root, { git: { releaseMergeMethod: method } });
    assert.equal(projectConfig(root).git.releaseMergeMethod, method);
  }
  for (const method of [null, '', 'merge-commit', true]) {
    writeProjectConfig(root, { git: { releaseMergeMethod: method } });
    assert.throws(() => projectConfig(root), /git.releaseMergeMethod must be merge, squash, or rebase/);
  }
});

test('project config validates required release check names', (t) => {
  const root = createRepository(t);
  writeProjectConfig(root, { git: { releaseRequiredChecks: ['test', 'Test package'] } });
  assert.deepEqual(projectConfig(root).git.releaseRequiredChecks, ['test', 'Test package']);
  for (const checks of [[], null, 'test', [''], [' test'], [1], ['test', 'test']]) {
    writeProjectConfig(root, { git: { releaseRequiredChecks: checks } });
    assert.throws(() => projectConfig(root), /releaseRequiredChecks must be a nonempty array of unique check names/);
  }
});

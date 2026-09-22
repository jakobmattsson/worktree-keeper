const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeProjectConfig } = require('./project-config-fixture');

const script = path.resolve(__dirname, '../../scripts/cleanup-merged-branches.js');
const { applyPlan, buildPlan } = require(script);

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function refExists(cwd, refName) {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', refName], {
    cwd,
  }).status === 0;
}

function createRepository(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-branches-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const remote = path.join(fixtureRoot, 'remote.git');
  const repository = path.join(fixtureRoot, 'repository');
  const worktree = path.join(fixtureRoot, 'feature-worktree');

  git(fixtureRoot, 'init', '--bare', remote);
  fs.mkdirSync(repository);
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'Test User');
  git(repository, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repository, 'file.txt'), 'main\n');
  git(repository, 'add', 'file.txt');
  git(repository, 'commit', '-m', 'Initial commit');
  git(repository, 'remote', 'add', 'origin', remote);
  git(repository, 'push', '-u', 'origin', 'main');

  git(repository, 'switch', '-c', 'merged-feature');
  fs.writeFileSync(path.join(repository, 'feature.txt'), 'feature\n');
  git(repository, 'add', 'feature.txt');
  git(repository, 'commit', '-m', 'Add feature');
  git(repository, 'push', '-u', 'origin', 'merged-feature');
  git(repository, 'switch', 'main');
  git(repository, 'merge', '--ff-only', 'merged-feature');
  git(repository, 'push', 'origin', 'main');
  git(repository, 'worktree', 'add', worktree, 'merged-feature');

  return { remote, repository, worktree };
}

function runScript(repository, ...args) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
  });
}

test('dry-run is the default and does not remove anything', (t) => {
  const fixture = createRepository(t);
  const expectedOriginMain = git(fixture.repository, 'rev-parse', 'origin/main');
  git(fixture.repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');

  const output = runScript(fixture.repository);

  assert.match(output, /Dry-run mode/);
  assert.match(output, /Fetching and pruning origin/);
  assert.match(output, /Would remove worktree .*feature-worktree/);
  assert.match(output, /Would delete local branch merged-feature/);
  assert.match(output, /Would delete remote branch origin\/merged-feature/);
  assert.match(output, /To apply this cleanup, run:\n {2}npm exec --no -- reusable-scripts cleanup-merged-branches --execute/);
  assert.equal(fs.existsSync(fixture.worktree), true);
  assert.equal(git(fixture.repository, 'rev-parse', 'origin/main'), expectedOriginMain);
  assert.equal(refExists(fixture.repository, 'refs/heads/merged-feature'), true);
  assert.equal(refExists(fixture.repository, 'refs/remotes/origin/merged-feature'), true);
});

test('--execute removes a clean worktree and its merged local and remote branches', (t) => {
  const fixture = createRepository(t);

  const output = runScript(fixture.repository, '--execute');

  assert.match(output, /Execute mode/);
  assert.equal(fs.existsSync(fixture.worktree), false);
  assert.equal(refExists(fixture.repository, 'refs/heads/merged-feature'), false);
  assert.equal(refExists(fixture.repository, 'refs/remotes/origin/merged-feature'), false);
  assert.equal(refExists(fixture.remote, 'refs/heads/merged-feature'), false);
});

test('--execute preserves a branch when its worktree has changes', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.worktree, 'untracked.txt'), 'keep me\n');

  const output = runScript(fixture.repository, '--execute');

  assert.match(output, /Skip merged-feature: its worktree has changes/);
  assert.equal(fs.existsSync(fixture.worktree), true);
  assert.equal(refExists(fixture.repository, 'refs/heads/merged-feature'), true);
  assert.equal(refExists(fixture.repository, 'refs/remotes/origin/merged-feature'), true);
});

test('--execute keeps a diverged local branch while deleting its merged remote branch', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.worktree, 'local-only.txt'), 'local commit\n');
  git(fixture.worktree, 'add', 'local-only.txt');
  git(fixture.worktree, 'commit', '-m', 'Continue local work');

  const output = runScript(fixture.repository, '--execute');

  assert.doesNotMatch(output, /Removing worktree/);
  assert.doesNotMatch(output, /Deleting local branch/);
  assert.match(output, /Deleting remote branch origin\/merged-feature/);
  assert.equal(fs.existsSync(fixture.worktree), true);
  assert.equal(refExists(fixture.repository, 'refs/heads/merged-feature'), true);
  assert.equal(refExists(fixture.repository, 'refs/remotes/origin/merged-feature'), false);
});

test('--execute deletes a merged local branch from an unrelated current branch', (t) => {
  const fixture = createRepository(t);
  git(fixture.repository, 'worktree', 'remove', fixture.worktree);
  git(fixture.remote, 'update-ref', '-d', 'refs/heads/merged-feature');
  git(fixture.repository, 'fetch', '--prune', 'origin');
  git(fixture.repository, 'switch', '--create', 'unrelated', 'HEAD~1');
  fs.writeFileSync(path.join(fixture.repository, 'unrelated.txt'), 'unrelated\n');
  git(fixture.repository, 'add', 'unrelated.txt');
  git(fixture.repository, 'commit', '-m', 'Add unrelated commit');

  const output = runScript(fixture.repository, '--execute');

  assert.match(output, /Deleting local branch merged-feature/);
  assert.equal(refExists(fixture.repository, 'refs/heads/merged-feature'), false);
});

test('remote deletion stops when the remote branch changed after planning', (t) => {
  const fixture = createRepository(t);
  git(fixture.repository, 'worktree', 'remove', fixture.worktree);
  git(fixture.repository, 'branch', '--delete', 'merged-feature');
  const plan = buildPlan(fixture.repository);

  git(fixture.repository, 'switch', '--create', 'remote-update', 'origin/merged-feature');
  fs.writeFileSync(path.join(fixture.repository, 'remote-update.txt'), 'new remote commit\n');
  git(fixture.repository, 'add', 'remote-update.txt');
  git(fixture.repository, 'commit', '-m', 'Update remote branch');
  git(fixture.repository, 'push', 'origin', 'HEAD:merged-feature');
  const updatedObjectId = git(fixture.repository, 'rev-parse', 'HEAD');

  assert.throws(
    () => applyPlan(fixture.repository, plan, true, () => {}),
    /failed to push some refs|stale info/,
  );
  assert.equal(
    git(fixture.remote, 'rev-parse', 'refs/heads/merged-feature'),
    updatedObjectId,
  );
});

test('branch cleanup uses the caller configured remote and default branch', (t) => {
  const fixture = createRepository(t);
  git(fixture.repository, 'remote', 'rename', 'origin', 'upstream');
  git(fixture.repository, 'branch', '-m', 'main', 'trunk');
  git(fixture.repository, 'push', 'upstream', 'trunk');
  git(fixture.repository, 'update-ref', '-d', 'refs/remotes/upstream/main');
  writeProjectConfig(fixture.repository, { git: { remote: 'upstream', defaultBranch: 'trunk' } });

  const output = runScript(fixture.repository);

  assert.match(output, /Fetching and pruning upstream/);
  assert.match(output, /Would delete remote branch upstream\/merged-feature/);
  assert.match(output, /To apply this cleanup, run:\n {2}npm exec --no -- reusable-scripts cleanup-merged-branches --execute/);
  assert.doesNotMatch(output, /delete (local|remote) branch trunk/);
});

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { captureTarget, cleanupTarget } = require('../../scripts/cleanup-ended-session.js');

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
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-session-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const remote = path.join(fixtureRoot, 'remote.git');
  const repository = path.join(fixtureRoot, 'repository');
  const mergedWorktree = path.join(fixtureRoot, 'merged-worktree');
  const newWorktree = path.join(fixtureRoot, 'new-worktree');

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
  git(repository, 'worktree', 'add', mergedWorktree, 'merged-feature');
  git(repository, 'worktree', 'add', '-b', 'new-feature', newWorktree, 'main');

  const target = captureTarget({
    cwd: mergedWorktree,
    hook_event_name: 'SessionEnd',
    session_id: 'test-session',
  });

  return { mergedWorktree, newWorktree, remote, repository, target };
}

function advanceRemoteMain(fixture) {
  const previousMain = git(fixture.repository, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(fixture.repository, 'later.txt'), 'later\n');
  git(fixture.repository, 'add', 'later.txt');
  git(fixture.repository, 'commit', '-m', 'Advance remote main');
  const remoteMain = git(fixture.repository, 'rev-parse', 'HEAD');
  git(fixture.repository, 'push', 'origin', 'main');
  git(fixture.repository, 'reset', '--hard', previousMain);
  return { previousMain, remoteMain };
}

test('targeted cleanup removes only the ended session branch and worktree', (t) => {
  const fixture = createRepository(t);
  const output = [];

  const removed = cleanupTarget(fixture.target, (line) => output.push(line));

  assert.equal(removed, true);
  assert.equal(fs.existsSync(fixture.mergedWorktree), false);
  assert.equal(refExists(fixture.repository, 'refs/heads/merged-feature'), false);
  assert.equal(refExists(fixture.remote, 'refs/heads/merged-feature'), false);
  assert.equal(fs.existsSync(fixture.newWorktree), true);
  assert.equal(refExists(fixture.repository, 'refs/heads/new-feature'), true);
  assert.match(output.join('\n'), /Removing worktree .*merged-worktree/);
  assert.doesNotMatch(output.join('\n'), /new-feature|new-worktree/);
});

test('targeted cleanup keeps the ended session when the branch is not merged', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.newWorktree, 'new.txt'), 'new work\n');
  git(fixture.newWorktree, 'add', 'new.txt');
  git(fixture.newWorktree, 'commit', '-m', 'Start new feature');
  const target = captureTarget({
    cwd: fixture.newWorktree,
    hook_event_name: 'SessionEnd',
    session_id: 'new-session',
  });

  const removed = cleanupTarget(target, () => {});

  assert.equal(removed, false);
  assert.equal(fs.existsSync(fixture.newWorktree), true);
  assert.equal(refExists(fixture.repository, 'refs/heads/new-feature'), true);
});

test('targeted cleanup fast-forwards clean main in the primary worktree', (t) => {
  const fixture = createRepository(t);
  const { remoteMain } = advanceRemoteMain(fixture);
  const output = [];

  const removed = cleanupTarget(fixture.target, (line) => output.push(line));

  assert.equal(removed, true);
  assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), remoteMain);
  assert.match(output.join('\n'), /Fast-forwarding main in the primary worktree/);
});

test('targeted cleanup leaves main behind when the primary worktree has changes', (t) => {
  const fixture = createRepository(t);
  const { previousMain } = advanceRemoteMain(fixture);
  fs.writeFileSync(path.join(fixture.repository, 'untracked.txt'), 'local work\n');
  const output = [];

  const removed = cleanupTarget(fixture.target, (line) => output.push(line));

  assert.equal(removed, true);
  assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), previousMain);
  assert.match(output.join('\n'), /Keep main: the primary worktree has changes/);
});

test('targeted cleanup leaves divergent main behind', (t) => {
  const fixture = createRepository(t);
  advanceRemoteMain(fixture);
  fs.writeFileSync(path.join(fixture.repository, 'local.txt'), 'local commit\n');
  git(fixture.repository, 'add', 'local.txt');
  git(fixture.repository, 'commit', '-m', 'Advance local main');
  const localMain = git(fixture.repository, 'rev-parse', 'HEAD');
  const output = [];

  const removed = cleanupTarget(fixture.target, (line) => output.push(line));

  assert.equal(removed, true);
  assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), localMain);
  assert.match(output.join('\n'), /Keep main: it cannot fast-forward/);
});

test('targeted cleanup does not move main when another branch is checked out', (t) => {
  const fixture = createRepository(t);
  const { previousMain } = advanceRemoteMain(fixture);
  git(fixture.repository, 'switch', '-c', 'primary-feature');

  const removed = cleanupTarget(fixture.target, () => {});

  assert.equal(removed, true);
  assert.equal(git(fixture.repository, 'rev-parse', 'main'), previousMain);
  assert.equal(git(fixture.repository, 'branch', '--show-current'), 'primary-feature');
});

test('capture ignores detached worktrees and the primary worktree', (t) => {
  const fixture = createRepository(t);
  git(fixture.newWorktree, 'switch', '--detach');
  git(fixture.repository, 'switch', '-c', 'primary-feature');

  assert.equal(captureTarget({
    cwd: fixture.newWorktree,
    hook_event_name: 'SessionEnd',
  }), null);
  assert.equal(captureTarget({
    cwd: fixture.repository,
    hook_event_name: 'SessionEnd',
  }), null);
});

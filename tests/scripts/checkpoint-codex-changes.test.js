const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeProjectConfig } = require('./project-config-fixture');

const {
  checkpoint,
  markerPath,
  parseArguments,
} = require('../../scripts/checkpoint-codex-changes.js');
const { buildResponse } = require('../../scripts/checkpoint-codex-stop.js');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function remoteRefExists(cwd, remote, refName) {
  return spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', refName], {
    cwd,
  }).status === 0;
}

function createRepository(t, publishBranch = false) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-checkpoint-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const remote = path.join(fixtureRoot, 'remote.git');
  const repository = path.join(fixtureRoot, 'repository');
  const worktree = path.join(fixtureRoot, 'worktree');
  git(fixtureRoot, 'init', '--bare', remote);
  fs.mkdirSync(repository);
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'Test User');
  git(repository, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repository, 'file.txt'), 'main\n');
  writeProjectConfig(repository);
  git(repository, 'add', 'file.txt', 'worktree-keeper.config.json');
  git(repository, 'commit', '-m', 'Initial commit');
  git(repository, 'remote', 'add', 'origin', remote);
  git(repository, 'push', '-u', 'origin', 'main');
  git(repository, 'switch', '-c', 'codex/test-checkpoint');
  if (publishBranch) {
    git(repository, 'push', '-u', 'origin', 'codex/test-checkpoint');
  }
  git(repository, 'switch', 'main');
  git(repository, 'worktree', 'add', worktree, 'codex/test-checkpoint');

  return { primaryRepository: repository, remote, repository: worktree };
}

test('checkpoint commits a new branch without publishing it', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.repository, 'new.txt'), 'new\n');

  const result = checkpoint(fixture.repository, {
    subject: 'Add checkpoint fixture',
    bodyParagraphs: [
      'Commit changes on a local task branch without publishing a new remote branch.',
    ],
  }, () => {});

  assert.deepEqual(result, { committed: true, pushed: false });
  assert.equal(git(fixture.repository, 'log', '-1', '--format=%s'), 'Add checkpoint fixture');
  assert.equal(
    git(fixture.repository, 'log', '-1', '--format=%b'),
    'Commit changes on a local task branch without publishing a new remote branch.',
  );
  assert.equal(git(fixture.repository, 'status', '--porcelain'), '');
  assert.equal(
    remoteRefExists(fixture.repository, fixture.remote, 'refs/heads/codex/test-checkpoint'),
    false,
  );
});

test('checkpoint pushes when the branch already exists on origin', (t) => {
  const fixture = createRepository(t, true);
  fs.writeFileSync(path.join(fixture.repository, 'new.txt'), 'new\n');

  const result = checkpoint(fixture.repository, {
    subject: 'Update published checkpoint',
    bodyParagraphs: [
      'Push the new commit because this task branch already exists on origin.',
    ],
  }, () => {});

  assert.deepEqual(result, { committed: true, pushed: true });
  assert.equal(
    git(fixture.repository, 'rev-parse', 'HEAD'),
    git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint'),
  );
});

test('Stop requests a semantic checkpoint once and then allows a clean stop', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.repository, 'new.txt'), 'new\n');

  const response = buildResponse({
    cwd: fixture.repository,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

  assert.equal(response.decision, 'block');
  assert.match(response.reason, /single-line subject/);
  assert.match(response.reason, /npm exec --no -- worktree-keeper checkpoint-codex-changes/);
  assert.match(response.reason, /between one and ten sentences/);
  assert.match(response.reason, /--subject .* --body/);
  checkpoint(fixture.repository, {
    subject: 'Add semantic checkpoint',
    bodyParagraphs: [
      'Use the agent context to provide a meaningful explanation of the completed change.',
    ],
  }, () => {});
  assert.deepEqual(buildResponse({
    cwd: fixture.repository,
    hook_event_name: 'Stop',
    stop_hook_active: true,
  }), {});
  assert.equal(fs.existsSync(markerPath(fixture.repository)), false);
});

test('checkpoint refuses the primary worktree without recording a hook failure', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.primaryRepository, 'file.txt'), 'changed\n');

  assert.throws(
    () => checkpoint(fixture.primaryRepository, {
      subject: 'Unsafe checkpoint',
      bodyParagraphs: ['Attempt to commit directly on the protected main branch.'],
    }, () => {}),
    /refusing to checkpoint the primary Git worktree/,
  );
  assert.equal(fs.existsSync(markerPath(fixture.primaryRepository)), false);
});

test('checkpoint protects the caller configured default branch', (t) => {
  const fixture = createRepository(t);
  writeProjectConfig(fixture.repository, { git: { defaultBranch: 'codex/test-checkpoint' } });

  assert.throws(
    () => checkpoint(fixture.repository, {
      subject: 'Unsafe checkpoint',
      bodyParagraphs: ['Do not commit on the configured default branch.'],
    }, () => {}),
    /refusing to checkpoint changes directly on codex\/test-checkpoint/,
  );
});

test('Stop uses the caller configured branch prefix for a detached worktree', (t) => {
  const fixture = createRepository(t);
  git(fixture.repository, 'switch', '--detach');
  writeProjectConfig(fixture.repository, { git: { branchPrefix: 'work/' } });

  const response = buildResponse({
    cwd: fixture.repository,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });

  assert.match(response.reason, /named with the work\/ prefix/);
});

test('Stop ignores changes in the primary worktree', (t) => {
  const fixture = createRepository(t);
  fs.writeFileSync(path.join(fixture.primaryRepository, 'file.txt'), 'changed\n');

  assert.deepEqual(buildResponse({
    cwd: fixture.primaryRepository,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  }), {});
});

test('checkpoint arguments require a subject and one or more body paragraphs', () => {
  assert.deepEqual(parseArguments([
    '--subject',
    'Explain checkpoint changes',
    '--body',
    'Describe what changed and why it matters.',
    '--body',
    'Include another paragraph only when it adds useful context.',
  ]), {
    subject: 'Explain checkpoint changes',
    bodyParagraphs: [
      'Describe what changed and why it matters.',
      'Include another paragraph only when it adds useful context.',
    ],
  });
  assert.throws(
    () => parseArguments(['--subject', 'Missing body']),
    /at least one non-empty commit body paragraph is required/,
  );
});

test('checkpoint publishes a new branch to multiple explicit remotes', (t) => {
  const fixture = createRepository(t);
  const backup = path.join(path.dirname(fixture.remote), 'backup.git');
  git(fixture.repository, 'init', '--bare', backup);
  git(fixture.repository, 'remote', 'add', 'backup', backup);
  writeProjectConfig(fixture.repository, {
    git: { checkpointPushRemotes: ['origin', 'backup'] },
  });
  const result = checkpoint(fixture.repository, {
    subject: 'Publish checkpoint',
    bodyParagraphs: ['Publish the new task branch to both configured remotes.'],
  }, () => {});
  assert.deepEqual(result, { committed: true, pushed: true });
  const head = git(fixture.repository, 'rev-parse', 'HEAD');
  for (const remote of [fixture.remote, backup]) {
    assert.equal(git(remote, 'rev-parse', 'refs/heads/codex/test-checkpoint'), head);
  }
  assert.equal(git(fixture.repository, 'rev-parse', '--abbrev-ref', '@{upstream}'),
    'origin/codex/test-checkpoint');
});

test('empty checkpoint remotes disable push even for a published branch', (t) => {
  const fixture = createRepository(t, true);
  const original = git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint');
  writeProjectConfig(fixture.repository, { git: { checkpointPushRemotes: [] } });
  assert.deepEqual(checkpoint(fixture.repository, {
    subject: 'Keep checkpoint local',
    bodyParagraphs: ['Disable checkpoint pushes explicitly.'],
  }, () => {}), { committed: true, pushed: false });
  assert.equal(git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint'), original);
});

test('checkpoint retries a partial push failure without another commit', (t) => {
  const fixture = createRepository(t);
  writeProjectConfig(fixture.repository, {
    git: { checkpointPushRemotes: ['origin', 'backup'] },
  });
  const message = {
    subject: 'Retry checkpoint pushes',
    bodyParagraphs: ['Keep failures visible until every configured remote accepts the checkpoint.'],
  };
  assert.throws(() => checkpoint(fixture.repository, message, () => {}),
    /checkpoint remote backup is not configured in Git/);
  const head = git(fixture.repository, 'rev-parse', 'HEAD');
  assert.equal(git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint'), head);
  assert.equal(fs.existsSync(markerPath(fixture.repository)), true);
  const backup = path.join(path.dirname(fixture.remote), 'backup.git');
  git(fixture.repository, 'init', '--bare', backup);
  git(fixture.repository, 'remote', 'add', 'backup', backup);
  assert.deepEqual(checkpoint(fixture.repository, message, () => {}),
    { committed: false, pushed: true });
  assert.equal(git(fixture.repository, 'rev-parse', 'HEAD'), head);
  assert.equal(git(backup, 'rev-parse', 'refs/heads/codex/test-checkpoint'), head);
  assert.equal(fs.existsSync(markerPath(fixture.repository)), false);
});

test('explicit checkpoint pushes refuse non-fast-forward updates', (t) => {
  const fixture = createRepository(t, true);
  writeProjectConfig(fixture.repository, { git: { checkpointPushRemotes: ['origin'] } });
  git(fixture.primaryRepository, 'switch', '-c', 'codex/remote-change');
  fs.writeFileSync(path.join(fixture.primaryRepository, 'remote.txt'), 'remote change\n');
  git(fixture.primaryRepository, 'add', 'remote.txt');
  git(fixture.primaryRepository, 'commit', '-m', 'Independent remote change');
  git(fixture.primaryRepository, 'push', 'origin', 'HEAD:refs/heads/codex/test-checkpoint');
  const remoteHead = git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint');
  assert.throws(() => checkpoint(fixture.repository, {
    subject: 'Preserve remote work',
    bodyParagraphs: ['Refuse to overwrite a diverged remote task branch.'],
  }, () => {}), /rejected|fetch first|non-fast-forward/);
  assert.equal(git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint'), remoteHead);
  assert.equal(fs.existsSync(markerPath(fixture.repository)), true);
});

test('explicit remotes replace the legacy remote push target', (t) => {
  const fixture = createRepository(t, true);
  const original = git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint');
  const backup = path.join(path.dirname(fixture.remote), 'backup.git');
  git(fixture.repository, 'init', '--bare', backup);
  git(fixture.repository, 'remote', 'add', 'backup', backup);
  writeProjectConfig(fixture.repository, { git: { checkpointPushRemotes: ['backup'] } });
  assert.deepEqual(checkpoint(fixture.repository, {
    subject: 'Push only to backup',
    bodyParagraphs: ['Use the explicit remote list instead of the default push target.'],
  }, () => {}), { committed: true, pushed: true });
  assert.equal(git(backup, 'rev-parse', 'refs/heads/codex/test-checkpoint'),
    git(fixture.repository, 'rev-parse', 'HEAD'));
  assert.equal(git(fixture.remote, 'rev-parse', 'refs/heads/codex/test-checkpoint'), original);
  assert.equal(git(fixture.repository, 'rev-parse', '--abbrev-ref', '@{upstream}'),
    'origin/codex/test-checkpoint');
});

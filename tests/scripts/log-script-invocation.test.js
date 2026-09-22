const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeProjectConfig } = require('./project-config-fixture');

const {
  isPrimaryWorktree,
  logScriptInvocation,
  shellQuote,
  sourceRepositoryRoot,
} = require('../../scripts/log-script-invocation.js');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createWorktree(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-invocation-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const repository = path.join(fixtureRoot, 'source repository');
  const worktree = path.join(fixtureRoot, 'linked worktree');
  fs.mkdirSync(repository);
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'Test User');
  git(repository, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repository, 'file.txt'), 'main\n');
  git(repository, 'add', 'file.txt');
  git(repository, 'commit', '-m', 'Initial commit');
  git(repository, 'worktree', 'add', '--detach', worktree);

  return { repository, worktree };
}

test('source repository root is the primary worktree', (t) => {
  const fixture = createWorktree(t);

  assert.equal(sourceRepositoryRoot(fixture.worktree), fs.realpathSync(fixture.repository));
  assert.equal(isPrimaryWorktree(fixture.repository), true);
  assert.equal(isPrimaryWorktree(fixture.worktree), false);
});

test('invocation log is stored in the source repository with every argument', (t) => {
  const fixture = createWorktree(t);
  writeProjectConfig(fixture.repository, { loggingDirectory: 'custom/logs' });
  const argv = [
    '/usr/local/bin/node',
    '/path with spaces/checkpoint-codex-stop.js',
    '--subject',
    "Owner's checkpoint",
  ];

  const logPath = logScriptInvocation({
    argv,
    cwd: fixture.worktree,
    date: new Date('2026-09-20T12:34:56.789Z'),
    processId: 1234,
  });

  assert.equal(
    logPath,
    path.join(
      fs.realpathSync(fixture.repository),
      'custom',
      'logs',
      '2026-09-20T12-34-56.789Z-checkpoint-codex-stop.js-1234.log',
    ),
  );
  assert.equal(fs.readFileSync(logPath, 'utf8'), `${argv.map(shellQuote).join(' ')}\n`);
});

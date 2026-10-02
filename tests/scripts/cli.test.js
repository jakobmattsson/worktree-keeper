const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const cli = path.resolve(__dirname, '../../bin/worktree-keeper.js');
const commands = [
  'run-tests',
  'check-test-receipt',
  'record-test-receipt',
  'checkpoint-codex-changes',
  'checkpoint-codex-stop',
  'cleanup-ended-session',
  'queue-merged-worktree-cleanup',
  'cleanup-merged-branches',
  'remove-empty-directories',
];

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('--help lists every command and its purpose', () => {
  const result = run('--help');

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage: worktree-keeper <command> \[arguments\]/);
  for (const command of commands) {
    assert.match(result.stdout, new RegExp(`^  ${command} +\\S`, 'm'));
  }
  assert.equal(run('-h').stdout, result.stdout);
});

test('invalid or missing commands show help and exit with a usage error', () => {
  for (const args of [['unknown-command'], []]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: worktree-keeper <command> \[arguments\]/);
    for (const command of commands) {
      assert.match(result.stderr, new RegExp(`^  ${command} +\\S`, 'm'));
    }
  }
  assert.match(run('unknown-command').stderr, /^Unknown command: unknown-command\n/);
  assert.match(run().stderr, /^A command is required\.\n/);
});

test('valid commands still receive their arguments', () => {
  const result = run('cleanup-merged-branches', '--help');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: cleanup-merged-branches\.js \[--dry-run \| --execute\]/);
  assert.doesNotMatch(result.stdout, /Commands:/);
});

test('targeted cleanup queue exposes its own help', () => {
  const result = run('queue-merged-worktree-cleanup', '--help');

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    'Usage: worktree-keeper queue-merged-worktree-cleanup\n',
  );
});

const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cli = path.resolve(__dirname, '../../bin/worktree-keeper.js');
const { classifyCommand } = require('../../scripts/install-hooks');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper hook install '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const file = path.join(root, '.codex/hooks.json');
  function write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  function run(...args) {
    return spawnSync(process.execPath, [cli, 'install-hooks', ...args], { cwd: root, encoding: 'utf8' });
  }
  return { root, file, write, run };
}

test('install-hooks previews, installs from a subdirectory, and is idempotent', (t) => {
  const f = fixture(t);
  assert.equal(f.run('--dry-run').status, 0);
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
  const sub = path.join(f.root, 'sub');
  fs.mkdirSync(sub);
  const result = spawnSync(process.execPath, [cli, 'install-hooks'], { cwd: sub, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const original = fs.readFileSync(f.file, 'utf8');
  const document = JSON.parse(original);
  const own = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../.codex/hooks.json'), 'utf8'));
  // The repository's reviewed hooks are independent of the installer definitions.
  assert.deepEqual(Object.keys(document.hooks).sort(), Object.keys(own.hooks).sort());
  for (const event of Object.keys(own.hooks)) {
    const installed = document.hooks[event][0].hooks[0];
    const expected = own.hooks[event][0].hooks[0];
    assert.deepEqual(installed, {
      ...expected,
      command: expected.command.replace('/bin/worktree-keeper.js', '/node_modules/worktree-keeper/bin/worktree-keeper.js'),
    });
  }
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('installation preserves foreign handlers and group settings and removes known duplicates', (t) => {
  const f = fixture(t);
  const foreign = { type: 'command', command: 'echo custom', timeout: 12 };
  f.write({ description: 'Keep description', extra: { keep: true }, hooks: {
    Stop: [{ matcher: 'custom', hooks: [foreign,
      { type: 'command', command: 'npm  exec --no -- worktree-keeper checkpoint-codex-stop' },
      { type: 'command', command: 'node ./scripts/checkpoint-codex-stop.js' },
    ] }],
    PostToolUse: [{ hooks: [foreign] }],
  } });
  assert.equal(f.run().status, 0);
  const document = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(document.description, 'Keep description');
  assert.deepEqual(document.extra, { keep: true });
  assert.deepEqual(document.hooks.Stop[0], { matcher: 'custom', hooks: [foreign] });
  assert.deepEqual(document.hooks.PostToolUse, [{ hooks: [foreign] }]);
  assert.equal(document.hooks.Stop.length, 2);
  assert.equal(document.hooks.Stop[1].matcher, undefined);
});

test('recognition accepts supported forms and rejects wrappers and composition', () => {
  for (const command of [
    'worktree-keeper checkpoint-codex-stop',
    'npx --no-install worktree-keeper cleanup-ended-session',
    'node "$(git rev-parse --show-toplevel)/node_modules/worktree-keeper/bin/worktree-keeper.js" checkpoint-codex-stop',
    ' node   ./bin/worktree-keeper.js   checkpoint-codex-session-start ',
  ]) assert.equal(classifyCommand(command), 'owned', command);
  for (const command of [
    'worktree-keeper checkpoint-codex-stop && echo custom',
    'echo worktree-keeper checkpoint-codex-stop',
    'node wrapper.js checkpoint-codex-stop',
    'worktree-keepercheckpoint-codex-stop',
    'worktree-keeper checkpoint-codex-stop --custom',
  ]) assert.equal(classifyCommand(command), 'ambiguous', command);
});

test('ambiguous, customized, or invalid hooks fail without any write', (t) => {
  const f = fixture(t);
  for (const document of [
    '{broken', { hooks: { Stop: 'invalid' } },
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo custom',
      commandWindows: 'worktree-keeper checkpoint-codex-stop' }] }] } },
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'worktree-keeper checkpoint-codex-stop && echo custom' }] }] } },
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'worktree-keeper checkpoint-codex-stop', async: true }] }] } },
  ]) {
    f.write(document);
    const original = fs.readFileSync(f.file, 'utf8');
    for (const args of [[], ['--dry-run']]) {
      assert.notEqual(f.run(...args).status, 0);
      assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    }
  }
});

test('preview preserves an existing file and symlinks are rejected', (t) => {
  const f = fixture(t);
  f.write({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo custom' }] }] } });
  const original = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.run('--dry-run').status, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const target = path.join(f.root, 'shared.json');
  fs.renameSync(f.file, target);
  fs.symlinkSync(target, f.file);
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

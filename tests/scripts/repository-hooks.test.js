const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const source = path.resolve(__dirname, '../..');

test('repository hooks and checkpoint resolve local source without a self dependency', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper own hooks '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = path.join(directory, 'primary');
  const linked = path.join(directory, 'linked worktree');
  const origin = path.join(directory, 'origin.git');
  fs.mkdirSync(primary);
  for (const name of ['bin', 'scripts', '.codex', 'package.json', '.gitignore', 'worktree-keeper.config.json']) {
    fs.cpSync(path.join(source, name), path.join(primary, name), { recursive: true });
  }
  function run(command, args, cwd = primary, options = {}) {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true' }, ...options,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  run('git', ['init', '--bare', origin]);
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.name', 'Test']);
  run('git', ['config', 'user.email', 'test@example.com']);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'Initial setup']);
  run('git', ['remote', 'add', 'origin', origin]);
  run('git', ['push', 'origin', 'main']);
  run('git', ['worktree', 'add', '-b', 'codex/hook-setup', linked]);
  assert.equal(fs.existsSync(path.join(linked, 'node_modules')), false);
  const hooks = JSON.parse(fs.readFileSync(path.join(linked, '.codex/hooks.json'), 'utf8'));
  function hook(event, eventCwd = linked) {
    const definition = hooks.hooks[event][0].hooks[0];
    return run('sh', ['-c', definition.command], path.join(linked, 'bin'), {
      input: JSON.stringify({ hook_event_name: event, cwd: eventCwd }),
      timeout: definition.timeout * 1000,
    });
  }
  const start = JSON.parse(hook('SessionStart'));
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(start.hookSpecificOutput.additionalContext, /Before the final response/);
  assert.match(start.hookSpecificOutput.additionalContext, /explicit user instruction not to commit or push/);
  assert.deepEqual(JSON.parse(hook('SessionStart', primary)), {});
  assert.deepEqual(JSON.parse(hook('Stop')), {});
  fs.writeFileSync(path.join(linked, 'change.txt'), 'A checkpoint\n');
  const response = JSON.parse(hook('Stop'));
  assert.equal(response.decision, 'block');
  assert.match(response.reason, /npm exec --no -- worktree-keeper checkpoint-codex-changes/);
  const npmArgs = ['exec', '--no', '--', 'worktree-keeper', 'checkpoint-codex-changes',
    '--subject', 'Checkpoint local hooks', '--body', 'Verify the local package can checkpoint itself.'];
  run(process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath ? [process.env.npm_execpath, ...npmArgs] : npmArgs, linked);
  assert.equal(run('git', ['log', '-1', '--format=%s'], linked), 'Checkpoint local hooks');
  assert.deepEqual(JSON.parse(hook('Stop')), {});
  // Exercise the real SessionEnd command without scheduling deletion of a fixture.
  assert.equal(hook('SessionEnd', primary), '');
  assert.ok(fs.readdirSync(path.join(primary, 'tmp/logs')).length >= 4);
});

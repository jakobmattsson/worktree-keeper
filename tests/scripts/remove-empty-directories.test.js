const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const {
  findEmptyDirectories,
  removeEmptyDirectories,
  run,
} = require('../../scripts/remove-empty-directories');

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-directories-'));
  execFileSync('git', ['init', '--quiet', root]);
  fs.writeFileSync(
    path.join(root, '.gitignore'),
    '.DS_Store\nignored/\nnode_modules/\ntmp/\n',
  );
  return root;
}

test('removes directories containing only ignored files', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const empty = path.join(root, 'parent', 'empty');
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, '.DS_Store'), 'metadata');

  const directories = findEmptyDirectories(root);

  assert.deepEqual(directories, ['parent']);
  removeEmptyDirectories(root, directories);
  assert.equal(fs.existsSync(path.join(root, 'parent')), false);
  assert.equal(fs.existsSync(path.join(root, '.git')), true);
});

test('keeps directories with tracked or untracked non-ignored files', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tracked'));
  fs.mkdirSync(path.join(root, 'untracked'));
  fs.mkdirSync(path.join(root, 'tracked', 'ignored'));
  fs.writeFileSync(path.join(root, 'tracked', 'file.txt'), 'tracked');
  fs.writeFileSync(path.join(root, 'untracked', 'file.txt'), 'untracked');
  fs.writeFileSync(path.join(root, 'tracked', 'ignored', '.DS_Store'), 'metadata');
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'tracked/file.txt']);

  const directories = findEmptyDirectories(root);

  assert.deepEqual(directories, ['tracked/ignored']);
  removeEmptyDirectories(root, directories);
  assert.equal(fs.existsSync(path.join(root, 'tracked', 'file.txt')), true);
  assert.equal(fs.existsSync(path.join(root, 'untracked', 'file.txt')), true);
});

test('removes a directory excluded as a whole', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ignored'));
  fs.writeFileSync(path.join(root, 'ignored', 'cache.bin'), 'cache');

  const directories = findEmptyDirectories(root);

  assert.deepEqual(directories, ['ignored']);
  removeEmptyDirectories(root, directories);
  assert.equal(fs.existsSync(path.join(root, 'ignored')), false);
});

test('keeps node_modules and tmp at the repository root', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules', 'package'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.writeFileSync(path.join(root, 'tmp', '.DS_Store'), 'metadata');

  assert.deepEqual(findEmptyDirectories(root), []);
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'package')), true);
  assert.equal(fs.existsSync(path.join(root, 'tmp', '.DS_Store')), true);
});

test('defaults to a dry run and prints the execution command last', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'empty'));
  const output = [];

  run({ args: [], cwd: root, log: (line) => output.push(line) });

  assert.equal(fs.existsSync(path.join(root, 'empty')), true);
  assert.deepEqual(output, [
    'Would remove empty',
    '',
    'To remove these directories, run:',
    '  npm exec --no -- worktree-keeper remove-empty-directories --execute',
  ]);
});

test('removes the listed directories when passed --execute', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'empty'));
  const output = [];

  run({ args: ['--execute'], cwd: root, log: (line) => output.push(line) });

  assert.equal(fs.existsSync(path.join(root, 'empty')), false);
  assert.deepEqual(output, ['Removed empty']);
});

test('rejects unknown arguments', (t) => {
  const root = createRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => run({ args: ['--delete'], cwd: root, log: () => {} }),
    /unknown argument: --delete/,
  );
});

test('execute preserves nested repositories and their ancestors, including ignored paths', async (t) => {
  for (const relative of ['nested', 'ignored/wrapper/nested']) {
    await t.test(relative, (t) => {
      const root = createRepository();
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const nested = path.join(root, relative);
      fs.mkdirSync(nested, { recursive: true });
      execFileSync('git', ['init', '--quiet', nested]);
      fs.mkdirSync(path.join(nested, 'src'));
      fs.writeFileSync(path.join(nested, 'src', 'keep.txt'), 'valuable work');
      execFileSync('git', ['-C', nested, 'add', '.']);
      execFileSync('git', ['-C', nested, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Nested work']);
      fs.mkdirSync(path.join(root, 'empty'));

      run({ args: ['--execute'], cwd: root, log: () => {} });

      assert.equal(fs.readFileSync(path.join(nested, 'src', 'keep.txt'), 'utf8'), 'valuable work');
      assert.equal(fs.existsSync(path.join(nested, '.git')), true);
      assert.equal(fs.existsSync(path.join(root, 'empty')), false);
    });
  }
});

test('execute preserves a nested linked worktree with a .git file', (t) => {
  const root = createRepository();
  const source = createRepository();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  });
  execFileSync('git', ['-C', source, 'add', '.gitignore']);
  execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Source']);
  const nested = path.join(root, 'ignored', 'linked');
  execFileSync('git', ['-C', source, 'worktree', 'add', '--detach', nested], { stdio: 'pipe' });
  fs.mkdirSync(path.join(nested, 'src'));
  fs.writeFileSync(path.join(nested, 'src', 'keep.txt'), 'worktree data');

  run({ args: ['--execute'], cwd: root, log: () => {} });

  assert.equal(fs.lstatSync(path.join(nested, '.git')).isFile(), true);
  assert.equal(fs.readFileSync(path.join(nested, 'src', 'keep.txt'), 'utf8'), 'worktree data');
});

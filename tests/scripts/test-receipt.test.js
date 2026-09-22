const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkReceipt, matchesReceipt, successMessage } = require('../../scripts/check-test-receipt');
const { recordReceipt } = require('../../scripts/record-test-receipt');
const { receiptPath } = require('../../scripts/receipt-state');

function git(root, ...args) {
  execFileSync('git', args, { cwd: root });
}

test('Git test receipt tracks dirty files across commits and later edits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-receipt-'));
  t.after(() => {
    fs.rmSync(receiptPath(root), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(root, 'reusable-scripts.config.json'), JSON.stringify({
    tests: { excludedPaths: ['data/layer-1-originals/'], receiptMaxAgeMinutes: 1 },
  }));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', '.gitignore', 'tracked.txt', 'reusable-scripts.config.json');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Base');

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'tested\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  git(root, 'add', 'tracked.txt');
  const receipt = recordReceipt(root);
  assert.equal(receipt.changedFiles.length, 2);
  assert.equal(checkReceipt(root), true);
  assert.equal(successMessage(root), 'Tests already passed for this change set. In order to rerun tests anyway, use: node node_modules/reusable-scripts/bin/reusable-scripts.js run-tests rerun');
  assert.equal(matchesReceipt({ ...receipt, passedAt: Date.now() - 59_000 }, root), true);
  assert.equal(matchesReceipt({ ...receipt, passedAt: Date.now() - 61_000 }, root), false);

  git(root, 'add', 'new.txt');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Tested contents');
  assert.equal(checkReceipt(root), true);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed again\n');
  assert.equal(checkReceipt(root), false);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'tested\n');
  assert.equal(checkReceipt(root), true);

  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'dependency.js'), 'ignored\n');
  fs.mkdirSync(path.join(root, 'data/layer-1-originals'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/layer-1-originals', 'source.txt'), 'excluded\n');
  assert.equal(checkReceipt(root), true);
  fs.writeFileSync(path.join(root, 'other.txt'), 'not tested\n');
  assert.equal(checkReceipt(root), false);
});

test('Git test receipt detects deletions and staged edits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-receipt-'));
  t.after(() => {
    fs.rmSync(receiptPath(root), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', 'tracked.txt');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Base');
  recordReceipt(root);
  assert.equal(checkReceipt(root), true);
  fs.rmSync(path.join(root, 'tracked.txt'));
  assert.equal(checkReceipt(root), false);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged\n');
  git(root, 'add', 'tracked.txt');
  assert.equal(checkReceipt(root), false);
});

test('npm test reuses a receipt and reruns after changes, on request, or in CI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-runner-'));
  const counterPath = `${root}-count`;
  t.after(() => {
    fs.rmSync(receiptPath(root), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(counterPath, { force: true });
  });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'tests'));
  for (const name of ['run-tests.js', 'check-test-receipt.js', 'record-test-receipt.js', 'receipt-state.js', 'project-config.js']) {
    fs.copyFileSync(path.join(__dirname, '../../scripts', name), path.join(root, 'scripts', name));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: { lint: 'node -e ""', test: 'node scripts/run-tests.js' },
  }));
  fs.writeFileSync(path.join(root, 'reusable-scripts.config.json'), JSON.stringify({
    tests: {
      commands: ['node --test "tests/example test.js"'],
      npmTestUsesRunner: true,
    },
  }));
  const testPath = path.join(root, 'tests', 'example test.js');
  fs.writeFileSync(testPath, `const test = require('node:test');\nconst fs = require('node:fs');\ntest('example', () => fs.appendFileSync(${JSON.stringify(counterPath)}, 'x'));\n`);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Base');

  function runTests(args = [], environment = {}) {
    const env = { ...process.env, CI: '', ...environment };
    delete env.NODE_TEST_CONTEXT;
    return execFileSync(process.execPath, [path.join(root, 'scripts/run-tests.js'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
  }

  runTests();
  assert.equal(fs.readFileSync(counterPath, 'utf8'), 'x');
  assert.equal(execFileSync(process.execPath, [path.join(root, 'scripts/check-test-receipt.js')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  }), 'Tests already passed for this change set. In order to rerun tests anyway, use: npm test -- rerun\n');
  assert.equal(runTests(), 'Tests already passed for this change set. In order to rerun tests anyway, use: npm test -- rerun\n');
  assert.equal(fs.readFileSync(counterPath, 'utf8'), 'x');
  runTests(['rerun']);
  assert.equal(fs.readFileSync(counterPath, 'utf8'), 'xx');
  runTests([], { CI: 'true' });
  assert.equal(fs.readFileSync(counterPath, 'utf8'), 'xxx');
  fs.appendFileSync(testPath, '// changed\n');
  runTests();
  assert.equal(fs.readFileSync(counterPath, 'utf8'), 'xxxx');
  fs.appendFileSync(path.join(root, 'scripts/project-config.js'), '// shared script changed\n');
  runTests();
  assert.equal(fs.readFileSync(counterPath, 'utf8'), 'xxxxx');
});

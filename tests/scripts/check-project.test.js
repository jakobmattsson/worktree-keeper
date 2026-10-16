'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const YAML = require('yaml');
const { planHooks } = require('../../scripts/install-hooks');
const { writeProjectConfig } = require('./project-config-fixture');

const cli = path.resolve(__dirname, '../../bin/worktree-keeper.js');
function fixture(t, published = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const manifest = { name: 'example', version: '1.2.3', private: !published,
    engines: { node: '>=20' }, volta: { node: '22.14.0', npm: '11.21.0' } };
  const config = writeProjectConfig(root, { git: published ? { releaseRequiredChecks: ['test'], releaseTestWorkflow: 'test.yml' } : {} });
  const hooks = planHooks({}).document;
  const setup = () => [{ uses: 'actions/checkout@v4' }, { uses: 'volta-cli/action@v4' }, { run: 'npm ci' }];
  const workflow = { on: { pull_request: null }, jobs: { test: { steps: [...setup(), { run: 'npm test' }] } } };
  const publishing = { on: { push: { tags: ['v*'] } }, jobs: { publish: {
    permissions: { contents: 'read', 'id-token': 'write' }, steps: [...setup(),
      { run: 'worktree-keeper verify-release', env: { GH_TOKEN: '${{ secrets.RELEASE_POLICY_TOKEN }}', RELEASE_TAG: '${{ github.ref_name }}' } },
      { run: 'npm publish' }],
  } } };
  function write(file, content) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  function save() {
    write('package.json', JSON.stringify(manifest));
    write('package-lock.json', JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
    write('worktree-keeper.config.json', JSON.stringify(config));
    write('.codex/hooks.json', JSON.stringify(hooks));
    write('.github/workflows/test.yml', YAML.stringify(workflow));
    if (published) write('.github/workflows/package.yml', YAML.stringify(publishing));
  }
  function run(...args) {
    return spawnSync(process.execPath, [cli, 'check-project', ...args], { cwd: root, encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: path.join(root, 'no-gh-config'), npm_config_offline: 'true' } });
  }
  save();
  return { root, manifest, config, hooks, workflow, publishing, write, save, run };
}

for (const published of [false, true]) test(`public command validates ${published ? 'published' : 'private'} project offline without changing files`, t => {
  const f = fixture(t, published);
  const before = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.root, encoding: 'utf8' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, published ? /publication/ : /publication skipped/);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.root, encoding: 'utf8' }), before);
});

const cases = [
  ['unpinned Node', f => { f.manifest.volta.node = '22'; }, /pin an exact volta.node/],
  ['unpinned npm', f => { delete f.manifest.volta.npm; }, /pin an exact volta.npm/],
  ['incompatible engine', f => { f.manifest.engines.node = '>=24'; }, /satisfy engines.node/],
  ['conflicting nvm file', f => f.write('.nvmrc', '20.0.0'), /nvmrc conflicts/],
  ['missing hook', f => { delete f.hooks.hooks.SessionStart; }, /install-hooks/],
  ['duplicate hook', f => f.hooks.hooks.Stop.push(f.hooks.hooks.Stop[0]), /install-hooks/],
  ['old hook', f => { f.hooks.hooks.Stop[0].hooks[0].command = 'node scripts/checkpoint-codex-stop.js'; }, /install-hooks/],
  ['conditional hook', f => { f.hooks.hooks.Stop[0].matcher = 'something'; }, /group conditions/],
  ['missing PR trigger', f => { f.workflow.on = { push: null }; }, /on.pull_request/],
  ['path-filtered PR trigger', f => { f.workflow.on.pull_request = { paths: ['src/**'] }; }, /PR filters/],
  ['wrong target branch', f => { f.workflow.on.pull_request = { branches: ['other'] }; }, /PR filters/],
  ['conditional required job', f => { f.workflow.jobs.test.if = '${{ false }}'; }, /must not be skipped/],
  ['allowed job failure', f => { f.workflow.jobs.test['continue-on-error'] = true; }, /must not allow failure/],
  ['conditional dependency', f => { f.workflow.jobs.before = { if: '${{ false }}' }; f.workflow.jobs.test.needs = 'before'; }, /must not be skipped/],
  ['conditional tests', f => { f.workflow.jobs.test.steps.at(-1).if = '${{ false }}'; }, /unconditional npm ci/],
  ['ignored test failure', f => { f.workflow.jobs.test.steps.at(-1)['continue-on-error'] = true; }, /unconditional npm ci/],
  ['nonreproducible install', f => { f.workflow.jobs.test.steps[2].run = 'npm install'; }, /unconditional npm ci/],
  ['unsupported test wrapper', f => { f.workflow.jobs.test.steps.at(-1).run = 'bash test.sh'; }, /unconditional npm ci/],
  ['version override', f => { f.workflow.jobs.test.steps[1].with = { 'node-version': '24' }; }, /version\/path overrides/],
  ['competing setup', f => f.workflow.jobs.test.steps.push({ uses: 'actions/setup-node@v4' }), /competing/],
  ['setup after install', f => { [f.workflow.jobs.test.steps[1], f.workflow.jobs.test.steps[2]] = [f.workflow.jobs.test.steps[2], f.workflow.jobs.test.steps[1]]; }, /before Node\/npm/],
  ['missing release verifier', f => f.publishing.jobs.publish.steps.splice(3, 1), /verify-release unconditionally/],
  ['late release verifier', f => f.publishing.jobs.publish.steps.reverse(), /verify-release unconditionally/],
  ['ignored verifier failure', f => { f.publishing.jobs.publish.steps[3]['continue-on-error'] = true; }, /verify-release unconditionally/],
  ['missing OIDC permission', f => { delete f.publishing.jobs.publish.permissions['id-token']; }, /id-token: write/],
  ['wrong release tag input', f => { f.publishing.jobs.publish.steps[3].env.RELEASE_TAG = 'v1.2.3'; }, /RELEASE_TAG/],
  ['missing token declaration', f => { delete f.publishing.jobs.publish.steps[3].env.GH_TOKEN; }, /GH_TOKEN/],
  ['prerelease package version', f => { f.manifest.version = '1.2.3-beta.1'; }, /exact stable version/],
  ['dynamic required job name', f => { f.config.git.releaseRequiredChecks = ['${{ matrix.os }}']; f.workflow.jobs.test.name = '${{ matrix.os }}'; }, /static name/],
  ['different package version', f => { f.manifest.version = '1.2.4'; }, /does not match/],
  ['missing required release check', f => { f.config.git.releaseRequiredChecks = ['absent']; }, /required job absent/],
];
for (const [name, change, message] of cases) test(`public command rejects ${name}`, t => {
  const f = fixture(t, true);
  change(f);
  f.save();
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, message);
});

test('supports named test jobs, additional hooks, reports and package checks', t => {
  const f = fixture(t, true);
  f.config.git.releaseRequiredChecks = ['Full test suite', 'Test package'];
  f.workflow.jobs.test.name = 'Full test suite';
  f.workflow.jobs.test.steps.at(-1).run = 'npm run test:coverage';
  f.workflow.jobs.test.steps.push({ run: 'node coverage.js', if: '${{ always() }}' });
  f.workflow.jobs.package = { name: 'Test package', steps: [...f.workflow.jobs.test.steps.slice(0, 3), { run: 'npm pack --dry-run --json' }] };
  f.hooks.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo custom-hook' }] });
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('supports explicit PR workflow and job selection for a private project', t => {
  const f = fixture(t);
  f.config.projectChecks = { testWorkflow: 'ci.yaml', requiredJobs: ['Tests'] };
  f.workflow.jobs.test.name = 'Tests';
  f.save();
  fs.renameSync(path.join(f.root, '.github/workflows/test.yml'), path.join(f.root, '.github/workflows/ci.yaml'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('reports multiple independent failures and rejects malformed YAML', t => {
  const f = fixture(t);
  delete f.manifest.volta;
  delete f.hooks.hooks.Stop;
  f.save();
  f.write('.github/workflows/test.yml', 'jobs: [');
  const result = f.run();
  assert.equal(result.status, 1);
  for (const category of ['tools', 'hooks', 'CI']) assert.ok(result.stderr.includes(`[${category}]`));
});

test('public command exposes help and rejects unknown arguments', t => {
  const f = fixture(t);
  assert.equal(f.run('--help').status, 0);
  assert.match(f.run('--online').stderr, /Usage: worktree-keeper check-project/);
});

for (const on of ['pull_request', ['push', 'pull_request']]) test(`supports PR event shorthand ${JSON.stringify(on)}`, t => {
  const f = fixture(t);
  f.workflow.on = on;
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('supports inherited verifier inputs and workflow permissions', t => {
  const f = fixture(t, true);
  f.publishing.env = f.publishing.jobs.publish.steps[3].env;
  delete f.publishing.jobs.publish.steps[3].env;
  f.publishing.permissions = f.publishing.jobs.publish.permissions;
  delete f.publishing.jobs.publish.permissions;
  f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { verifyRelease } = require('../../scripts/verify-release-core');
const { verifyProtection, githubApi } = require('../../scripts/release-protection');

function fixture() {
  const state = {
    protection: { enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ['test', 'Test package'] } },
    rules: [],
    ruleset: { enforcement: 'active', bypass_actors: [] },
    comparison: { status: 'ahead' },
    commit: { sha: 'merged' },
    pulls: [{ number: 12, merged_at: '2026-01-01', merge_commit_sha: 'merged',
      base: { ref: 'main', repo: { full_name: 'owner/repo' } },
      head: { ref: 'release/v1.2.3', sha: 'pr-head', repo: { full_name: 'owner/repo' } } }],
    runs: [{ id: 42, run_number: 10, conclusion: 'success' }],
    jobs: ['test', 'Test package'].map(name => ({ name, conclusion: 'success' })),
  };
  const calls = [];
  const api = endpoint => {
    calls.push(endpoint);
    if (state.error) throw Object.assign(new Error(state.error), { status: state.status });
    if (endpoint.endsWith('/protection')) {
      if (!state.protection) throw Object.assign(new Error('Not found'), { status: 404 });
      return state.protection;
    }
    if (endpoint.includes('/rules/branches/')) return state.rules;
    if (endpoint.includes('/rulesets/')) return state.ruleset;
    if (endpoint.includes('/compare/')) return state.comparison;
    if (endpoint.includes('/pulls?')) return state.pulls;
    if (endpoint.includes('/runs?')) return { workflow_runs: state.runs };
    if (endpoint.includes('/jobs?')) return { jobs: state.jobs };
    if (endpoint.endsWith('/commits/merged')) return state.commit;
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return { state, calls, args: { api, slug: 'owner/repo', sha: 'merged', tag: 'v1.2.3', branch: 'main', checks: ['test', 'Test package'], workflow: 'package.yml' } };
}

function useRuleset(state) {
  state.protection = null;
  state.rules = [{ type: 'required_status_checks', ruleset_id: 1, parameters: {
    strict_required_status_checks_policy: true,
    required_status_checks: ['test', 'Test package'].map(context => ({ context })),
  } }];
}

test('verifies a merged release using GitHub checks without artifacts', () => {
  const { args, calls } = fixture();
  verifyRelease(args);
  assert.ok(calls.some(call => call.includes('event=pull_request&head_sha=pr-head')));
  assert.equal(calls.some(call => call.includes('artifact')), false);
});

test('accepts active strict rulesets without bypass instead of classic protection', () => {
  const { state, args } = fixture();
  useRuleset(state);
  verifyRelease(args);
});

const cases = [
  ['loose protection', s => { s.protection.required_status_checks.strict = false; }, /strict status checks/],
  ['admin bypass', s => { s.protection.enforce_admins.enabled = false; }, /without bypass/],
  ['missing required job', s => { s.protection.required_status_checks.contexts.pop(); }, /Test package/],
  ['missing protection', s => { s.protection = null; }, /strict status checks/],
  ['forbidden API', s => { s.error = 'Forbidden'; s.status = 403; }, /Forbidden/],
  ['unavailable API', s => { s.error = 'Unavailable'; s.status = 503; }, /Unavailable/],
  ['unreadable ruleset bypass', s => { useRuleset(s); delete s.ruleset.bypass_actors; }, /write access.*rerun/],
  ['ruleset bypass', s => { useRuleset(s); s.ruleset.bypass_actors = [{ actor_type: 'RepositoryRole', actor_id: 5 }]; }, /bypass actors/],
  ['inactive ruleset', s => { useRuleset(s); s.ruleset.enforcement = 'evaluate'; }, /active ruleset/],
  ['loose ruleset', s => { useRuleset(s); s.rules[0].parameters.strict_required_status_checks_policy = false; }, /strict status checks/],
  ['empty required checks', s => { s.protection.required_status_checks.contexts = []; }, /strict status checks/],
  ['not on main', s => { s.comparison.status = 'diverged'; }, /default branch/],
  ['manual tag', s => { s.pulls = []; }, /merged release PR/],
  ['wrong merge commit', s => { s.pulls[0].merge_commit_sha = 'other'; }, /merged release PR/],
  ['unmerged PR', s => { s.pulls[0].merged_at = null; }, /merged release PR/],
  ['ordinary PR', s => { s.pulls[0].head.ref = 'feature'; }, /merged release PR/],
  ['fork PR', s => { s.pulls[0].head.repo.full_name = 'fork/repo'; }, /merged release PR/],
  ['wrong base', s => { s.pulls[0].base.ref = 'other'; }, /merged release PR/],
  ['no run', s => { s.runs = []; }, /successful CI/],
  ['newer failed run', s => { s.runs.push({ id: 43, run_number: 11, conclusion: 'failure' }); }, /successful CI/],
  ['duplicate failed job', s => { s.jobs.push({ name: 'test', conclusion: 'failure' }); }, /successful test/],
  ['skipped test', s => { s.jobs[0].conclusion = 'skipped'; }, /successful test/],
  ['missing package check', s => { s.jobs.pop(); }, /successful Test package/],
];
for (const [name, change, message] of cases) test(`rejects ${name}`, () => {
  const { state, args } = fixture();
  change(state);
  assert.throws(() => verifyRelease(args), message);
});

test('reports permission failures with corrective action', () => {
  const api = githubApi(() => ({ status: 1, stderr: 'HTTP 403: Forbidden' }), '.', 'github.com');
  assert.throws(() => api('repos/owner/repo/branches/main/protection'), /Administration read.*then rerun/);
});

test('uses the configured branch and follows paginated rules', () => {
  const calls = [];
  verifyProtection({ slug: 'owner/repo', branch: 'stable/next', checks: ['test'], api: endpoint => {
    calls.push(endpoint);
    if (endpoint.endsWith('/protection')) return { enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ['test'] } };
    return endpoint.endsWith('page=1') ? Array.from({ length: 100 }, () => ({ type: 'deletion' })) : [];
  } });
  assert.ok(calls.every(call => call.includes('stable%2Fnext')));
  assert.ok(calls.some(call => call.endsWith('page=2')));
});

test('workflow checks policy before testing and combines release verification before publishing', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/package.yml'), 'utf8'));
  assert.equal(workflow.on.push.branches, undefined);
  for (const name of ['test', 'package']) assert.equal(workflow.jobs[name].if, "${{ github.event_name == 'pull_request' }}");
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../worktree-keeper.config.json'), 'utf8'));
  const prChecks = Object.entries(workflow.jobs)
    .filter(([, job]) => job.if === "${{ github.event_name == 'pull_request' }}")
    .map(([id, job]) => job.name || id);
  assert.deepEqual([...config.git.releaseRequiredChecks].sort(), prChecks.sort());
  const steps = workflow.jobs.test.steps;
  const policy = steps.findIndex(step => step.run === 'node bin/worktree-keeper.js verify-release-protection');
  assert.ok(policy >= 0 && policy < steps.findIndex(step => step.run === 'npm test'));
  const publish = workflow.jobs.publish.steps;
  const verify = publish.findIndex(step => step.run === 'node bin/worktree-keeper.js verify-release');
  assert.ok(verify >= 0 && verify < publish.findIndex(step => step.run === 'npm publish'));
  assert.equal(steps.some(step => step.uses?.startsWith('actions/upload-artifact')), false);
});

test('public policy command fails on denied API access and succeeds only after access is fixed', t => {
  const os = require('node:os');
  const { execFileSync, spawnSync } = require('node:child_process');
  const { writeProjectConfig } = require('./project-config-fixture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-policy-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  writeProjectConfig(root, { git: { releaseRequiredChecks: ['test'] } });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
if (process.env.DENY_POLICY === '1') {
  console.error('gh: Resource not accessible by integration (HTTP 403)');
  process.exit(1);
}
const endpoint = process.argv.at(-1);
if (endpoint.endsWith('/protection')) console.log(JSON.stringify({
  enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ['test'] }
}));
else if (endpoint.includes('/rules/branches/')) console.log('[]');
else process.exit(2);
`, { mode: 0o755 });
  const run = denied => spawnSync(process.execPath, [path.join(__dirname, '../../bin/worktree-keeper.js'), 'verify-release-protection'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_CONFIG_DIR: path.join(root, 'gh-config'), GH_TOKEN: 'test-owned-token', GITHUB_BASE_REF: 'main', DENY_POLICY: denied ? '1' : '0' },
  });
  const denied = run(true);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Administration read.*then rerun/);
  assert.equal(run(false).status, 0);
});

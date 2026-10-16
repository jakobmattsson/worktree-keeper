'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const verify = require('../../.github/scripts/verify-release.cjs');

function fixture() {
  const state = {
    comparison: { status: 'ahead' },
    commit: { sha: 'merged', commit: { tree: { sha: 'tested-tree' } } },
    pulls: [{ number: 12, merged_at: '2026-01-01', merge_commit_sha: 'merged',
      base: { ref: 'main', repo: { full_name: 'owner/repo' } },
      head: { ref: 'release/v1.2.3', sha: 'pr-head', repo: { full_name: 'owner/repo' } } }],
    runs: [{ id: 42, run_number: 10, run_attempt: 2, conclusion: 'success', pull_requests: [{ number: 12 }] }],
    jobs: ['test', 'Test package'].map(name => ({ name, conclusion: 'success' })),
    artifacts: [{ id: 123, name: 'tested-tree-2', expired: false }],
    evidence: { pullRequest: 12, head: 'pr-head', tree: 'tested-tree' },
  };
  const endpoint = key => async () => ({ data: state[key] });
  const github = { rest: {
    repos: { getCommit: endpoint('commit'), compareCommits: endpoint('comparison'), listPullRequestsAssociatedWithCommit: 'pulls' },
    actions: { listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs', listWorkflowRunArtifacts: 'artifacts' },
  }, paginate: async (key) => state[key] };
  return { state, args: { github, context: { repo: { owner: 'owner', repo: 'repo' }, ref: 'refs/tags/v1.2.3', sha: 'merged' },
    readTestEvidence: async () => state.evidence } };
}

test('publishes a merged release whose tree matches successful PR evidence', async () => {
  const { args, state } = fixture();
  state.runs[0].pull_requests = [];
  await verify(args);
});

test('rejects releases without matching approved contents', async t => {
  const cases = [
    ['not on main', s => { s.comparison.status = 'diverged'; }, /belong to main/],
    ['manual tag', s => { s.pulls = []; }, /merged release PR/],
    ['wrong merge commit', s => { s.pulls[0].merge_commit_sha = 'other'; }, /merged release PR/],
    ['unmerged PR', s => { s.pulls[0].merged_at = null; }, /merged release PR/],
    ['ordinary PR', s => { s.pulls[0].head.ref = 'feature'; }, /merged release PR/],
    ['fork PR', s => { s.pulls[0].head.repo.full_name = 'fork/repo'; }, /merged release PR/],
    ['wrong base', s => { s.pulls[0].base.ref = 'other'; }, /merged release PR/],
    ['no run', s => { s.runs = []; }, /successful CI/],
    ['different PR', s => { s.evidence.pullRequest = 99; }, /do not match/],
    ['newer failed run', s => { s.runs.push({ ...s.runs[0], run_number: 11, conclusion: 'failure' }); }, /successful CI/],
    ['skipped test', s => { s.jobs[0].conclusion = 'skipped'; }, /successful test/],
    ['missing package check', s => { s.jobs.pop(); }, /successful Test package/],
    ['missing evidence', s => { s.artifacts = []; }, /no retained test evidence/],
    ['expired evidence', s => { s.artifacts[0].expired = true; }, /no retained test evidence/],
    ['old attempt evidence', s => { s.artifacts[0].name = 'tested-tree-1'; }, /no retained test evidence/],
    ['stale head', s => { s.evidence.head = 'old-head'; }, /do not match/],
    ['different merge tree', s => { s.evidence.tree = 'other-tree'; }, /do not match/],
  ];
  for (const [name, change, message] of cases) await t.test(name, async () => {
    const { state, args } = fixture();
    change(state);
    await assert.rejects(verify(args), message);
  });
});

test('reads test evidence from the downloaded GitHub artifact', async () => {
  const { state, args } = fixture();
  delete args.readTestEvidence;
  // A ZIP containing tested-tree.json, as returned by the artifact API.
  const archive = Buffer.from('UEsDBBQAAAAAACWJUF1E7AsAOAAAADgAAAAQAAAAdGVzdGVkLXRyZWUuanNvbnsicHVsbFJlcXVlc3QiOjEyLCJoZWFkIjoicHItaGVhZCIsInRyZWUiOiJ0ZXN0ZWQtdHJlZSJ9UEsBAhQDFAAAAAAAJYlQXUTsCwA4AAAAOAAAABAAAAAAAAAAAAAAAIABAAAAAHRlc3RlZC10cmVlLmpzb25QSwUGAAAAAAEAAQA+AAAAZgAAAAAA', 'base64');
  args.github.rest.actions.downloadArtifact = async () => ({ data: archive });
  await verify(args);
});

test('workflow tests only PRs and verifies tags before publishing', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/package.yml'), 'utf8'));
  assert.equal(workflow.on.push.branches, undefined);
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  for (const name of ['test', 'package']) assert.equal(workflow.jobs[name].if, "${{ github.event_name == 'pull_request' }}");
  const publish = workflow.jobs.publish;
  assert.equal(publish.needs, undefined);
  const verifyIndex = publish.steps.findIndex(step => step.with?.script?.includes('await verify({ github, context })'));
  const publishIndex = publish.steps.findIndex(step => step.run === 'npm publish');
  assert.ok(verifyIndex >= 0 && verifyIndex < publishIndex);
  assert.ok(workflow.jobs.test.steps.some(step => step.uses === 'actions/upload-artifact@v4'));
});

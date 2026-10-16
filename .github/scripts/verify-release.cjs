'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function readEvidence(github, repository, artifact) {
  const response = await github.rest.actions.downloadArtifact({
    ...repository, artifact_id: artifact.id, archive_format: 'zip',
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-'));
  try {
    const archive = path.join(directory, 'evidence.zip');
    fs.writeFileSync(archive, Buffer.from(response.data));
    return JSON.parse(execFileSync('unzip', ['-p', archive, 'tested-tree.json'], { encoding: 'utf8' }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = async function verifyRelease({ github, context, readTestEvidence = readEvidence }) {
  const repository = context.repo;
  const tag = context.ref.replace(/^refs\/tags\//u, '');
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('Expected a stable release tag');
  const { data: commit } = await github.rest.repos.getCommit({ ...repository, ref: context.sha });
  const { data: comparison } = await github.rest.repos.compareCommits({
    ...repository, base: commit.sha, head: 'main',
  });
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Release commit must belong to main');
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...repository, commit_sha: commit.sha, per_page: 100,
  });
  const pull = pulls.find(pr => pr.merged_at && pr.merge_commit_sha === commit.sha &&
    pr.base.ref === 'main' && pr.base.repo.full_name === `${repository.owner}/${repository.repo}` &&
    pr.head.repo?.full_name === pr.base.repo.full_name && pr.head.ref === `release/${tag}`);
  if (!pull) throw new Error('Tag must point to a merged release PR');
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repository, workflow_id: 'package.yml', event: 'pull_request', head_sha: pull.head.sha, per_page: 100,
  });
  // GitHub can return an empty pull_requests array after the PR is merged.
  // Bind the run to the PR through its head SHA and the recorded PR number.
  const run = runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || run.conclusion !== 'success') throw new Error('Release PR must have a successful CI run');
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repository, run_id: run.id, filter: 'latest', per_page: 100,
  });
  // These names are the required public checks configured in branch protection.
  for (const name of ['test', 'Test package']) {
    if (!jobs.some(job => job.name === name && job.conclusion === 'success')) {
      throw new Error(`Release PR requires successful ${name} check`);
    }
  }
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...repository, run_id: run.id, per_page: 100,
  });
  const artifact = artifacts.find(item => item.name === `tested-tree-${run.run_attempt}` && !item.expired);
  if (!artifact) throw new Error('Release PR has no retained test evidence; rerun its CI');
  const evidence = await readTestEvidence(github, repository, artifact);
  if (evidence.pullRequest !== pull.number || evidence.head !== pull.head.sha || evidence.tree !== commit.commit.tree.sha) {
    throw new Error('Release contents do not match the tested PR contents');
  }
};

'use strict';
const { verifyProtection } = require('./release-protection');

function list(api, endpoint, member) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const response = api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = member ? response[member] : response;
    if (!Array.isArray(batch)) throw new Error(`GitHub returned an invalid list for ${endpoint}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function verifyRelease({ api, slug, sha, tag, branch, checks, workflow }) {
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('Expected a stable release tag');
  verifyProtection({ api, slug, branch, checks });
  const base = `repos/${slug}`;
  const commit = api(`${base}/commits/${encodeURIComponent(sha)}`);
  const comparison = api(`${base}/compare/${commit.sha}...${encodeURIComponent(branch)}`);
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Release commit must belong to the default branch');
  const pulls = list(api, `${base}/commits/${commit.sha}/pulls`);
  const pull = pulls.find(pr => pr.merged_at && pr.merge_commit_sha === commit.sha &&
    pr.base.ref === branch && pr.base.repo.full_name === slug &&
    pr.head.repo?.full_name === slug && pr.head.ref === `release/${tag}`);
  if (!pull) throw new Error('Tag must point to a merged release PR');
  const runs = list(api, `${base}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=pull_request&head_sha=${pull.head.sha}`, 'workflow_runs');
  const run = runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || run.conclusion !== 'success') throw new Error('Release PR must have a successful CI run');
  const jobs = list(api, `${base}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
  for (const name of checks) {
    const matching = jobs.filter(job => job.name === name);
    if (!matching.length || matching.some(job => job.conclusion !== 'success')) {
      throw new Error(`Release PR requires successful ${name} check`);
    }
  }
}

module.exports = { verifyRelease };

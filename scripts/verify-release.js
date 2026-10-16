#!/usr/bin/env node
'use strict';
const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
const { projectConfig } = require('./project-config');
const { originRepository, inspectWorkflow } = require('./release-core');
const { githubApi, requiredChecks } = require('./release-protection');
const { verifyRelease } = require('./verify-release-core');

try {
  // Preserve the standalone version command's contract and error messages.
  execFileSync(process.execPath, [path.join(__dirname, 'verify-release-version.js')], { stdio: 'inherit' });
  const cwd = process.cwd();
  const config = projectConfig(cwd);
  const remote = execFileSync('git', ['remote', 'get-url', config.git.remote], { encoding: 'utf8' }).trim();
  const { host, slug } = originRepository(remote);
  const api = githubApi((command, args, options) => spawnSync(command, args, { ...options, encoding: 'utf8' }), cwd, host);
  const tag = process.env.RELEASE_TAG;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publishWorkflow = inspectWorkflow(cwd, tag);
  verifyRelease({ api, slug, sha, tag, branch: config.git.defaultBranch,
    checks: requiredChecks(cwd), workflow: config.git.releaseTestWorkflow || path.basename(publishWorkflow.path) });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

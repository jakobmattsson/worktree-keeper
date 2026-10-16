#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { projectConfig } = require('./project-config');
const { originRepository } = require('./release-core');
const { githubApi, requiredChecks, verifyProtection } = require('./release-protection');

try {
  const cwd = process.cwd();
  const config = projectConfig(cwd);
  const remote = spawnSync('git', ['remote', 'get-url', config.git.remote], { encoding: 'utf8' });
  if (remote.status !== 0) throw new Error(remote.stderr);
  const { host, slug } = originRepository(remote.stdout.trim());
  const api = githubApi((command, args, options) => spawnSync(command, args, { ...options, encoding: 'utf8' }), cwd, host);
  verifyProtection({ api, slug, branch: process.env.GITHUB_BASE_REF || config.git.defaultBranch, checks: requiredChecks(cwd) });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

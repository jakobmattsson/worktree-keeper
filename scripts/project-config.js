const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'worktree-keeper.config.json';

function repositoryRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function requireExactKeys(value, keys, location, file, optionalKeys = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: ${location} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optionalKeys.includes(key)) throw new Error(`${file}: unknown field ${location}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${file}: missing field ${location}.${key}`);
  }
}

function requireNonemptyString(value, location, file) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${file}: ${location} must be a nonempty string`);
  }
}

function validateConfig(config, file) {
  requireExactKeys(config, ['git', 'tests', 'loggingDirectory'], 'config', file);
  requireExactKeys(config.git, ['remote', 'defaultBranch', 'branchPrefix'], 'git', file, ['checkpointPushRemotes', 'releaseMergeMethod', 'releaseRequiredChecks']);
  requireExactKeys(config.tests, ['commands', 'receiptMaxAgeMinutes', 'npmTestUsesRunner'], 'tests', file);

  for (const field of ['remote', 'defaultBranch', 'branchPrefix']) {
    requireNonemptyString(config.git[field], `git.${field}`, file);
  }
  if (Object.hasOwn(config.git, 'checkpointPushRemotes')) {
    const remotes = config.git.checkpointPushRemotes;
    if (!Array.isArray(remotes)
        || remotes.some((remote) => typeof remote !== 'string' || remote.trim() === ''
          || remote !== remote.trim() || remote.startsWith('-'))
        || new Set(remotes).size !== remotes.length) {
      throw new Error(`${file}: git.checkpointPushRemotes must be an array of unique remote names`);
    }
  }
  if (Object.hasOwn(config.git, 'releaseRequiredChecks')) {
    const checks = config.git.releaseRequiredChecks;
    if (!Array.isArray(checks) || !checks.length || checks.some(check => typeof check !== 'string' || !check.trim() || check !== check.trim()) || new Set(checks).size !== checks.length) {
      throw new Error(`${file}: git.releaseRequiredChecks must be a nonempty array of unique check names`);
    }
  }
  if (Object.hasOwn(config.git, 'releaseMergeMethod')
      && !['merge', 'squash', 'rebase'].includes(config.git.releaseMergeMethod)) {
    throw new Error(`${file}: git.releaseMergeMethod must be merge, squash, or rebase`);
  }
  requireNonemptyString(config.loggingDirectory, 'loggingDirectory', file);
  if (!Array.isArray(config.tests.commands) || config.tests.commands.length === 0
      || config.tests.commands.some((command) => typeof command !== 'string' || command.trim() === '')) {
    throw new Error(`${file}: tests.commands must be a nonempty array of command strings`);
  }
  if (!Number.isSafeInteger(config.tests.receiptMaxAgeMinutes)
      || config.tests.receiptMaxAgeMinutes < 1) {
    throw new Error(`${file}: tests.receiptMaxAgeMinutes must be a positive integer`);
  }
  if (typeof config.tests.npmTestUsesRunner !== 'boolean') {
    throw new Error(`${file}: tests.npmTestUsesRunner must be a boolean`);
  }
}

function projectConfig(cwd = process.cwd()) {
  const root = repositoryRoot(cwd);
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`${file}: configuration file is required; define tests.commands explicitly`);
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateConfig(config, file);
  return { root, ...config };
}

module.exports = { CONFIG_FILE, projectConfig, repositoryRoot };

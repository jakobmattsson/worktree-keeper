const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repositoryRoot } = require('./project-config');

const ROOT = repositoryRoot;
const RECEIPT_DIRECTORY = 'worktree-keeper-test-receipts';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
}

function pathsFromOutput(output) {
  return output.toString('utf8').split('\0').filter(Boolean);
}

function changedPaths(root, baseCommit) {
  const tracked = pathsFromOutput(git(root, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseCommit, '--',
  ]));
  const untracked = pathsFromOutput(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].sort();
}

function fileFingerprint(root, relative) {
  const fullPath = path.join(root, relative);
  let stat;
  try {
    stat = fs.lstatSync(fullPath);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
  const hash = crypto.createHash('sha256');
  hash.update(`${stat.mode & 0o777}\0`);
  if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(fullPath));
  else if (stat.isFile()) hash.update(fs.readFileSync(fullPath));
  else hash.update(`special:${stat.mode}`);
  return hash.digest('hex');
}

function sharedScriptsFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(__dirname).filter((file) => file.endsWith('.js')).sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(__dirname, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function environmentFingerprint() {
  return JSON.stringify({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sharedScripts: sharedScriptsFingerprint(),
    environment: Object.fromEntries(['CI', 'TZ', 'LANG', 'LC_ALL', 'NODE_OPTIONS']
      .map((name) => [name, process.env[name] || ''])),
  });
}

function snapshot(root = ROOT(), baseCommit = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim()) {
  return {
    baseCommit,
    environment: environmentFingerprint(),
    changedFiles: changedPaths(root, baseCommit)
      .map((relative) => [relative, fileFingerprint(root, relative)]),
  };
}

function receiptPath(root = ROOT()) {
  const id = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex');
  return path.join(os.tmpdir(), RECEIPT_DIRECTORY, `${id}.git.json`);
}

module.exports = { ROOT, environmentFingerprint, receiptPath, snapshot };

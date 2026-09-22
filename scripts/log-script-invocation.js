const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { projectConfig } = require('./project-config');

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }

  return result.stdout;
}

function sourceRepositoryRoot(cwd) {
  const output = runGit(['worktree', 'list', '--porcelain', '-z'], cwd);
  const firstField = output.split('\0').find((field) => field.startsWith('worktree '));

  if (!firstField) {
    throw new Error('could not find the primary Git worktree');
  }

  return firstField.slice('worktree '.length);
}

function samePath(first, second) {
  try {
    return fs.realpathSync(first) === fs.realpathSync(second);
  } catch {
    return path.resolve(first) === path.resolve(second);
  }
}

function isPrimaryWorktree(cwd) {
  const repositoryRoot = runGit(['rev-parse', '--show-toplevel'], cwd).trim();
  return samePath(repositoryRoot, sourceRepositoryRoot(cwd));
}

function shellQuote(argument) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) {
    return argument;
  }

  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function filesystemTimestamp(date) {
  return date.toISOString().replaceAll(':', '-');
}

function logScriptInvocation(options = {}) {
  const argv = options.argv || process.argv;
  const cwd = options.cwd || process.cwd();
  const date = options.date || new Date();
  const processId = options.processId || process.pid;
  const repositoryRoot = sourceRepositoryRoot(cwd);
  const logDirectory = path.join(repositoryRoot, projectConfig(repositoryRoot).loggingDirectory);
  const scriptName = path.basename(argv[1] || 'unknown-script');
  const fileName = `${filesystemTimestamp(date)}-${scriptName}-${processId}.log`;
  const commandLine = argv.map(shellQuote).join(' ');

  fs.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, fileName);
  fs.writeFileSync(logPath, `${commandLine}\n`, { flag: 'wx' });
  return logPath;
}

module.exports = {
  filesystemTimestamp,
  isPrimaryWorktree,
  logScriptInvocation,
  shellQuote,
  sourceRepositoryRoot,
};

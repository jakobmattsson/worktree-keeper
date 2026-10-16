#!/usr/bin/env node

/**
 * Commit the current Codex worktree and push to configured remotes.
 *
 * Explicit checkpoint remotes also receive new branches. Without that setting,
 * only an existing branch on the configured remote is pushed. Failures are recorded inside
 * the worktree's Git metadata so the Stop hook can keep them visible.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isPrimaryWorktree } = require('./log-script-invocation.js');
const { projectConfig } = require('./project-config');

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }

  return result.stdout?.trim() || '';
}

function tryGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function markerPath(repositoryRoot) {
  const gitDirectory = runGit([
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
  ], { cwd: repositoryRoot });

  return path.join(gitDirectory, 'codex-checkpoint-error.json');
}

function writeFailureMarker(repositoryRoot, error, branch) {
  const marker = markerPath(repositoryRoot);
  fs.writeFileSync(marker, `${JSON.stringify({
    branch: branch || null,
    error: error.message,
    timestamp: new Date().toISOString(),
  }, null, 2)}\n`);
}

function clearFailureMarker(repositoryRoot) {
  fs.rmSync(markerPath(repositoryRoot), { force: true });
}

function remoteBranchExists(repositoryRoot, branch) {
  const { remote } = projectConfig(repositoryRoot).git;
  const result = tryGit([
    'ls-remote',
    '--exit-code',
    '--heads',
    remote,
    `refs/heads/${branch}`,
  ], repositoryRoot);

  if (result.status === 0) {
    return true;
  }
  if (result.status === 2) {
    return false;
  }

  const detail = result.stderr?.trim() || result.stdout?.trim();
  throw new Error(detail || `could not inspect branches on ${remote}`);
}

function validateMessage(subject, bodyParagraphs) {
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new Error('a non-empty commit subject is required');
  }
  if (subject.includes('\n')) {
    throw new Error('the commit subject must be a single line');
  }
  if (
    !Array.isArray(bodyParagraphs)
    || bodyParagraphs.length === 0
    || bodyParagraphs.some((paragraph) => paragraph.trim() === '')
  ) {
    throw new Error('at least one non-empty commit body paragraph is required');
  }

  return {
    bodyParagraphs: bodyParagraphs.map((paragraph) => paragraph.trim()),
    subject: subject.trim(),
  };
}

function parseArguments(args) {
  let subject = null;
  const bodyParagraphs = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === '--subject' && value !== undefined) {
      if (subject !== null) {
        throw new Error('--subject may only be provided once');
      }
      subject = value;
      index += 1;
    } else if (argument === '--body' && value !== undefined) {
      bodyParagraphs.push(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }

  return validateMessage(subject, bodyParagraphs);
}

function checkpoint(repositoryRoot, message, log = console.log) {
  if (isPrimaryWorktree(repositoryRoot)) {
    throw new Error('refusing to checkpoint the primary Git worktree');
  }

  let branch = null;

  try {
    const { subject, bodyParagraphs } = validateMessage(
      message?.subject,
      message?.bodyParagraphs,
    );

    branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repositoryRoot,
    });
    const { defaultBranch, remote, checkpointPushRemotes } = projectConfig(repositoryRoot).git;
    if (branch === defaultBranch) {
      throw new Error(`refusing to checkpoint changes directly on ${defaultBranch}`);
    }

    const conflicts = runGit(['diff', '--name-only', '--diff-filter=U'], {
      cwd: repositoryRoot,
    });
    if (conflicts !== '') {
      throw new Error(`resolve merge conflicts before checkpointing:\n${conflicts}`);
    }

    const status = runGit(['status', '--porcelain', '--untracked-files=all'], {
      cwd: repositoryRoot,
    });
    const previousFailureExists = fs.existsSync(markerPath(repositoryRoot));

    if (status !== '') {
      runGit(['add', '--all'], { cwd: repositoryRoot });
      const commitArguments = ['commit', '--message', subject];
      for (const paragraph of bodyParagraphs) {
        commitArguments.push('--message', paragraph);
      }
      runGit(commitArguments, {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      log(`Committed ${branch}: ${subject}`);
    } else if (!previousFailureExists) {
      log('No changes to checkpoint.');
      return { committed: false, pushed: false };
    }

    const pushRemotes = checkpointPushRemotes ?? (
      remoteBranchExists(repositoryRoot, branch) ? [remote] : []
    );
    if (pushRemotes.length === 0) {
      clearFailureMarker(repositoryRoot);
      log(checkpointPushRemotes === undefined
        ? `Kept ${branch} local because ${remote}/${branch} does not exist.`
        : `Kept ${branch} local because checkpoint push is disabled.`);
      return { committed: status !== '', pushed: false };
    }

    for (const pushRemote of pushRemotes) {
      const configuredRemotes = runGit(['remote'], { cwd: repositoryRoot }).split('\n');
      if (!configuredRemotes.includes(pushRemote)) {
        throw new Error(`checkpoint remote ${pushRemote} is not configured in Git`);
      }
      runGit([
        'push',
        ...(remote === pushRemote ? ['--set-upstream'] : []),
        pushRemote,
        `HEAD:refs/heads/${branch}`,
      ], { cwd: repositoryRoot });
      log(`Pushed ${branch} to ${pushRemote}/${branch}.`);
    }
    clearFailureMarker(repositoryRoot);
    return { committed: status !== '', pushed: true };
  } catch (error) {
    try {
      writeFailureMarker(repositoryRoot, error, branch);
    } catch {
      // Preserve the original Git error when recording it also fails.
    }
    throw error;
  }
}

function main() {
  const repositoryRoot = runGit(['rev-parse', '--show-toplevel']);
  const message = parseArguments(process.argv.slice(2));
  checkpoint(repositoryRoot, message);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  checkpoint,
  markerPath,
  parseArguments,
  remoteBranchExists,
  validateMessage,
};

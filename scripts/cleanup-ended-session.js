#!/usr/bin/env node

/**
 * Queue targeted cleanup for the branch used by a Codex session that ended.
 *
 * SessionEnd hooks have a maximum runtime of three seconds, so the hook process
 * captures the worktree identity and launches a detached worker. The worker
 * removes only that worktree and branch, and only when the captured branch tip
 * is still fully merged into the configured remote default branch.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { projectConfig } = require('./project-config');
const {
  applyPlan,
  buildPlan,
  listWorktrees,
} = require('./cleanup-merged-branches.js');
const {
  isPrimaryWorktree,
  logScriptInvocation,
  sourceRepositoryRoot,
} = require('./log-script-invocation.js');

const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 30 * 1000;

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
}

function tryGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return result.status === 0 ? result.stdout.trim() : null;
}

function samePath(first, second) {
  try {
    return fs.realpathSync(first) === fs.realpathSync(second);
  } catch {
    return path.resolve(first) === path.resolve(second);
  }
}

function captureTarget(event) {
  if (event?.hook_event_name !== 'SessionEnd' || typeof event.cwd !== 'string') {
    return null;
  }
  if (isPrimaryWorktree(event.cwd)) {
    return null;
  }
  const { defaultBranch } = projectConfig(event.cwd).git;

  const branch = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], event.cwd);
  if (!branch || branch === defaultBranch) {
    return null;
  }

  const objectId = runGit(['rev-parse', `refs/heads/${branch}`], { cwd: event.cwd });
  const worktrees = listWorktrees(event.cwd);
  const sessionWorktree = worktrees.find((item) => samePath(item.path, event.cwd));

  if (!sessionWorktree || sessionWorktree.branch !== `refs/heads/${branch}`) {
    return null;
  }

  const commonGitDirectory = runGit([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ], { cwd: event.cwd });

  return {
    branch,
    commonGitDirectory,
    objectId,
    repositoryRoot: sourceRepositoryRoot(event.cwd),
    sessionId: event.session_id || null,
    worktreePath: sessionWorktree.path,
  };
}

function fastForwardPrimaryDefaultBranch(repositoryRoot, log) {
  const primaryRoot = sourceRepositoryRoot(repositoryRoot);
  const { remote, defaultBranch } = projectConfig(primaryRoot).git;
  const branch = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], primaryRoot);
  if (branch !== defaultBranch) {
    return false;
  }

  const status = runGit(['status', '--porcelain', '--untracked-files=all'], {
    cwd: primaryRoot,
  });
  if (status !== '') {
    log(`Keep ${defaultBranch}: the primary worktree has changes.`);
    return false;
  }

  const remoteTip = runGit(['rev-parse', `refs/remotes/${remote}/${defaultBranch}`], {
    cwd: primaryRoot,
  });
  const localTip = runGit(['rev-parse', 'HEAD'], { cwd: primaryRoot });
  if (localTip === remoteTip) {
    return false;
  }
  if (tryGit(['merge-base', '--is-ancestor', 'HEAD', remoteTip], primaryRoot) === null) {
    log(`Keep ${defaultBranch}: it cannot fast-forward to ${remote}/${defaultBranch}.`);
    return false;
  }

  log(`Fast-forwarding ${defaultBranch} in the primary worktree to ${remote}/${defaultBranch}.`);
  runGit(['merge', '--ff-only', remoteTip], { cwd: primaryRoot });
  return true;
}

function cleanupTarget(target, log = console.log) {
  const { remote, defaultBranch } = projectConfig(target.repositoryRoot).git;
  const branchRef = `refs/heads/${target.branch}`;
  const currentObjectId = tryGit(['show-ref', '--hash', '--verify', branchRef], target.repositoryRoot);

  if (currentObjectId !== target.objectId) {
    log(`Skip ${target.branch}: the local branch changed after the session ended.`);
    return false;
  }

  const currentWorktrees = listWorktrees(target.repositoryRoot);
  const targetWorktree = currentWorktrees.find((item) => samePath(item.path, target.worktreePath));

  if (targetWorktree) {
    if (targetWorktree.branch !== branchRef) {
      log(`Skip ${target.branch}: the worktree now uses a different branch.`);
      return false;
    }
    if (Object.hasOwn(targetWorktree, 'locked')) {
      log(`Skip ${target.branch}: its worktree is locked.`);
      return false;
    }

    const worktreeObjectId = tryGit(['rev-parse', 'HEAD'], target.worktreePath);
    if (worktreeObjectId !== target.objectId) {
      log(`Skip ${target.branch}: the worktree HEAD changed after the session ended.`);
      return false;
    }

    const status = runGit(['status', '--porcelain', '--untracked-files=all'], {
      cwd: target.worktreePath,
    });
    if (status !== '') {
      log(`Skip ${target.branch}: its worktree has changes.`);
      return false;
    }
  }

  log(`Fetching ${remote} before checking ${target.branch}.`);
  runGit(['fetch', '--prune', remote], { cwd: target.repositoryRoot });
  runGit(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${defaultBranch}`], {
    cwd: target.repositoryRoot,
  });
  fastForwardPrimaryDefaultBranch(target.repositoryRoot, log);

  const item = buildPlan(target.repositoryRoot)
    .find((candidate) => candidate.branch === target.branch);

  if (!item?.local || item.localObjectId !== target.objectId) {
    log(`Keep ${target.branch}: it is not fully merged into ${remote}/${defaultBranch}.`);
    return false;
  }
  if (item.skipReason) {
    log(`Skip ${target.branch}: ${item.skipReason}`);
    return false;
  }
  if (
    item.worktrees.length > 0
    && !item.worktrees.every((worktree) => samePath(worktree.path, target.worktreePath))
  ) {
    log(`Skip ${target.branch}: it is checked out in another worktree.`);
    return false;
  }

  applyPlan(target.repositoryRoot, [item], true, log);
  return true;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_MAX_AGE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') {
          throw statError;
        }
      }

      sleep(200);
    }
  }

  throw new Error('timed out waiting for another session cleanup');
}

function runWorker(target) {
  const lockPath = path.join(target.commonGitDirectory, 'cleanup-ended-session.lock');
  acquireLock(lockPath);

  try {
    console.log(`\nSession cleanup for ${target.branch}`);
    cleanupTarget(target);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function launchWorker(target) {
  const logPath = path.join(target.commonGitDirectory, 'cleanup-ended-session.log');
  const logFile = fs.openSync(logPath, 'a');
  const payload = Buffer.from(JSON.stringify(target)).toString('base64url');
  const child = spawn(process.execPath, [__filename, '--worker', payload], {
    cwd: target.repositoryRoot,
    detached: true,
    stdio: ['ignore', logFile, logFile],
  });

  child.unref();
  fs.closeSync(logFile);
}

function readHookEvent() {
  const input = fs.readFileSync(0, 'utf8').trim();
  return input === '' ? null : JSON.parse(input);
}

function main() {
  logScriptInvocation();
  if (process.argv[2] === '--worker') {
    const target = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
    runWorker(target);
    return;
  }

  const target = captureTarget(readHookEvent());
  if (target) {
    launchWorker(target);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { captureTarget, cleanupTarget };

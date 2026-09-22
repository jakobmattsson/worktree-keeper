#!/usr/bin/env node

/**
 * Remove local and remote branches that are fully merged into the locally known
 * the configured remote default branch. A worktree on an eligible local branch is removed first when it
 * has no tracked or untracked changes.
 *
 * Recommended usage:
 *
 *   npm exec --no -- reusable-scripts cleanup-merged-branches             # Dry-run (default).
 *   npm exec --no -- reusable-scripts cleanup-merged-branches --dry-run   # Explicit dry-run.
 *   npm exec --no -- reusable-scripts cleanup-merged-branches --execute   # Apply the displayed cleanup.
 *
 * Every run fetches the configured remote, including dry-runs, so the cleanup
 * plan uses current remote references. Dry-run does not remove anything,
 * but this fetch still updates local remote references. The script never deletes
 * the configured default branch. It skips the current worktree, locked worktrees,
 * and worktrees with tracked or untracked changes. Ignored files do not count as
 * changes. Local and remote deletions are guarded by the exact commit IDs
 * observed while building the cleanup plan, so a branch changed concurrently is
 * preserved.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { projectConfig } = require('./project-config');

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

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

  return result.stdout;
}

function parseArguments(args) {
  let execute = false;

  for (const argument of args) {
    if (argument === '--execute') {
      execute = true;
    } else if (argument === '--dry-run') {
      execute = false;
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: cleanup-merged-branches.js [--dry-run | --execute]');
      console.log('');
      console.log('Dry-run is the default. Use --execute to remove eligible worktrees and branches.');
      process.exit(0);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }

  return { execute };
}

function mergedBranches(repositoryRoot, namespace) {
  const { remote, defaultBranch } = projectConfig(repositoryRoot).git;
  const output = runGit([
    'for-each-ref',
    `--merged=refs/remotes/${remote}/${defaultBranch}`,
    '--format=%(refname)\t%(objectname)\t%(symref)',
    namespace,
  ], { cwd: repositoryRoot });

  return output
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, , symbolicTarget]) => !symbolicTarget)
    .map(([refName, objectId]) => ({ refName, objectId }));
}

function listWorktrees(repositoryRoot) {
  const fields = runGit(['worktree', 'list', '--porcelain', '-z'], {
    cwd: repositoryRoot,
  }).split('\0');
  const worktrees = [];
  let current = null;

  for (const field of fields) {
    if (field === '') {
      if (current) {
        worktrees.push(current);
        current = null;
      }
      continue;
    }

    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);

    if (key === 'worktree') {
      current = { path: value };
    } else if (current) {
      current[key] = value;
    }
  }

  return worktrees;
}

function samePath(first, second) {
  try {
    return fs.realpathSync(first) === fs.realpathSync(second);
  } catch {
    return path.resolve(first) === path.resolve(second);
  }
}

function branchNameFromLocalRef(refName) {
  return refName.slice('refs/heads/'.length);
}

function branchNameFromRemoteRef(refName, remote) {
  return refName.slice(`refs/remotes/${remote}/`.length);
}

function buildPlan(repositoryRoot) {
  const { remote, defaultBranch } = projectConfig(repositoryRoot).git;
  const localBranches = new Map(
    mergedBranches(repositoryRoot, 'refs/heads')
      .map(({ refName, objectId }) => [branchNameFromLocalRef(refName), objectId]),
  );
  const remoteBranches = new Map(
    mergedBranches(repositoryRoot, `refs/remotes/${remote}`)
      .map(({ refName, objectId }) => [branchNameFromRemoteRef(refName, remote), objectId])
      .filter(([branch]) => branch !== 'HEAD'),
  );

  localBranches.delete(defaultBranch);
  remoteBranches.delete(defaultBranch);

  const currentRoot = runGit(['rev-parse', '--show-toplevel'], {
    cwd: repositoryRoot,
  }).trim();
  const worktrees = listWorktrees(repositoryRoot);
  const names = [...new Set([...localBranches.keys(), ...remoteBranches.keys()])].sort();

  return names.map((branch) => {
    const branchWorktrees = localBranches.has(branch)
      ? worktrees.filter((worktree) => worktree.branch === `refs/heads/${branch}`)
      : [];
    let skipReason = null;

    for (const worktree of branchWorktrees) {
      if (samePath(worktree.path, currentRoot)) {
        skipReason = `it is checked out in the current worktree: ${worktree.path}`;
        break;
      }
      if (Object.hasOwn(worktree, 'locked')) {
        skipReason = `its worktree is locked: ${worktree.path}`;
        break;
      }

      try {
        const status = runGit(
          ['status', '--porcelain', '--untracked-files=all'],
          { cwd: worktree.path },
        );
        if (status !== '') {
          skipReason = `its worktree has changes: ${worktree.path}`;
          break;
        }
      } catch (error) {
        skipReason = `its worktree could not be inspected: ${worktree.path} (${error.message})`;
        break;
      }
    }

    return {
      branch,
      local: localBranches.has(branch),
      localObjectId: localBranches.get(branch),
      remote: remoteBranches.has(branch),
      remoteObjectId: remoteBranches.get(branch),
      worktrees: branchWorktrees,
      skipReason,
    };
  });
}

function printAction(execute, dryRunText, executeText, log) {
  log(execute ? executeText : `Would ${dryRunText}`);
}

function applyPlan(repositoryRoot, plan, execute, log = console.log) {
  const { remote } = projectConfig(repositoryRoot).git;
  let removedWorktrees = 0;
  let deletedLocalBranches = 0;
  let deletedRemoteBranches = 0;
  let skippedBranches = 0;

  for (const item of plan) {
    if (item.skipReason) {
      log(`Skip ${item.branch}: ${item.skipReason}`);
      skippedBranches += 1;
      continue;
    }

    for (const worktree of item.worktrees) {
      printAction(
        execute,
        `remove worktree ${worktree.path} (branch ${item.branch})`,
        `Removing worktree ${worktree.path} (branch ${item.branch})`,
        log,
      );
      if (execute) {
        runGit(['worktree', 'remove', worktree.path], { cwd: repositoryRoot });
      }
      removedWorktrees += 1;
    }

    if (item.local) {
      printAction(
        execute,
        `delete local branch ${item.branch}`,
        `Deleting local branch ${item.branch}`,
        log,
      );
      if (execute) {
        runGit([
          'update-ref',
          '-d',
          `refs/heads/${item.branch}`,
          item.localObjectId,
        ], { cwd: repositoryRoot });

        const configResult = spawnSync(
          'git',
          ['config', '--remove-section', `branch.${item.branch}`],
          { cwd: repositoryRoot, encoding: 'utf8' },
        );
        if (configResult.status !== 0 && configResult.status !== 5) {
          console.warn(
            `Warning: could not remove configuration for branch ${item.branch}: `
              + configResult.stderr.trim(),
          );
        }
      }
      deletedLocalBranches += 1;
    }

    if (item.remote) {
      printAction(
        execute,
        `delete remote branch ${remote}/${item.branch}`,
        `Deleting remote branch ${remote}/${item.branch}`,
        log,
      );
      if (execute) {
        runGit([
          'push',
          `--force-with-lease=refs/heads/${item.branch}:${item.remoteObjectId}`,
          remote,
          `:refs/heads/${item.branch}`,
        ], {
          cwd: repositoryRoot,
        });
      }
      deletedRemoteBranches += 1;
    }
  }

  log('');
  log(
    `${execute ? 'Removed' : 'Would remove'} ${removedWorktrees} worktree(s), `
      + `${deletedLocalBranches} local branch(es), and ${deletedRemoteBranches} remote branch(es).`,
  );
  if (skippedBranches > 0) {
    log(`Skipped ${skippedBranches} branch(es).`);
  }
  if (!execute) {
    log('');
    log('To apply this cleanup, run:');
    log('  npm exec --no -- reusable-scripts cleanup-merged-branches --execute');
  }
}

function main() {
  const { execute } = parseArguments(process.argv.slice(2));

  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('required command not found: git');
  }

  let repositoryRoot;
  try {
    repositoryRoot = runGit(['rev-parse', '--show-toplevel']).trim();
    runGit(['remote', 'get-url', projectConfig(repositoryRoot).git.remote], { cwd: repositoryRoot });
  } catch (error) {
    fail(error.message);
  }

  console.log(execute ? 'Execute mode.' : 'Dry-run mode. No worktrees or branches will be removed.');
  console.log(`Fetching and pruning ${projectConfig(repositoryRoot).git.remote} before building the cleanup plan.`);

  try {
    const { remote, defaultBranch } = projectConfig(repositoryRoot).git;
    runGit(['fetch', '--prune', remote], { cwd: repositoryRoot });
    runGit(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${defaultBranch}`], {
      cwd: repositoryRoot,
    });
  } catch (error) {
    fail(error.message);
  }

  console.log('');

  try {
    const plan = buildPlan(repositoryRoot);
    applyPlan(repositoryRoot, plan, execute);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = { applyPlan, buildPlan, listWorktrees, parseArguments };

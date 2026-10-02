#!/usr/bin/env node

/**
 * Queue targeted cleanup for the current linked feature worktree.
 *
 * This explicit entrypoint is intended for workflows that have already
 * confirmed a pull request merge and need cleanup to start before the Codex
 * task is archived. The detached worker performs the same safety checks as the
 * SessionEnd hook.
 */

const {
  captureWorktreeTarget,
  launchWorker,
} = require('./cleanup-ended-session.js');
const { logScriptInvocation } = require('./log-script-invocation.js');

function helpText() {
  return 'Usage: worktree-keeper queue-merged-worktree-cleanup\n';
}

function queueCurrentWorktree(cwd = process.cwd(), launch = launchWorker) {
  const target = captureWorktreeTarget(cwd);
  if (!target) {
    throw new Error(
      'the current directory must be a linked worktree on a non-default branch',
    );
  }

  const job = launch(target);
  return { ...job, target };
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(helpText());
    return;
  }
  if (args.length > 0) {
    throw new Error(`unknown argument: ${args[0]}`);
  }

  logScriptInvocation();
  const { logPath, pid, target } = queueCurrentWorktree();
  console.log(`Queued cleanup for ${target.branch} at ${target.objectId}.`);
  console.log(`Worker PID: ${pid}. Log: ${logPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { helpText, queueCurrentWorktree };

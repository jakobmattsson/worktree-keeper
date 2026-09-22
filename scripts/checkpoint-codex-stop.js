#!/usr/bin/env node

/**
 * Continue a stopping Codex turn once when its worktree needs a checkpoint.
 *
 * The continuation lets the agent use its task context to choose a meaningful
 * English commit message instead of forcing the hook to invent one.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { markerPath } = require('./checkpoint-codex-changes.js');
const { projectConfig } = require('./project-config');
const {
  isPrimaryWorktree,
  logScriptInvocation,
} = require('./log-script-invocation.js');

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

  return result.stdout.trim();
}

function readFailure(repositoryRoot) {
  const file = markerPath(repositoryRoot);
  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { error: 'the previous checkpoint failed' };
  }
}

function buildResponse(event) {
  if (event?.hook_event_name !== 'Stop' || typeof event.cwd !== 'string') {
    return {};
  }
  if (isPrimaryWorktree(event.cwd)) {
    return {};
  }
  const config = projectConfig(event.cwd);

  const status = runGit(['status', '--porcelain', '--untracked-files=all'], event.cwd);
  const failure = readFailure(event.cwd);

  if (status === '' && !failure) {
    return {};
  }

  if (event.stop_hook_active) {
    const problem = failure?.error || 'uncommitted changes remain';
    return {
      systemMessage: `Codex checkpoint incomplete: ${problem}`,
    };
  }

  const branch = spawnSync(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    { cwd: event.cwd, encoding: 'utf8' },
  );
  const branchInstruction = branch.status === 0 && branch.stdout.trim() !== config.git.defaultBranch
    ? ''
    : ` First create and switch to a descriptive task branch named with the ${config.git.branchPrefix} prefix.`;
  const failureInstruction = failure
    ? ` The previous checkpoint failed with: ${failure.error}. Resolve that failure first.`
    : '';

  return {
    decision: 'block',
    reason: 'The worktree must be checkpointed before you finish.'
      + branchInstruction
      + failureInstruction
      + ' Review the completed diff and write an English commit message with a concise, '
      + 'descriptive single-line subject and a body separated from it by a blank line. '
      + 'The body should explain what the commit does in enough detail for its scope, using '
      + 'between one and ten sentences; avoid unnecessary verbosity, but explain substantial '
      + 'changes thoroughly. Run `npm exec --no -- reusable-scripts '
      + 'checkpoint-codex-changes '
      + '--subject "<subject>" --body "<body paragraph>"`; repeat `--body` for additional '
      + 'paragraphs when useful. '
      + 'Do not make unrelated changes. '
      + 'After the command succeeds, finish your response.',
  };
}

function main() {
  logScriptInvocation();
  const input = fs.readFileSync(0, 'utf8').trim();
  const event = input === '' ? null : JSON.parse(input);
  process.stdout.write(`${JSON.stringify(buildResponse(event))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      systemMessage: `Codex checkpoint check failed: ${error.message}`,
    })}\n`);
  }
}

module.exports = { buildResponse };

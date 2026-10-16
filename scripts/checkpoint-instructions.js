/** Shared policy delivered before work starts and when Stop requests a retry. */
function checkpointInstructions(config) {
  return 'This checkpoint workflow applies only in linked Git worktrees, never in the primary checkout. '
    + 'Follow any explicit user instruction not to commit or push. If such an instruction conflicts '
    + 'with this workflow, do not run the checkpoint command; explain that the checkpoint was skipped '
    + 'at the user\'s request, even if a Stop hook asks for it. '
    + 'Before the final response for a task that changed repository files, review the completed diff '
    + 'and checkpoint the work. If HEAD is detached or the worktree is on the configured default branch '
    + `(${config.git.defaultBranch}), first create and switch to a descriptive task branch named with the ${config.git.branchPrefix} prefix. `
    + 'Write an English commit message with a concise, descriptive single-line subject and a body '
    + 'separated from it by a blank line. The English body should explain the change using between '
    + 'one and ten sentences. Run `npm exec --no -- worktree-keeper checkpoint-codex-changes '
    + '--subject "<subject>" --body "<body paragraph>"`; repeat `--body` for additional paragraphs when useful. '
    + 'The command stages all changes, so do not include unrelated changes. '
    + 'Push behavior follows the project configuration. Unless an explicit user instruction disables '
    + 'this workflow, finish only after the checkpoint succeeds.';
}

module.exports = { checkpointInstructions };

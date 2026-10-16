# Worktree Keeper

Node.js scripts for Codex Git worktree hooks, merged branch cleanup, and cached test receipts. The package requires Node.js 20 or newer and Git. Each calling project supplies its own configuration at its Git root.

## Recommended caller setup

Add the three files below to the calling project. Replace the Git branch settings and test commands with that project's values. Install the package from npm; no GitHub SSH access is needed for the dependency.

### 1. `package.json`

Include these entries in the caller's `package.json`, alongside its other scripts and dependencies. Pin the npm dependency to an exact version and change it deliberately when upgrading. The `lint` script and ESLint dependency are needed only for the `eslint .` test command in this example.

```json
{
  "private": true,
  "scripts": {
    "lint": "eslint .",
    "test": "worktree-keeper run-tests",
    "cleanup:branches": "worktree-keeper cleanup-merged-branches",
    "cleanup:empty-directories": "worktree-keeper remove-empty-directories"
  },
  "devDependencies": {
    "eslint": "^9.39.5"
  },
  "dependencies": {
    "worktree-keeper": "0.8.0"
  }
}
```

Run `npm install` from the project root and commit the resulting `package-lock.json`. npm adds `node_modules/.bin` to the `PATH` of package scripts, so package scripts can call `worktree-keeper` by name.

### 2. `worktree-keeper.config.json`

Place this required file at the caller's Git root. All fields shown here are required and unknown fields are rejected. `git.checkpointPushRemotes` is an optional field described below. There are no built-in test-command defaults: each caller must define `tests.commands` explicitly for its own toolchain.

```json
{
  "git": {
    "remote": "origin",
    "defaultBranch": "main",
    "branchPrefix": "codex/"
  },
  "tests": {
    "commands": ["eslint .", "node --test"],
    "receiptMaxAgeMinutes": 60,
    "npmTestUsesRunner": true
  },
  "loggingDirectory": "tmp/logs"
}
```

`git.remote` and `git.defaultBranch` identify the branch used for checkpointing and cleanup. `git.branchPrefix` names new task branches. `tests.commands` are complete shell commands, run in order from the caller's Git root; install any executables they use. The test runner stops on the first failure and records a receipt only after every command succeeds. `receiptMaxAgeMinutes` controls how long a receipt can be reused. Set `npmTestUsesRunner` to `true` only when the caller's `npm test` script invokes `worktree-keeper run-tests`; this makes the rerun hint `npm test -- rerun`. Otherwise the hint uses the explicit package path. `loggingDirectory` stores hook invocation logs relative to the primary Git worktree's root.

To publish checkpoint branches automatically, add `checkpointPushRemotes` to `git`:

```json
{
  "remote": "origin",
  "defaultBranch": "main",
  "branchPrefix": "codex/",
  "checkpointPushRemotes": ["origin", "backup"]
}
```

Each name must identify a Git remote configured in the calling repository. With this
setting, checkpoints push to exactly those remotes, creating the task branch if
needed. An empty list disables checkpoint pushes. When the field is omitted,
checkpoints keep the previous behavior: push only when the branch already exists
on `git.remote`. Pushes never use force. Only a push to `git.remote` sets the
branch's upstream. If a push fails, earlier pushes are kept and the checkpoint
records a failure; fix the cause and rerun the checkpoint command to retry without
creating another commit when there are no new changes.

Receipts are stored outside the repository under `worktree-keeper-test-receipts` in Node.js's `os.tmpdir()`. Each Git root has a separate receipt file. Receipt validation fingerprints changed files and the process environment. In CI, the runner always runs the configured commands instead of reusing a receipt.

### 3. `.codex/hooks.json`

Place this file in the caller's `.codex` directory:

```json
{
  "description": "Repository lifecycle hooks.",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/node_modules/worktree-keeper/bin/worktree-keeper.js\" checkpoint-codex-stop",
            "timeout": 30,
            "statusMessage": "Checking for an uncommitted Codex checkpoint"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/node_modules/worktree-keeper/bin/worktree-keeper.js\" cleanup-ended-session",
            "timeout": 3,
            "statusMessage": "Scheduling merged branch cleanup"
          }
        ]
      }
    ]
  }
}
```

The commands resolve the package from the current Git worktree. Install dependencies in each worktree where the hooks will run; the commands need that worktree's `node_modules/worktree-keeper`. Both hooks act on linked worktrees and leave the primary worktree alone. When uncommitted changes remain, the `Stop` hook asks the agent to review the diff and run `checkpoint-codex-changes` with a descriptive English commit message. That command stages all changes and commits them on a task branch; it refuses the configured default branch. With `git.checkpointPushRemotes`, it pushes without force to each listed remote, including new branches. Without that setting, it pushes only if the branch already exists on `git.remote`, otherwise the branch stays local.

`SessionEnd` starts a detached worker to clean up the session worktree and branch only if the captured branch tip is still unchanged and fully merged into the remote default branch. Dirty or locked worktrees are kept. Worker output is appended to `cleanup-ended-session.log` in the shared Git directory. Cleanup does not require the primary worktree to have the default branch checked out. A local default branch that can fast-forward is updated before cleanup: a branch not checked out in any worktree is moved atomically, while a checked-out branch is merged in its clean worktree so its files and index stay synchronized. A dirty or diverged default branch is left unchanged. Codex loads project hooks only after the project hook source is trusted; review them with `/hooks`. The three-second `SessionEnd` timeout is the maximum documented for that event. See the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) for hook loading, trust, and timeout behavior.

## Check the setup

From the caller's Git worktree, run `npm test` for the configured commands, `npm test -- rerun` to bypass a reusable receipt, `npm run cleanup:branches` to preview merged branch cleanup, and `npm run cleanup:empty-directories` to preview removal of empty directories and directories containing only ignored files. The latter command protects the root `.git`, `node_modules`, and `tmp` directories; other selected directories are removed recursively, including their ignored contents. Add `-- --execute` to either cleanup package script to apply it. Run `npm exec --no -- worktree-keeper --help` for the complete command list. To create a manual checkpoint, use `npm exec --no -- worktree-keeper checkpoint-codex-changes --subject "<subject>" --body "<body paragraph>"`.

This repository uses the same hooks and configuration, with commands pointing to
its own `bin/worktree-keeper.js` instead of an installed copy. Its `git.checkpointPushRemotes` is set to `["origin"]` to publish checkpoint branches automatically. There is no dependency
on a published version of itself. `npm exec --no -- worktree-keeper` also resolves
the root package's own bin, including the checkpoint command requested by the
Stop hook. Install dependencies with `npm ci` to run the full test suite.

Run `npm test` in this repository to verify the shared package itself, or
`npm test -- rerun` to force a fresh run. Its configured test command runs Node's
test runner directly, avoiding recursion through `npm test`. The cleanup package
scripts work the same way as in calling projects.

When first adopting these hooks, make sure the primary checkout also contains
`worktree-keeper.config.json` before trusting them with `/hooks`: invocation logs
are stored there and session cleanup reads that checkout's configuration.
The hook definitions can then be reviewed and trusted in Codex; committing them
does not grant trust automatically.

## Publish an npm release

Install dependencies with `npm ci`. Review `npm pack --dry-run --json` before
publishing; npm includes only `bin/`, `scripts/`, the README, and package metadata.

Configure npm trusted publishing for this repository and the `package.yml`
GitHub Actions workflow, with direct publishing enabled. The workflow runs tests
and a package dry run, verifies that the tag matches both package versions, and
publishes via OIDC. It needs no npm access token.

From a clean repository root, run `npm run release -- patch`, `minor`, or `major`.
The command fetches the default branch and uses a temporary detached worktree to
increment the package and lockfile versions. Your current branch and local default
branch stay unchanged, including when the default branch is checked out elsewhere.
It pushes a `release/v<version>` branch and opens a release PR. GitHub must allow
squash merging. The command waits up to 20 minutes for GitHub to accept the merge,
respecting required checks, reviews, resolved conversations, and branch freshness.
It never uses an administrator bypass or pushes directly to the default branch.

After merge, the command verifies the package files at the PR's actual merge
commit, tags that commit with `v<version>`, and pushes the tag. The existing
workflow publishes through npm trusted publishing. The command then waits for
the publish job and for the version to appear on npm. Git and an authenticated
GitHub CLI (`gh`) with Contents read/write, Pull requests read/write, and Actions
read access are required. Registry checks use a temporary npm cache and request
current metadata.

Retry the same command and release type after an interruption: release state is
stored in `worktree-keeper-release.json` in the shared Git directory, so retries
from another worktree of the same checkout continue the same PR and version.
Already-merged PRs and already-pushed matching tags are reused. A local lock
prevents concurrent commands in that checkout; an open release PR from a different
checkout blocks a new release. Do not delete the state or manually create a new
version commit or tag to retry. If publishing failed, fix the cause and rerun the
tag workflow on GitHub before retrying the command.

If merge requirements remain unmet, the command stops without tagging. Resolve
those requirements and retry. Conflicts, a changed PR head, or a changed base
require inspection before continuing; the command refuses to silently publish
an altered release. Temporary worktrees are removed when the command exits
normally or with a handled error; a killed process may leave a temporary worktree
that needs manual cleanup.

Other npm projects can use this command through a package script such as
`"release": "worktree-keeper release"`. The project must use a root package
with a stable version and the supported tag-triggered GitHub Actions publish
job. Use `.github/workflows/package.yml` as the template: the `publish` job
must use its exact tag condition and contain a step whose command is exactly
`npm publish`. Workspaces are not supported.

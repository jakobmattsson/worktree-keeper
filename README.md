# Worktree Keeper

Node.js scripts for Codex Git worktree hooks, merged branch cleanup, and cached test receipts. The package requires Node.js 20 or newer and Git. Each calling project supplies its own configuration at its Git root.

## Recommended caller setup

This example follows the working `fonden` setup. Add the three files below to the calling project. Replace the Git branch settings and test commands with that project's values. Once the package is published, install it from npm; no GitHub SSH access is needed for the dependency.

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
    "worktree-keeper": "0.7.1"
  }
}
```

Run `npm install` from the project root and commit the resulting `package-lock.json`. npm adds `node_modules/.bin` to the `PATH` of package scripts, so package scripts can call `worktree-keeper` by name.

### 2. `worktree-keeper.config.json`

Place this required file at the caller's Git root. All fields shown here are required and any extra field is rejected. There are no built-in test-command defaults: each caller must define `tests.commands` explicitly for its own toolchain.

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

`git.remote` and `git.defaultBranch` identify the branch used for checkpointing and cleanup. `git.branchPrefix` names new task branches. `tests.commands` are complete shell commands, run in order from the caller's Git root; install any executables they use. The test runner stops on the first failure and records a receipt only after every command succeeds. `receiptMaxAgeMinutes` controls how long a receipt can be reused. Set `npmTestUsesRunner` to `true` only when the caller's `npm test` script invokes `worktree-keeper run-tests`; this makes the rerun hint `npm test -- rerun`. Otherwise the hint uses the explicit package path. `loggingDirectory` is relative to the caller's Git root.

Receipts are stored outside the repository under `worktree-keeper-test-receipts` in Node.js's `os.tmpdir()`. Each Git root has a separate receipt file. Receipt validation fingerprints changed files and the process environment.

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

The commands resolve the package from the current Git worktree. Install dependencies in each worktree where the hooks will run; the commands need that worktree's `node_modules/worktree-keeper`. The `Stop` hook checks whether a Codex checkpoint is needed, and `SessionEnd` schedules cleanup of a merged session branch. Cleanup does not require the primary worktree to have the default branch checked out. A local default branch that can fast-forward is updated before cleanup: a branch not checked out in any worktree is moved atomically, while a checked-out branch is merged in its clean worktree so its files and index stay synchronized. A dirty or diverged default branch is left unchanged. Codex loads project hooks only after the project hook source is trusted; review them with `/hooks`. The three-second `SessionEnd` timeout is the maximum documented for that event. See the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) for hook loading, trust, and timeout behavior.

## Check the setup

From the caller's Git worktree, run `npm test` for the configured commands, `npm test -- rerun` to bypass a reusable receipt, `npm run cleanup:branches` to preview merged branch cleanup, and `npm run cleanup:empty-directories` to preview removal of directories containing only ignored files. Add `-- --execute` to either cleanup package script to apply it. Run `npm exec --no -- worktree-keeper --help` for the complete command list. To create a manual checkpoint, use `npm exec --no -- worktree-keeper checkpoint-codex-changes --subject "<subject>" --body "<body paragraph>"`.

Run `npm test` in this repository to verify the shared package itself.

## Publish an npm release

Install dependencies with `npm ci`. Review `npm pack --dry-run --json` before
publishing; npm includes only `bin/`, `scripts/`, the README, and package metadata.

Configure npm trusted publishing for this repository and the `package.yml`
GitHub Actions workflow, with direct publishing enabled. The workflow runs tests
and a package dry run, verifies that the tag matches both package versions, and
publishes via OIDC. It needs no npm access token.

From a clean repository root, run `npm run release -- patch`, `minor`, or `major`.
The command checks the GitHub publish workflow, switches to the synchronized
default branch, increments the version in `package.json` and `package-lock.json`,
commits and pushes it, then pushes the matching `v<version>` tag. It waits for
the publish job and for the version to appear on npm. Git and an authenticated
GitHub CLI (`gh`) with repository and Actions access are required. Inspect local
and remote state before retrying an interrupted release.
Registry checks use a temporary npm cache and request current metadata, so a
recently published version is not hidden by an earlier cached response.
If authentication or another preflight check fails, resolve that problem before
retrying the release command; do not create the version commit or tag manually.

Other npm projects can use this command through a package script such as
`"release": "worktree-keeper release"`. The project must use a root package
with a stable version and the supported tag-triggered GitHub Actions publish
job. Use `.github/workflows/package.yml` as the template: the `publish` job
must use its exact tag condition and contain a step whose command is exactly
`npm publish`. Workspaces are not supported.

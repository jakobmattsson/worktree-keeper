# Reusable repository scripts

Node.js scripts for Codex Git worktree hooks, merged branch cleanup, and cached test receipts. The package requires Node.js 20 or newer and Git. Each calling project supplies its own configuration at its Git root.

## Recommended caller setup

This example follows the working `fonden` setup. Add the three files below to the calling project. Replace the Git branch settings and test commands with that project's values. Once the package is published, install it from npm; no GitHub SSH access is needed for the dependency.

### 1. `package.json`

Include these entries in the caller's `package.json`, alongside its other scripts and dependencies. Pin the npm dependency to an exact version and change it deliberately when upgrading. Version 0.6.0 is shown as the planned first registry release; it cannot be installed this way until that release exists. The `lint` script and ESLint dependency are needed only for the `eslint .` test command in this example.

```json
{
  "private": true,
  "scripts": {
    "lint": "eslint .",
    "test": "reusable-scripts run-tests",
    "cleanup:branches": "reusable-scripts cleanup-merged-branches"
  },
  "devDependencies": {
    "eslint": "^9.39.5"
  },
  "dependencies": {
    "reusable-scripts": "0.6.0"
  }
}
```

Run `npm install` from the project root and commit the resulting `package-lock.json`. npm adds `node_modules/.bin` to the `PATH` of package scripts, so the `test` and `cleanup:branches` scripts can call `reusable-scripts` by name.

### 2. `reusable-scripts.config.json`

Place this file at the caller's Git root. If the file exists, all fields shown here are required and any extra field is rejected. The package uses built-in defaults only when the file is absent.

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

`git.remote` and `git.defaultBranch` identify the branch used for checkpointing and cleanup. `git.branchPrefix` names new task branches. `tests.commands` are complete shell commands, run in order from the caller's Git root; install any executables they use. The test runner stops on the first failure and records a receipt only after every command succeeds. `receiptMaxAgeMinutes` controls how long a receipt can be reused. Set `npmTestUsesRunner` to `true` only when the caller's `npm test` script invokes `reusable-scripts run-tests`; this makes the rerun hint `npm test -- rerun`. Otherwise the hint uses the explicit package path. `loggingDirectory` is relative to the caller's Git root.

Receipts are stored outside the repository under `reusable-scripts-test-receipts` in Node.js's `os.tmpdir()`. Each Git root has a separate receipt file. Receipt validation fingerprints changed files and the process environment.

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
            "command": "node \"$(git rev-parse --show-toplevel)/node_modules/reusable-scripts/bin/reusable-scripts.js\" checkpoint-codex-stop",
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
            "command": "node \"$(git rev-parse --show-toplevel)/node_modules/reusable-scripts/bin/reusable-scripts.js\" cleanup-ended-session",
            "timeout": 3,
            "statusMessage": "Scheduling merged branch cleanup"
          }
        ]
      }
    ]
  }
}
```

The commands resolve the package from the current Git worktree. Install dependencies in each worktree where the hooks will run; the commands need that worktree's `node_modules/reusable-scripts`. The `Stop` hook checks whether a Codex checkpoint is needed, and `SessionEnd` schedules cleanup of a merged session branch. Codex loads project hooks only after the project hook source is trusted; review them with `/hooks`. The three-second `SessionEnd` timeout is the maximum documented for that event. See the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) for hook loading, trust, and timeout behavior.

## Check the setup

From the caller's Git worktree, run `npm test` for the configured commands, `npm test -- rerun` to bypass a reusable receipt, and `npm run cleanup:branches` to preview merged branch cleanup. Run `npm exec --no -- reusable-scripts --help` for the complete command list. To create a manual checkpoint, use `npm exec --no -- reusable-scripts checkpoint-codex-changes --subject "<subject>" --body "<body paragraph>"`.

Run `npm test` in this repository to verify the shared package itself.

## Prepare the first npm release

The package name `reusable-scripts` was absent from the public npm registry on
2026-09-22. Check it again immediately before publishing because names can be
claimed at any time. The package remains in this private Git repository; npm
publishes only the files selected by the `files` field in `package.json`, plus
the README and package metadata. A public npm package is downloadable by
anyone even when its Git repository is private.

Before publishing:

1. Decide whether to add a license. Public downloads do not themselves grant
   others permission to modify or redistribute the code.
2. Review `npm pack --dry-run --json` for sensitive or unnecessary files. The
   expected tarball contains the CLI, the `scripts/` directory, `README.md`,
   and `package.json`; tests are excluded.
3. Run `npm test` and test the packed CLI from a separate temporary project.
4. Sign in to the npm account that should own the unscoped package and enable
   two-factor authentication. Publish the first version manually only after
   reviewing the package and the consumer migration. The publishing command is
   `npm publish` from this repository; it is intentionally not automated.
5. After the version is available on npm, change callers from the Git URL to
   the exact registry version, update their lockfiles, and verify `npm ci` and
   their test suites in CI.

Trusted publishing from GitHub Actions can be added after the first release.
It requires a configured trusted publisher on npm and a workflow with OIDC
permission. npm does not currently generate provenance for a public package
published from a private Git repository.

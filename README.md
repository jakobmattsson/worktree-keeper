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

Place this required file at the caller's Git root. All fields shown here are required and unknown fields are rejected. `git.checkpointPushRemotes`, `git.releaseMergeMethod`, `git.releaseRequiredChecks`, and `git.releaseTestWorkflow` are optional fields described below; release commands require `git.releaseRequiredChecks`. Optional `projectChecks` settings are described under local project checks. There are no built-in test-command defaults: each caller must define `tests.commands` explicitly for its own toolchain.

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

Starting a new test run invalidates any previous receipt, including when a forced
rerun fails. The runner compares repository contents and the test environment
before and after the commands. If either changes during the run, it exits with
an error and records no receipt; rerun the tests on the resulting contents.
Test-generated files should be ignored or written outside the repository.

### 3. `.codex/hooks.json`

Install or update the project hooks from the caller's Git worktree:

```sh
npm exec --no -- worktree-keeper install-hooks --dry-run
npm exec --no -- worktree-keeper install-hooks
```

The command creates or updates `.codex/hooks.json` at the Git root. It preserves
other handlers, their order, group settings, and other configuration fields.
Known Worktree Keeper invocations are replaced with current definitions and
duplicates are removed. Our hooks are installed in their own groups, without
inheriting another group's matcher. Repeating the command makes no further change.

Supported migrations include standalone `worktree-keeper`, `npm exec --no --`,
`npx --no-install`, documented `node` bin paths, and direct `node scripts/` hook
invocations. Unknown wrappers, composed shell commands, and additional handler
options are not replaced automatically. If an entry appears related to Worktree
Keeper but cannot be safely migrated, the command exits with an error identifying
it and leaves the entire file unchanged. Review that entry, preserve any custom
logic as a separate hook, then rerun the installer. Wrappers whose names do not
identify Worktree Keeper cannot be detected; review those yourself before installing.

The installer writes atomically and rejects malformed files. It changes only
`.codex/hooks.json`, not `AGENTS.md`, project configuration, or hooks in other
configuration layers. Configure Git remotes, tests, and dependencies separately,
and review and trust the installed hooks with `/hooks` in Codex.

The installed file contains these definitions (other existing hooks are retained):

```json
{
  "description": "Repository lifecycle hooks.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/node_modules/worktree-keeper/bin/worktree-keeper.js\" checkpoint-codex-session-start",
            "timeout": 30,
            "statusMessage": "Loading Codex checkpoint instructions"
          }
        ]
      }
    ],
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

The commands resolve the package from the current Git worktree. Install dependencies in each worktree where the hooks will run; the commands need that worktree's `node_modules/worktree-keeper`. The checkpoint hooks apply only to linked worktrees. `SessionStart` supplies the checkpoint instructions before work begins, including on resume, fork, and after compaction; no matcher is needed. `Stop` uses the same package-owned instructions as a fallback. You do not need to copy checkpoint rules into each project's `AGENTS.md`. Explicit user instructions not to commit or push take precedence: the agent must skip the checkpoint command when they conflict, even if `Stop` requests it. The hook checks Git state and cannot determine user intent itself. When uncommitted changes remain, the `Stop` hook asks the agent to review the diff and run `checkpoint-codex-changes` with a descriptive English commit message. That command stages all changes and commits them on a task branch; it refuses the configured default branch. With `git.checkpointPushRemotes`, it pushes without force to each listed remote, including new branches. Without that setting, it pushes only if the branch already exists on `git.remote`, otherwise the branch stays local.

`SessionEnd` starts a detached worker to clean up the session worktree and branch only if the captured branch tip is still unchanged and fully merged into the remote default branch. Dirty or locked worktrees are kept. Worker output is appended to `cleanup-ended-session.log` in the shared Git directory. Cleanup does not require the primary worktree to have the default branch checked out. A local default branch that can fast-forward is updated before cleanup: a branch not checked out in any worktree is moved atomically, while a checked-out branch is merged in its clean worktree so its files and index stay synchronized. A dirty or diverged default branch is left unchanged. Codex loads project hooks only after the project hook source is trusted; review them with `/hooks`. The three-second `SessionEnd` timeout is the maximum documented for that event. See the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) for hook loading, trust, and timeout behavior.

### Adopting shared checkpoint instructions

For a project that already uses the Stop hook, upgrade to a package release that
includes `checkpoint-codex-session-start` and `install-hooks`, then run the installer above.
The installer also updates `Stop` and `SessionEnd`. Review and trust the updated hooks with `/hooks`,
then start a new session or resume one to load the instructions. These commands
are not available in older releases, including the pinned `0.8.0` example above;
update that pin when adopting this feature after publication.

Remove the duplicated checkpoint section from the project's `AGENTS.md` once the
new hook is enabled. Keep any project-specific rules there. Installing the npm
dependency alone does not activate hooks: each caller must configure and trust
them. The shared policy then follows the installed package version.

## Check the setup

From the caller's Git worktree, run `npm test` for the configured commands, `npm test -- rerun` to bypass a reusable receipt, `npm run cleanup:branches` to preview merged branch cleanup, and `npm run cleanup:empty-directories` to preview removal of empty directories and directories containing only ignored files. The latter command protects the root `.git`, `node_modules`, and `tmp` directories; other selected directories are removed recursively, including their ignored contents. Add `-- --execute` to either cleanup package script to apply it. Run `npm exec --no -- worktree-keeper --help` for the complete command list. To create a manual checkpoint, use `npm exec --no -- worktree-keeper checkpoint-codex-changes --subject "<subject>" --body "<body paragraph>"`.

Directory cleanup also preserves nested Git repositories and linked worktrees,
including their parent directories when those parents are ignored. It does not
clean inside those repositories. Branch cleanup rechecks local branch tips and
worktree identity, locks, and changes before removal; a changed plan is skipped
before deleting the affected worktree or branches. Remote branch deletion still
uses an exact-commit lease.

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

## Check project conventions locally

Run `worktree-keeper check-project` from any directory in a repository to validate
its development configuration. The command reads local files, makes no network
requests, runs no project scripts, and changes no files. It reports errors by
category and exits with status 1 on any failure.

The checks cover:

- **Tools:** exact `volta.node` and `volta.npm` pins, Node compatibility with
  `engines.node`, and any remaining `.nvmrc` matching the Node pin. Node-based CI
  jobs must check out the project and use `volta-cli/action` before Node/npm
  commands, without competing setup actions or toolchain overrides.
- **Hooks:** the lifecycle hooks supplied by `install-hooks` must be present once
  each, use current definitions, and have no group conditions. Unrelated hooks
  are allowed. Run `worktree-keeper install-hooks` to repair old definitions.
- **CI:** all workflows must use `actions/checkout@v5` or newer and
  `volta-cli/action@v5` or newer when those actions are present. These minimums
  avoid their deprecated Node.js 20 runtimes; stable version tags are required
  because SHA and branch refs cannot be verified offline. Runner labels must
  avoid moving `*-latest` images; use a versioned image such as `ubuntu-24.04`.
  Direct labels, label objects, and `matrix.<key>` references (including matrix
  `include` entries) are checked. Other dynamic runner expressions are not resolved.
  These checks catch known configuration issues, not every possible GitHub annotation.
  The selected workflow must run on PRs targeting the default branch,
  without path or event-type filters. Required jobs and their dependencies must
  not skip PR checks or allow failure. Required test jobs must run `npm ci`
  before tests or package validation, with neither step conditional or allowed
  to fail.
- **Publication:** for packages without `private: true`, package and lockfile
  versions must match. The publish workflow must support the release tag, run
  `npm ci` and then `verify-release` before `npm publish`, declare the verifier's
  token/tag inputs, and grant Contents read and OIDC write permissions. Configured
  release checks must exist in the selected PR workflow. Private packages skip
  publication checks.

By default, the PR workflow is `git.releaseTestWorkflow` or `test.yml`, and required
job names come from `git.releaseRequiredChecks` or default to `test`. To select
other names, add this optional section to `worktree-keeper.config.json`:

```json
"projectChecks": {
  "testWorkflow": "ci.yml",
  "requiredJobs": ["Full test suite", "Test package"]
}
```

Job names are static display names (`name`), or job IDs when no display name is
set. Published projects must select the same workflow as release verification;
`git.releaseRequiredChecks` are always checked in addition to explicit required
jobs. These are declared local requirements: checking actual branch protection,
secret access, successful GitHub runs, and npm trusted publisher settings remains
an online operation outside this command.

Static inspection supports direct `npm test`, `npm run test`,
`npm run test:<name>`, and `npm pack --dry-run` (optionally with `--json`).
Install/test steps hidden inside shell wrappers or reusable workflows cannot be
verified and fail with an explanation. Conditional reporting steps after tests
are allowed. The command does not inspect the test scripts' internal behavior,
validate installed dependency versions, or check Git remotes and ignored files.

For a normal npm test chain, add a `pretest` script (prepend to an existing one
rather than replacing it):

```json
"pretest": "worktree-keeper check-project"
```

This runs the checks before `npm test`, including before `run-tests` can reuse a
cached test receipt. The command can also be placed first in `tests.commands`,
but that placement alone does not run it when the whole test chain is skipped
through receipt reuse. This repository uses `pretest` with its local CLI path.

## Publish an npm release

Install [Volta](https://volta.sh/) and ensure its shims are first in `PATH`
(`volta setup` configures supported shell profiles; restart your shell afterward).
Then run `npm ci` at the repository root. Volta automatically selects the exact
Node.js and npm versions in `package.json` for ordinary `node`, `npm`, and `npx`
commands, including in non-interactive agent shells with Volta on `PATH`.
GitHub Actions uses `volta-cli/action` to select the same project versions.
Check `volta which node`, `node --version`, and `npm --version` to verify your
setup. Use `volta pin node@<version> npm@<version>` to update the project versions;
`engines.node` separately describes supported consumer versions.
Review `npm pack --dry-run --json` before
publishing; npm includes only `bin/`, `scripts/`, the README, and package metadata.

Configure npm trusted publishing for this repository and the `package.yml`
GitHub Actions workflow, with direct publishing enabled. The workflow verifies
the release and publishes via OIDC. It needs no npm access token.

`test.yml` runs `test` and `Test package` on pull requests. `package.yml` runs
on `v*` tags and only verifies and publishes. Merging to `main` does not start
another run.

Release verification uses GitHub's enforced branch policy instead of retaining
artifacts of tested contents. Configure `git.releaseRequiredChecks` in the root
`worktree-keeper.config.json` with the exact CI job names required for a release
(for this repository: `["test", "Test package"]`). These checks must be mandatory
with **Require branches to be up to date before merging** enabled. Classic branch
protection must enforce checks for administrators too. Alternatively, active
rulesets must require strict checks and have no bypass actors. Rules inherited
from the organization are included. Merge queues are not currently an alternative
to this strict policy.

The PR test job runs `worktree-keeper verify-release-protection` before its tests.
The command checks `GITHUB_BASE_REF`, or `git.defaultBranch` outside PR CI.
`worktree-keeper release` checks the default branch before preparing a release
and again immediately before each merge attempt. Before publishing,
`worktree-keeper verify-release` checks the policy, matching package/tag/lockfile
versions, a same-repository merged `release/v<version>` PR, and successful required
jobs in its latest PR workflow run. Manual tags without that PR are rejected.
`verify-release-version` remains available for local version checks alone.

API failures, missing permissions, and unverifiable rules stop the commands.
The workflow expects a `RELEASE_POLICY_TOKEN` Actions secret, exposed to the
commands as `GH_TOKEN`. Use a fine-grained PAT or GitHub App token with access to
this repository and Administration read, Contents read, Pull requests read and
Actions read permissions. GitHub only exposes ruleset bypass actors to callers
with write access to the ruleset; ruleset users must additionally grant that
access (Administration write for repository rulesets, or the appropriate access
for inherited organization rulesets). Missing bypass information also fails.
The normal workflow `GITHUB_TOKEN` cannot be granted Administration permissions
through workflow YAML. After correcting access or rules, rerun the failed job.
Fork PRs do not receive this secret and fail the policy check; do not expose it
by executing fork code with `pull_request_target`.

To set this up for this repository:

1. Open the [token creation form with the required read permissions prefilled](https://github.com/settings/personal-access-tokens/new?name=worktree-keeper-release-policy&target_name=jakobmattsson&expires_in=90&administration=read&contents=read&pull_requests=read&actions=read).
   For repository rulesets, use the [form with Administration write instead](https://github.com/settings/personal-access-tokens/new?name=worktree-keeper-release-policy&target_name=jakobmattsson&expires_in=90&administration=write&contents=read&pull_requests=read&actions=read)
   so GitHub exposes bypass actors. For another repository, change the resource
   owner. Select **Only select repositories**, choose `worktree-keeper`, review
   the permissions and expiration, and generate the token. If the owner requires
   approval, wait until the token is approved.
2. Save the token as an Actions secret with the following command. `gh` prompts
   for the value interactively; paste the token at the prompt, keeping it out of
   the command and shell history. The `gh` account running this command needs
   permission to manage repository Actions secrets. The policy token itself
   does not need Secrets permission.

   ```sh
   gh secret set RELEASE_POLICY_TOKEN --repo jakobmattsson/worktree-keeper
   ```

3. Confirm the secret name exists, then find and rerun the failed test workflow:

   ```sh
   gh secret list --repo jakobmattsson/worktree-keeper
   gh run list --repo jakobmattsson/worktree-keeper --workflow test.yml --limit 5
   gh run rerun RUN_ID --failed --repo jakobmattsson/worktree-keeper
   ```

   Replace `RUN_ID` with the run ID from the listing. To retry publication, list
   runs with `--workflow package.yml` instead. When the token expires, create a
   replacement and run `gh secret set` again to update the same secret.

GitHub requires fine-grained PAT creation in the browser; `gh` can store the
resulting token as a secret but cannot create that PAT. See [GitHub's token setup
documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters)
and the [`gh secret set` reference](https://cli.github.com/manual/gh_secret_set).

This policy trusts GitHub to enforce the checked settings when merging. It does
not retain historical proof of the tested file tree if administrators change
settings between CI and merge. Keep the `package.yml` filename unchanged: npm
trusted publishing is configured for that workflow file.

Release merge selection reads the calling repository's root
`worktree-keeper.config.json`, not the installed package's configuration:

- If GitHub allows only one merge method, that method is used regardless of the preference.
- If multiple methods are allowed, optional `git.releaseMergeMethod` selects
  `"merge"` (merge commit), `"rebase"`, or `"squash"`. A configured method that
  GitHub disallows causes the release to stop before creating a branch or PR.
- Without a preference, merge commit is chosen first, then rebase.

For example, add `"releaseMergeMethod": "rebase"` inside the existing `git` object.
A caller without a merge preference uses the same defaults.
The chosen method is saved with release state and reused on retries; unfinished
releases created by older versions retain their original squash behavior.

From a clean repository root, run `npm run release -- patch`, `minor`, or `major`.
The command fetches the default branch and uses a temporary detached worktree to
increment the package and lockfile versions. Your current branch and local default
branch stay unchanged, including when the default branch is checked out elsewhere.
It pushes a `release/v<version>` branch and opens a release PR. The merge method
follows the calling repository's configuration and GitHub settings. The command
waits up to 20 minutes for GitHub to accept the merge,
respecting required checks, reviews, resolved conversations, and branch freshness.
It never uses an administrator bypass or pushes directly to the default branch.

After merge, the command verifies the package files at the PR's actual merge
commit, tags that commit with `v<version>`, and pushes the tag. The existing
workflow publishes through npm trusted publishing. The command then waits for
the publish job and for the version to appear on npm. Git and an authenticated
GitHub CLI (`gh`) with Contents read/write, Pull requests read/write, Actions
read and the policy-reading access described above are required. Registry checks
use a temporary npm cache and request current metadata.

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
with a stable version, a `worktree-keeper.config.json` with
`git.releaseRequiredChecks`, and the supported tag-triggered GitHub Actions
publish job. Add `worktree-keeper verify-release-protection` to a required PR
test job and `worktree-keeper verify-release` before publishing, with `GH_TOKEN`
and `RELEASE_TAG` set for release verification. Both commands are shipped with
the package; no verifier script or artifact upload needs to be copied.
Set optional `git.releaseTestWorkflow` to the PR workflow filename (for this
repository: `"test.yml"`). If omitted, verification uses the publish workflow
filename for compatibility with combined workflows. All configured check names
must be jobs in the selected PR workflow's run.
The `publish` job must contain a step whose command is exactly `npm publish`.
Its `if` can be omitted when the workflow triggers only on pushes of
`v`-prefixed tags (for example, `on.push.tags: ['v*']`), with no branch triggers.
For combined workflows or other triggers, the job must use the exact condition
`${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}`.
Explicit alternative job conditions are not supported. Workspaces are not supported.

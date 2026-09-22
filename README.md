# Reusable repository scripts

Node.js scripts for Codex Git worktree hooks, merged branch cleanup, and cached test receipts. The scripts use only Node.js built-ins and Git.

Install this repository from a Git remote and run `reusable-scripts <command>` from the caller's Git worktree. The hook entry points use the `cwd` from the hook event.

Each project can place `reusable-scripts.config.json` at its Git root. All fields are optional:

```json
{
  "git": {
    "remote": "origin",
    "mainBranch": "main",
    "taskBranchPrefix": "codex/"
  },
  "tests": {
    "commands": [["npm", "run", "lint"], ["node", "--test"]],
    "excludedPaths": ["data/source/"],
    "receiptMaxAgeMs": 3600000,
    "receiptDirectory": "reusable-scripts-test-receipts",
    "rerunCommand": "npm test -- rerun"
  },
  "logging": { "directory": "tmp/logs" }
}
```

`tests.commands` are argument arrays run in order from the caller's root. Receipt validation fingerprints changed files, the configured exclusions, and the process environment. The Git settings govern checkpointing and branch cleanup. The hook and cleanup messages show the package's own CLI command.

The `Stop` hook calls `reusable-scripts checkpoint-codex-stop` and the `SessionEnd` hook calls `reusable-scripts cleanup-ended-session`. The manual checkpoint command is `reusable-scripts checkpoint-codex-changes`. To run the cached test suite, call `reusable-scripts run-tests`; pass `rerun` to force a run. To inspect or delete merged branches, call `reusable-scripts cleanup-merged-branches` with `--dry-run` or `--execute`.

Run `npm test` in this repository to verify the shared scripts.

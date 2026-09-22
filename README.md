# Reusable repository scripts

Node.js scripts for Codex Git worktree hooks, merged branch cleanup, and cached test receipts. The scripts use only Node.js built-ins and Git.

Install this repository from a Git remote. From the caller's Git worktree, run `npm exec --no -- reusable-scripts <command>` in a shell, or use `reusable-scripts <command>` inside an npm script. Run `npm exec --no -- reusable-scripts --help` for the command list. The hook entry points use the `cwd` from the hook event.

Each project can place `reusable-scripts.config.json` at its Git root. All fields are optional:

```json
{
  "git": {
    "remote": "origin",
    "defaultBranch": "main",
    "branchPrefix": "codex/"
  },
  "tests": {
    "commands": ["npm run lint", "node --test"],
    "excludedPaths": ["data/source/"],
    "receiptMaxAgeMinutes": 60,
    "rerunCommand": "npm test -- rerun"
  },
  "loggingDirectory": "tmp/logs"
}
```

`tests.commands` are shell command strings run in order from the caller's Git root. Quote paths or arguments as you would in a terminal. Test receipts are stored under `reusable-scripts-test-receipts` in Node.js's `os.tmpdir()`. Each project has a receipt file named after a hash of its Git root; the directory is created when the test runner successfully records a receipt. Receipt validation fingerprints changed files, the configured exclusions, and the process environment. The Git settings govern checkpointing and branch cleanup. The hook and cleanup messages show the package's own CLI command.

The `Stop` hook calls `reusable-scripts checkpoint-codex-stop` and the `SessionEnd` hook calls `reusable-scripts cleanup-ended-session`. The manual checkpoint command is `npm exec --no -- reusable-scripts checkpoint-codex-changes`. To run the cached test suite, call `npm exec --no -- reusable-scripts run-tests`; pass `rerun` to force a run. To inspect or delete merged branches, call `npm exec --no -- reusable-scripts cleanup-merged-branches` with `--dry-run` or `--execute`.

Run `npm test` in this repository to verify the shared scripts.

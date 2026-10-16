#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { repositoryRoot } = require('./project-config');

const DEFINITIONS = [
  ['SessionStart', 'checkpoint-codex-session-start', 30, 'Loading Codex checkpoint instructions'],
  ['Stop', 'checkpoint-codex-stop', 30, 'Checking for an uncommitted Codex checkpoint'],
  ['SessionEnd', 'cleanup-ended-session', 3, 'Scheduling merged branch cleanup'],
];
const COMMANDS = DEFINITIONS.map(([, command]) => command);

// Recognize complete, standalone invocations only. Shell composition, arguments,
// environment assignments, and wrappers require inspection instead of replacement.
function classifyCommand(command) {
  if (typeof command !== 'string') return 'other';
  const related = /worktree-keeper|checkpoint-codex-(?:stop|session-start)|cleanup-ended-session/.test(command);
  if (!related) return 'other';
  const text = command.trim();
  const action = COMMANDS.find((name) => text.endsWith(` ${name}`) || text.endsWith(`\t${name}`));
  if (!action) {
    const legacy = /^(?:node\s+)(?:\.\/)?(?:node_modules\/worktree-keeper\/)?scripts\/(checkpoint-codex-stop|checkpoint-codex-session-start|cleanup-ended-session)\.js$/;
    return legacy.test(text) ? 'owned' : 'ambiguous';
  }
  const executable = text.slice(0, -action.length).trim();
  if (/^(?:worktree-keeper|npm\s+exec\s+--no\s+--\s+worktree-keeper|npx\s+--no-install\s+worktree-keeper)$/.test(executable)) {
    return 'owned';
  }
  // Accept the documented Git-root resolution with optional path quotes.
  const gitRoot = '\\$\\(git\\s+rev-parse\\s+--show-toplevel\\)';
  const binPath = '(?:/node_modules/worktree-keeper)?/bin/worktree-keeper\\.js';
  const relativePath = '(?:\\./)?(?:node_modules/worktree-keeper/)?bin/worktree-keeper\\.js';
  const paths = [gitRoot + binPath, relativePath];
  const invocations = paths.flatMap((value) => [`"${value}"`, value]);
  invocations.push(`'${relativePath}'`);
  const directPath = new RegExp(`^node\\s+(?:${invocations.join('|')})$`);
  if (directPath.test(executable)) return 'owned';
  return 'ambiguous';
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function planHooks(document, localSource = false) {
  if (!object(document) || (document.hooks !== undefined && !object(document.hooks))) {
    throw new Error('hooks.json must contain an object with an optional hooks object');
  }
  const result = structuredClone(document);
  result.hooks ??= {};
  const changes = [];
  for (const [event, groups] of Object.entries(result.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    const keptGroups = [];
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) {
        throw new Error(`hooks.${event} contains an invalid hook group`);
      }
      const kept = [];
      for (const handler of group.hooks) {
        if (!object(handler)) throw new Error(`hooks.${event} contains an invalid handler`);
        if (classifyCommand(handler.commandWindows) !== 'other') {
          throw new Error(`Review Windows-specific worktree-keeper hook in ${event}: ${handler.commandWindows}`);
        }
        const classification = classifyCommand(handler.command);
        if (classification === 'ambiguous') {
          throw new Error(`Review possible worktree-keeper hook in ${event}: ${handler.command}`);
        }
        if (classification === 'owned') {
          const allowed = ['type', 'command', 'timeout', 'statusMessage'];
          if (handler.type !== 'command' || Object.keys(handler).some((key) => !allowed.includes(key))) {
            throw new Error(`Review customized worktree-keeper hook in ${event}: ${handler.command}`);
          }
          changes.push(`Replace existing worktree-keeper hook in ${event}`);
        } else {
          kept.push(handler);
        }
      }
      if (kept.length || group.hooks.length === 0) keptGroups.push({ ...group, hooks: kept });
    }
    result.hooks[event] = keptGroups;
  }
  const prefix = localSource ? '' : 'node_modules/worktree-keeper/';
  for (const [event, command, timeout, statusMessage] of DEFINITIONS) {
    result.hooks[event] ??= [];
    result.hooks[event].push({ hooks: [{
      type: 'command',
      command: `node "$(git rev-parse --show-toplevel)/${prefix}bin/worktree-keeper.js" ${command}`,
      timeout,
      statusMessage,
    }] });
    changes.push(`Install ${event}: ${command}`);
  }
  return { document: result, changes };
}

function install({ cwd = process.cwd(), dryRun = false, log = console.log } = {}) {
  const root = repositoryRoot(cwd);
  const file = path.join(root, '.codex', 'hooks.json');
  let original = null;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing to replace a symlink hooks.json');
    original = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const localSource = fs.realpathSync(root) === fs.realpathSync(path.resolve(__dirname, '..'));
  const plan = planHooks(original === null ? {} : JSON.parse(original), localSource);
  const serialized = `${JSON.stringify(plan.document, null, 2)}\n`;
  if (original !== null && JSON.stringify(JSON.parse(original)) === JSON.stringify(plan.document)) {
    log('Worktree Keeper hooks are already up to date.');
    return;
  }
  for (const change of plan.changes) log(change);
  if (dryRun) {
    log(`Would update ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, {
      flag: 'wx', mode: original === null ? 0o644 : fs.statSync(file).mode & 0o777,
    });
    // Avoid overwriting edits made while constructing the plan.
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== original) throw new Error('hooks.json changed during installation; retry');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`Updated ${file}. Review and trust the hooks with /hooks in Codex.`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: worktree-keeper install-hooks [--dry-run]');
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) {
    throw new Error('Usage: worktree-keeper install-hooks [--dry-run]');
  }
  install({ dryRun: args.includes('--dry-run') });
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { classifyCommand, planHooks, install };

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROTECTED_ROOT_DIRECTORIES = new Set(['.git', 'node_modules', 'tmp']);

function findRepositoryRoot(cwd) {
  return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

function listPresentFiles(root) {
  const output = execFileSync(
    'git',
    [
      '-C',
      root,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ],
    { encoding: 'buffer' },
  );

  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => fs.lstatSync(path.join(root, relativePath), {
      throwIfNoEntry: false,
    }));
}

function requiredDirectories(root, files) {
  const required = new Set();

  for (const file of files) {
    const absolutePath = path.join(root, file);
    let directory = fs.lstatSync(absolutePath).isDirectory()
      ? file
      : path.posix.dirname(file);

    while (directory !== '.') {
      required.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  return required;
}

function findEmptyDirectories(root) {
  const required = requiredDirectories(root, listPresentFiles(root));
  const empty = [];

  function visit(absoluteDirectory, relativeDirectory) {
    for (const entry of fs.readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      if (
        relativeDirectory === ''
        && PROTECTED_ROOT_DIRECTORIES.has(entry.name)
      ) continue;

      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);

      if (required.has(relativePath)) {
        visit(absolutePath, relativePath);
      } else {
        empty.push(relativePath);
      }
    }
  }

  visit(root, '');
  return empty;
}

function removeEmptyDirectories(root, directories) {
  for (const directory of directories) {
    fs.rmSync(path.join(root, directory), { recursive: true });
  }
}

function parseArguments(args) {
  let execute = false;

  for (const argument of args) {
    if (argument === '--execute') {
      execute = true;
    } else if (argument === '--dry-run') {
      execute = false;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return { execute };
}

function run({ args, cwd, log }) {
  const { execute } = parseArguments(args);
  const root = findRepositoryRoot(cwd);
  const directories = findEmptyDirectories(root);

  if (directories.length === 0) {
    log('No empty directories found.');
    return;
  }

  if (execute) {
    removeEmptyDirectories(root, directories);
    for (const directory of directories) log(`Removed ${directory}`);
    return;
  }

  for (const directory of directories) log(`Would remove ${directory}`);
  log('');
  log('To remove these directories, run:');
  log('  npm exec --no -- worktree-keeper remove-empty-directories --execute');
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: remove-empty-directories.js [--dry-run | --execute]');
    console.log('');
    console.log('Dry-run is the default. Use --execute to remove directories containing only ignored files.');
    return;
  }

  try {
    run({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      log: console.log,
    });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  findEmptyDirectories,
  parseArguments,
  removeEmptyDirectories,
  run,
};

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const semver = require('semver');
const YAML = require('yaml');
const { projectConfig } = require('./project-config');
const { planHooks, classifyCommand } = require('./install-hooks');
const { inspectWorkflow, ensureLockfilesMatch } = require('./release-core');

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function read(root, file, parse = JSON.parse) {
  try { return parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}
function unconditional(value) {
  return value === undefined || value === 'success()' || value === '${{ success() }}';
}
function directCommand(step, expression) {
  return typeof step?.run === 'string' && expression.test(step.run.trim());
}
const testCommand = /^npm (?:test|run test(?::[\w-]+)?|pack --dry-run(?: --json)?)$/u;
const installCommand = /^npm ci$/u;
const verifyCommand = /^(?:worktree-keeper|npm exec --no -- worktree-keeper|node (?:\.\/)?(?:node_modules\/worktree-keeper\/)?bin\/worktree-keeper\.js) verify-release$/u;

function checkProject(cwd = process.cwd()) {
  const config = projectConfig(cwd);
  const root = config.root;
  const manifest = read(root, 'package.json');
  const errors = [];
  const check = (category, action) => {
    try { action(); } catch (error) { errors.push(`[${category}] ${error.message}`); }
  };
  const workflows = new Map();
  check('CI', () => {
    const directory = path.join(root, '.github/workflows');
    for (const file of fs.readdirSync(directory).filter(file => /\.ya?ml$/u.test(file))) {
      const document = read(root, `.github/workflows/${file}`, YAML.parse);
      requireThat(document && typeof document.jobs === 'object' && document.jobs !== null, `${file}: declare workflow jobs.`);
      workflows.set(file, document);
    }
    requireThat(workflows.size, 'Add a PR workflow in .github/workflows.');
  });

  check('tools', () => {
    for (const name of ['node', 'npm']) {
      requireThat(semver.valid(manifest.volta?.[name]) === manifest.volta?.[name] && typeof manifest.volta?.[name] === 'string',
        `package.json: pin an exact volta.${name} version with volta pin.`);
    }
    requireThat(typeof manifest.engines?.node === 'string' && semver.validRange(manifest.engines.node)
      && semver.satisfies(manifest.volta.node, manifest.engines.node),
    'package.json: volta.node must satisfy engines.node.');
    if (fs.existsSync(path.join(root, '.nvmrc'))) {
      requireThat(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/u, '') === manifest.volta.node,
        '.nvmrc conflicts with volta.node; remove it or align the version.');
    }
    for (const [file, workflow] of workflows) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        const steps = job?.steps || [];
        const nodeSteps = steps.filter(step => /^(?:actions\/setup-node|volta-cli\/action)@/u.test(step?.uses || '')
          || /\b(?:node|npm|npx|volta)\s/u.test(step?.run || ''));
        if (!nodeSteps.length) continue;
        const toolIndex = steps.findIndex(step => /^volta-cli\/action@/u.test(step?.uses || ''));
        requireThat(toolIndex >= 0, `${file}/${id}: use volta-cli/action to select project Node and npm versions.`);
        requireThat(steps.filter(step => /^volta-cli\/action@/u.test(step?.uses || '')).length === 1, `${file}/${id}: use one Volta setup step per job.`);
        const tool = steps[toolIndex];
        requireThat(unconditional(tool.if) && !tool['continue-on-error'], `${file}/${id}: Volta setup must not be conditional or allowed to fail.`);
        requireThat(steps.slice(0, toolIndex).some(step => /^actions\/checkout@/u.test(step?.uses || '') && unconditional(step.if) && !step['continue-on-error']),
          `${file}/${id}: check out the project before Volta setup.`);
        requireThat(!['node-version', 'npm-version', 'package-json-path'].some(key => Object.hasOwn(tool.with || {}, key)),
          `${file}/${id}: remove Volta version/path overrides; use package.json.`);
        requireThat(!steps.some(step => /^actions\/setup-node@/u.test(step?.uses || '')
          || /\b(?:nvm\s+(?:use|install)|volta\s+(?:install|pin|run)|npm\s+(?:i|install)\s+(?:--global|-g)\b)/u.test(step?.run || '')),
        `${file}/${id}: remove competing Node/npm setup commands.`);
        requireThat(!steps.slice(0, toolIndex).some(step => /\b(?:node|npm|npx)\s/u.test(step?.run || '')),
          `${file}/${id}: set up Volta before Node/npm commands.`);
      }
    }
  });

  check('hooks', () => {
    const document = read(root, '.codex/hooks.json');
    const localSource = fs.realpathSync(root) === fs.realpathSync(path.resolve(__dirname, '..'));
    const expected = planHooks(document, localSource).document;
    for (const event of new Set([...Object.keys(document.hooks || {}), ...Object.keys(expected.hooks)])) {
      const owned = groups => groups.flatMap(group => {
        const handlers = group.hooks.filter(hook => classifyCommand(hook.command) !== 'other');
        if (handlers.length) requireThat(Object.keys(group).every(key => key === 'hooks'),
          '.codex/hooks.json: worktree-keeper lifecycle hooks must not have group conditions.');
        return handlers;
      });
      requireThat(isDeepStrictEqual(owned(document.hooks?.[event] || []), owned(expected.hooks[event] || [])),
        `.codex/hooks.json: missing, duplicate or outdated ${event} lifecycle hooks; run worktree-keeper install-hooks.`);
    }
  });

  const published = manifest.private !== true;
  const filename = config.projectChecks?.testWorkflow || config.git.releaseTestWorkflow || 'test.yml';
  const required = [...new Set([...(config.projectChecks?.requiredJobs || config.git.releaseRequiredChecks || ['test']), ...(published ? config.git.releaseRequiredChecks || [] : [])])];
  check('CI', () => {
    const workflow = workflows.get(filename);
    requireThat(workflow, `${filename}: configured PR workflow is missing.`);
    const on = workflow.on;
    const simpleTrigger = on === 'pull_request' || (Array.isArray(on) && on.includes('pull_request'));
    requireThat(simpleTrigger || (on && typeof on === 'object' && Object.hasOwn(on, 'pull_request')), `${filename}: declare an on.pull_request trigger.`);
    const filters = simpleTrigger ? null : on.pull_request;
    requireThat(filters === null || (typeof filters === 'object' && !Array.isArray(filters)
      && !['paths', 'paths-ignore', 'branches-ignore', 'types'].some(key => Object.hasOwn(filters, key))
      && (!filters.branches || (Array.isArray(filters.branches) && filters.branches.includes(config.git.defaultBranch)))),
    `${filename}: PR filters must include the default branch and must not skip required checks by path or event type.`);
    const checked = new Set();
    function requiredJob(id, job, testsRequired) {
      requireThat(job && typeof job === 'object', `${filename}/${id}: required job is missing.`);
      requireThat(unconditional(job.if) || job.if === "${{ github.event_name == 'pull_request' }}", `${filename}/${id}: required PR job must not be skipped by an if condition.`);
      requireThat(!job['continue-on-error'] && !job.uses, `${filename}/${id}: required jobs must have verifiable local steps and must not allow failure.`);
      if (checked.has(id)) return;
      checked.add(id);
      const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
      for (const dependency of needs) requiredJob(dependency, workflow.jobs[dependency], false);
      if (!testsRequired) return;
      const steps = job.steps || [];
      const installed = steps.findIndex(step => directCommand(step, installCommand) && unconditional(step.if) && !step['continue-on-error']);
      const tested = steps.findIndex(step => directCommand(step, testCommand) && unconditional(step.if) && !step['continue-on-error']);
      requireThat(installed >= 0 && tested > installed, `${filename}/${id}: run unconditional npm ci before npm test, npm run test:<name>, or npm pack --dry-run (without continue-on-error).`);
    }
    for (const name of required) {
      const matching = Object.entries(workflow.jobs).filter(([id, job]) => (job.name || id) === name);
      requireThat(matching.length === 1 && !name.includes('${{'), `${filename}: required job ${name} must have a unique static name.`);
      // Validate the test steps even if this job was visited as a dependency.
      checked.clear();
      requiredJob(...matching[0], true);
    }
  });

  if (published) check('publication', () => {
    requireThat(config.git.releaseRequiredChecks?.length, 'Configure git.releaseRequiredChecks for a published package.');
    requireThat(!config.git.releaseTestWorkflow || config.git.releaseTestWorkflow === filename,
      'projectChecks.testWorkflow must match git.releaseTestWorkflow.');
    requireThat(semver.valid(manifest.version) === manifest.version && !semver.prerelease(manifest.version), 'package.json: published packages need an exact stable version.');
    requireThat(['package-lock.json', 'npm-shrinkwrap.json'].some(file => fs.existsSync(path.join(root, file))), 'Commit a package lockfile before publishing.');
    ensureLockfilesMatch(root, manifest.version);
    const publishing = inspectWorkflow(root, `v${manifest.version}`);
    const workflow = workflows.get(path.basename(publishing.path));
    const job = workflow.jobs.publish;
    const steps = job.steps;
    requireThat(!job['continue-on-error'], `${publishing.path}: publication must not allow failure.`);
    const installed = steps.findIndex(step => directCommand(step, installCommand) && unconditional(step.if) && !step['continue-on-error']);
    const verify = steps.findIndex(step => directCommand(step, verifyCommand));
    const publish = steps.findIndex(step => step.run === 'npm publish');
    requireThat(installed >= 0 && verify > installed && verify < publish && unconditional(steps[verify].if) && !steps[verify]['continue-on-error'],
      `${publishing.path}: run verify-release unconditionally before npm publish.`);
    const environment = { ...workflow.env, ...job.env, ...steps[verify].env };
    requireThat(environment.RELEASE_TAG === '${{ github.ref_name }}' && environment.GH_TOKEN,
      `${publishing.path}: verify-release needs RELEASE_TAG from github.ref_name and GH_TOKEN.`);
    const permissions = job.permissions || workflow.permissions;
    requireThat(permissions && permissions['id-token'] === 'write' && ['read', 'write'].includes(permissions.contents),
      `${publishing.path}: declare contents: read and id-token: write for publishing.`);
    const selected = config.git.releaseTestWorkflow || path.basename(publishing.path);
    requireThat(selected === filename, 'Configure git.releaseTestWorkflow to select the checked PR workflow.');
  });
  return { errors, published };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: worktree-keeper check-project');
    return;
  }
  if (args.length) throw new Error('Usage: worktree-keeper check-project');
  const { errors, published } = checkProject();
  if (errors.length) {
    for (const error of errors) console.error(`FAIL ${error}`);
    process.exitCode = 1;
  } else console.log(`Project checks passed: tools, hooks, CI${published ? ', publication' : ' (private package; publication skipped)'}.`);
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
}
module.exports = { checkProject };

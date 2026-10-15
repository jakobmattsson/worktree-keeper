'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const requiredCondition = "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const pollIntervalMs = 5_000;
const workflowTimeoutMs = 20 * 60_000;
const registryTimeoutMs = 10 * 60_000;
class ReleaseError extends Error {
}
function execute(spawnSync, environment, command, args, options) {
    const actualCommand = command === 'npm' && environment.npm_execpath ? process.execPath : command;
    const actualArgs = command === 'npm' && environment.npm_execpath
        ? [environment.npm_execpath, ...args]
        : args;
    const result = spawnSync(actualCommand, actualArgs, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        ...options,
    });
    if (result.error)
        throw new ReleaseError(`${command} could not start: ${result.error.message}`);
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function checkedOutput(exec, command, args, cwd) {
    const result = exec(command, args, { cwd });
    if (result.status !== 0) {
        throw new ReleaseError(`${command} ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
    }
    return result.stdout;
}
function checked(exec, command, args, cwd) {
    return checkedOutput(exec, command, args, cwd).trim();
}
function readPackage(cwd) {
    const manifestPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(manifestPath))
        throw new ReleaseError('No package.json exists at the repository root.');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
    catch (error) {
        throw new ReleaseError(`Cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof manifest.version !== 'string' || !stableVersion.test(manifest.version)) {
        throw new ReleaseError('package.json needs a stable MAJOR.MINOR.PATCH version.');
    }
    if (typeof manifest.name !== 'string' || !manifest.name) {
        throw new ReleaseError('package.json needs a package name for npm verification.');
    }
    if (manifest.workspaces)
        throw new ReleaseError('Workspace releases are not supported.');
    return { name: manifest.name, version: manifest.version };
}
function ensureLockfilesMatch(cwd, version) {
    for (const filename of ['package-lock.json', 'npm-shrinkwrap.json']) {
        const lockPath = path.join(cwd, filename);
        if (!fs.existsSync(lockPath))
            continue;
        let lock;
        try {
            lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        }
        catch (error) {
            throw new ReleaseError(`Cannot read ${filename}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (lock.version !== version || (lock.packages && lock.packages['']?.version !== version)) {
            throw new ReleaseError(`${filename} does not match package.json version ${version}.`);
        }
    }
}
function nextVersion(version, bump) {
    const match = stableVersion.exec(version);
    if (!match)
        throw new ReleaseError(`Unsupported version: ${version}`);
    const [major, minor, patch] = match.slice(1).map(BigInt);
    if (bump === 'major')
        return `${major + 1n}.0.0`;
    if (bump === 'minor')
        return `${major}.${minor + 1n}.0`;
    if (bump === 'patch')
        return `${major}.${minor}.${patch + 1n}`;
    throw new ReleaseError(`Choose one release type: major, minor, or patch (got ${bump || 'none'}).`);
}
function matchesTag(patterns, tag) {
    let accepted = false;
    for (const pattern of patterns) {
        if (typeof pattern !== 'string')
            return false;
        const negative = pattern.startsWith('!');
        const glob = negative ? pattern.slice(1) : pattern;
        const expression = new RegExp(`^${glob.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')).join('.*')}$`, 'u');
        if (expression.test(tag))
            accepted = !negative;
    }
    return accepted;
}
function acceptsTag(on, tag) {
    if (on === 'push')
        return true;
    if (Array.isArray(on))
        return on.includes('push');
    if (!on || typeof on !== 'object' || !Object.hasOwn(on, 'push'))
        return false;
    const push = on.push;
    if (push === null || push === undefined)
        return true;
    if (typeof push !== 'object' || Array.isArray(push))
        return false;
    const filters = push;
    if ((filters.branches || filters['branches-ignore']) && !filters.tags && !filters['tags-ignore'])
        return false;
    if (filters.tags)
        return Array.isArray(filters.tags) && matchesTag(filters.tags, tag);
    if (filters['tags-ignore'])
        return Array.isArray(filters['tags-ignore']) && !matchesTag(filters['tags-ignore'], tag);
    return true;
}
function inspectWorkflow(cwd, tag) {
    const directory = path.join(cwd, '.github', 'workflows');
    const files = fs.existsSync(directory)
        ? fs.readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name)).sort()
        : [];
    const matches = [];
    for (const file of files) {
        const relativePath = `.github/workflows/${file}`;
        let document;
        try {
            document = yaml.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
        }
        catch (error) {
            throw new ReleaseError(`Cannot parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!document?.jobs || !Object.hasOwn(document.jobs, 'publish'))
            continue;
        const job = document.jobs.publish;
        if (!job || job.if !== requiredCondition) {
            throw new ReleaseError(`${relativePath}: publish job needs the exact required if condition.`);
        }
        if (!Array.isArray(job.steps) || !job.steps.some((step) => step?.run === 'npm publish')) {
            throw new ReleaseError(`${relativePath}: publish job needs a step whose run is exactly npm publish.`);
        }
        const name = job.name || 'publish';
        if (typeof name !== 'string' || name.includes('${{')) {
            throw new ReleaseError(`${relativePath}: publish job needs a static display name.`);
        }
        matches.push({ path: relativePath, name, on: document.on });
    }
    if (matches.length !== 1) {
        throw new ReleaseError(`Expected exactly one publish job; found ${matches.length}.`);
    }
    if (!acceptsTag(matches[0].on, tag)) {
        throw new ReleaseError(`${matches[0].path} does not trigger on push of ${tag}.`);
    }
    return matches[0];
}
function originRepository(remote) {
    const scp = /^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote);
    let host;
    let slug;
    if (scp) {
        [, host, slug] = scp;
    }
    else {
        let url;
        try {
            url = new URL(remote);
        }
        catch {
            throw new ReleaseError('origin must be a GitHub HTTPS or SSH remote.');
        }
        if (!['https:', 'ssh:'].includes(url.protocol)) {
            throw new ReleaseError('origin must be a GitHub HTTPS or SSH remote.');
        }
        host = url.hostname;
        slug = url.pathname.replace(/^\//u, '').replace(/\.git$/u, '');
    }
    if (!/^[\w.-]+\/[\w.-]+$/u.test(slug)) {
        throw new ReleaseError(`Cannot identify a GitHub owner/repository from origin: ${remote}`);
    }
    return { host, slug };
}
function github(exec, cwd, host, endpoint, parameters) {
    const args = ['api', '--hostname', host, '--method', 'GET', endpoint];
    for (const [key, value] of Object.entries(parameters))
        args.push('-f', `${key}=${value}`);
    let response;
    try {
        response = JSON.parse(checked(exec, 'gh', args, cwd));
    }
    catch (error) {
        if (error instanceof ReleaseError)
            throw error;
        throw new ReleaseError(`GitHub returned invalid JSON for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return response;
}
function ensureClean(exec, cwd) {
    if (checked(exec, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], cwd)) {
        throw new ReleaseError('Repository has uncommitted or untracked work.');
    }
}
function prepare(exec, cwd, bump, log) {
    const gitRoot = checked(exec, 'git', ['rev-parse', '--show-toplevel'], cwd);
    if (fs.realpathSync(gitRoot) !== fs.realpathSync(cwd)) {
        throw new ReleaseError(`Release must run from its repository root (${gitRoot}).`);
    }
    ensureClean(exec, cwd);
    const initialPackage = readPackage(cwd);
    ensureLockfilesMatch(cwd, initialPackage.version);
    inspectWorkflow(cwd, `v${nextVersion(initialPackage.version, bump)}`);
    const remote = checked(exec, 'git', ['remote', 'get-url', 'origin'], cwd);
    const { host, slug } = originRepository(remote);
    const defaultBranch = github(exec, cwd, host, `repos/${slug}`, {}).default_branch;
    if (typeof defaultBranch !== 'string' || !defaultBranch) {
        throw new ReleaseError('GitHub did not provide the default branch.');
    }
    checked(exec, 'git', ['fetch', 'origin', defaultBranch], cwd);
    const currentBranch = checked(exec, 'git', ['branch', '--show-current'], cwd);
    if (currentBranch !== defaultBranch) {
        log(`Switching to default branch ${defaultBranch}.`);
        const existing = exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${defaultBranch}`], { cwd });
        if (existing.status === 0)
            checked(exec, 'git', ['switch', defaultBranch], cwd);
        else if (existing.status === 1) {
            checked(exec, 'git', ['switch', '--track', '-c', defaultBranch, `origin/${defaultBranch}`], cwd);
        }
        else {
            throw new ReleaseError(`Could not check local branch ${defaultBranch}: ${existing.stderr.trim()}`);
        }
    }
    const local = checked(exec, 'git', ['rev-parse', 'HEAD'], cwd);
    const origin = checked(exec, 'git', ['rev-parse', `refs/remotes/origin/${defaultBranch}`], cwd);
    if (local !== origin) {
        throw new ReleaseError(`Local ${defaultBranch} (${local}) differs from origin/${defaultBranch} (${origin}).`);
    }
    ensureClean(exec, cwd);
    const packageInfo = readPackage(cwd);
    ensureLockfilesMatch(cwd, packageInfo.version);
    const version = nextVersion(packageInfo.version, bump);
    const tag = `v${version}`;
    const workflow = inspectWorkflow(cwd, tag);
    const localTag = exec('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd });
    if (localTag.status === 0)
        throw new ReleaseError(`Local tag ${tag} already exists.`);
    if (localTag.status !== 1)
        throw new ReleaseError(`Could not check local tag ${tag}: ${localTag.stderr.trim()}`);
    const remoteTag = exec('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { cwd });
    if (remoteTag.status === 0)
        throw new ReleaseError(`Origin tag ${tag} already exists.`);
    if (remoteTag.status !== 2)
        throw new ReleaseError(`Could not check origin tag ${tag}: ${remoteTag.stderr.trim()}`);
    log(`Validated ${packageInfo.name}: ${packageInfo.version} -> ${version} on ${defaultBranch}.`);
    return { host, slug, defaultBranch, name: packageInfo.name, version, tag, workflow };
}
function makeVersionCommit(exec, cwd, bump, version) {
    checked(exec, 'npm', ['version', bump, '--no-git-tag-version', '--ignore-scripts'], cwd);
    if (readPackage(cwd).version !== version) {
        throw new ReleaseError(`npm did not produce the expected version ${version}; inspect the working tree.`);
    }
    ensureLockfilesMatch(cwd, version);
    const changed = checkedOutput(exec, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], cwd)
        .split('\n').filter(Boolean).map((line) => line.slice(3));
    const allowed = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
    if (!changed.length || changed.some((file) => !allowed.has(file))) {
        throw new ReleaseError(`npm version changed unexpected files: ${changed.join(', ')}.`);
    }
    checked(exec, 'git', ['add', '--', ...changed], cwd);
    checked(exec, 'git', ['commit', '-m', version], cwd);
    if (checked(exec, 'git', ['log', '-1', '--format=%B'], cwd) !== version) {
        throw new ReleaseError(`Version commit message is not exactly ${version}; inspect the local commit.`);
    }
    const committed = checked(exec, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], cwd)
        .split('\n').filter(Boolean);
    if (!committed.length || committed.some((file) => !allowed.has(file))) {
        throw new ReleaseError(`Version commit includes unexpected files: ${committed.join(', ')}.`);
    }
    ensureClean(exec, cwd);
    return checked(exec, 'git', ['rev-parse', 'HEAD'], cwd);
}
async function waitForWorkflow(exec, cwd, details, sha, now, sleep, log) {
    const deadline = now() + workflowTimeoutMs;
    let runId;
    log(`Waiting for GitHub to start the workflow run for ${details.tag}.`);
    while (now() < deadline) {
        if (!runId) {
            const filename = encodeURIComponent(path.basename(details.workflow.path));
            const listing = github(exec, cwd, details.host, `repos/${details.slug}/actions/workflows/${filename}/runs`, {
                event: 'push', head_sha: sha, per_page: '100',
            });
            const matches = (listing.workflow_runs || []).filter((run) => run.head_sha === sha &&
                run.head_branch === details.tag && run.path?.split('@')[0] === details.workflow.path);
            if (matches.length) {
                const run = matches.reduce((latest, candidate) => candidate.id > latest.id ? candidate : latest);
                runId = run.id;
                log(`Tag workflow run found: ${run.html_url || `https://${details.host}/${details.slug}/actions/runs/${runId}`}`);
            }
        }
        if (runId) {
            const jobs = github(exec, cwd, details.host, `repos/${details.slug}/actions/runs/${runId}/jobs`, {
                per_page: '100',
            }).jobs || [];
            const matching = jobs.filter((job) => job.name === details.workflow.name);
            if (matching.length > 1)
                throw new ReleaseError(`Multiple publish jobs found in GitHub run ${runId}.`);
            if (matching.length === 1 && matching[0].status === 'completed' && matching[0].conclusion !== 'success') {
                throw new ReleaseError(`Publish job in GitHub run ${runId} ended as ${matching[0].conclusion}.`);
            }
            const runStatus = github(exec, cwd, details.host, `repos/${details.slug}/actions/runs/${runId}`, {});
            if (runStatus.status === 'completed') {
                if (matching.length !== 1 || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') {
                    throw new ReleaseError(`Workflow run ${runId} completed without a successful publish job.`);
                }
                const startedAt = Date.parse(runStatus.run_started_at);
                const completedAt = Date.parse(runStatus.updated_at);
                if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt) {
                    throw new ReleaseError(`Workflow run ${runId} has invalid start or completion time.`);
                }
                return { completedAt, durationMs: completedAt - startedAt };
            }
        }
        await sleep(pollIntervalMs);
    }
    throw new ReleaseError(`Timed out waiting for the workflow run for ${details.tag}.`);
}
async function waitForRegistry(exec, cwd, details, workflow, now, sleep, log) {
    const deadline = now() + registryTimeoutMs;
    log(`Workflow run for ${details.tag} completed in ${(workflow.durationMs / 1000).toFixed(1)} seconds; waiting for ${details.name}@${details.version} on npm.`);
    while (now() < deadline) {
        const result = exec('npm', [
            'view', `${details.name}@${details.version}`, 'version', '--json',
            '--registry', 'https://registry.npmjs.org/',
        ], { cwd });
        if (result.status === 0) {
            let observed;
            try {
                observed = JSON.parse(result.stdout);
            }
            catch {
                observed = null;
            }
            if (observed === details.version)
                return Math.max(0, now() - workflow.completedAt);
        }
        await sleep(pollIntervalMs);
    }
    throw new ReleaseError(`Timed out waiting for ${details.name}@${details.version} on npm.`);
}
async function release(bump, dependencies) {
    const { cwd, spawnSync, environment, now, sleep, log } = dependencies;
    const exec = (command, args, options) => execute(spawnSync, environment, command, args, options);
    const details = prepare(exec, cwd, bump, log);
    const sha = makeVersionCommit(exec, cwd, bump, details.version);
    log(`Created version commit ${sha} (${details.version}).`);
    checked(exec, 'git', ['push', 'origin', `HEAD:refs/heads/${details.defaultBranch}`], cwd);
    log(`Pushed ${sha} to origin/${details.defaultBranch}.`);
    checked(exec, 'git', ['tag', details.tag, sha], cwd);
    log(`Created local tag ${details.tag}.`);
    checked(exec, 'git', ['push', 'origin', `refs/tags/${details.tag}`], cwd);
    log(`Pushed tag ${details.tag}.`);
    const workflow = await waitForWorkflow(exec, cwd, details, sha, now, sleep, log);
    const elapsedMs = await waitForRegistry(exec, cwd, details, workflow, now, sleep, log);
    log(`Published ${details.name}@${details.version}; visible on npm ${(elapsedMs / 1000).toFixed(1)} seconds after the workflow run completed.`);
}
function usageCommand() {
    return 'worktree-keeper release';
}
async function runCli(options) {
    const { argv, environment, repositoryDirectory, spawnSync, now, sleep, log } = options;
    const bump = argv[2];
    if (!['major', 'minor', 'patch'].includes(bump) || argv.length !== 3) {
        throw new ReleaseError(`Usage: ${usageCommand(options)} <major|minor|patch>`);
    }
    await release(bump, { cwd: repositoryDirectory, spawnSync, environment, now, sleep, log });
}
module.exports = {
    ReleaseError, acceptsTag, ensureLockfilesMatch, inspectWorkflow, makeVersionCommit, nextVersion,
    originRepository, prepare, readPackage, release, runCli, waitForWorkflow, waitForRegistry,
};

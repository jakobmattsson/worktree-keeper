'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');
const { githubApi, requiredChecks, verifyProtection } = require('./release-protection');
const { CONFIG_FILE, projectConfig } = require('./project-config');
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
function onlyReleaseTagPushes(on) {
    if (!on || typeof on !== 'object' || Array.isArray(on)
        || Object.keys(on).length !== 1 || !Object.hasOwn(on, 'push')) return false;
    const push = on.push;
    if (!push || typeof push !== 'object' || Array.isArray(push)
        || ['branches', 'branches-ignore', 'tags-ignore'].some(key => Object.hasOwn(push, key))) return false;
    return Array.isArray(push.tags) && push.tags.some(pattern => typeof pattern === 'string' && pattern.startsWith('v'))
        && push.tags.every(pattern => typeof pattern === 'string' && (pattern.startsWith('!') || pattern.startsWith('v')));
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
        if (!job || (job.if !== requiredCondition && (Object.hasOwn(job, 'if') || !onlyReleaseTagPushes(document.on)))) {
            throw new ReleaseError(`${relativePath}: publish job needs the exact required if condition unless the workflow only triggers on v-prefixed tag pushes.`);
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
    const remote = checked(exec, 'git', ['remote', 'get-url', 'origin'], cwd);
    const { host, slug } = originRepository(remote);
    const repository = github(exec, cwd, host, `repos/${slug}`, {});
    const configured = fs.existsSync(path.join(cwd, CONFIG_FILE))
        ? projectConfig(cwd).git.releaseMergeMethod : undefined;
    const allowed = ['merge', 'rebase', 'squash'].filter((method) =>
        repository[{ merge: 'allow_merge_commit', rebase: 'allow_rebase_merge', squash: 'allow_squash_merge' }[method]] === true);
    if (!allowed.length)
        throw new ReleaseError('No supported PR merge method is enabled.');
    const mergeMethod = allowed.length === 1 ? allowed[0] : configured || allowed[0];
    if (!allowed.includes(mergeMethod))
        throw new ReleaseError(`Configured release merge method ${mergeMethod} is not enabled on GitHub.`);
    const defaultBranch = repository.default_branch;
    if (typeof defaultBranch !== 'string' || !defaultBranch) {
        throw new ReleaseError('GitHub did not provide the default branch.');
    }
    verifyProtection({ api: githubApi(exec, cwd, host), slug, branch: defaultBranch, checks: requiredChecks(cwd) });
    checked(exec, 'git', ['fetch', 'origin', defaultBranch], cwd);
    const manifest = JSON.parse(checkedOutput(exec, 'git', ['show', `origin/${defaultBranch}:package.json`], cwd));
    const packageInfo = { name: manifest.name, version: manifest.version };
    const version = nextVersion(packageInfo.version, bump);
    const tag = `v${version}`;
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
    return { host, slug, defaultBranch, name: packageInfo.name, version, tag, mergeMethod };
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
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-keeper-registry-'));
    try {
        while (now() < deadline) {
            const result = exec('npm', [
                'view', `${details.name}@${details.version}`, 'version', '--json',
                '--registry', 'https://registry.npmjs.org/', '--prefer-online', '--cache', cache,
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
    finally {
        fs.rmSync(cache, { recursive: true, force: true });
    }
}
function saveState(filename, state) {
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(state));
    fs.renameSync(`${filename}.tmp`, filename);
}
function pullRequest(exec, cwd, details) {
    return github(exec, cwd, details.host, `repos/${details.slug}/pulls/${details.pr}`, {});
}
async function mergeRelease(exec, cwd, details, now, sleep, log) {
    const deadline = now() + workflowTimeoutMs;
    while (now() < deadline) {
        const pr = pullRequest(exec, cwd, details);
        if (pr.head.sha !== details.sha || pr.base.ref !== details.defaultBranch)
            throw new ReleaseError('Release PR changed unexpectedly; inspect it before continuing.');
        if (pr.merged)
            return pr.merge_commit_sha;
        if (pr.state !== 'open')
            throw new ReleaseError(`Release PR #${details.pr} was closed without merging.`);
        if (pr.mergeable_state === 'dirty')
            throw new ReleaseError(`Release PR #${details.pr} has conflicts; inspect it before continuing.`);
        verifyProtection({ api: githubApi(exec, cwd, details.host), slug: details.slug,
            branch: details.defaultBranch, checks: requiredChecks(cwd) });
        // GitHub enforces required checks, reviews, and branch freshness on this request.
        const result = exec('gh', ['api', '--hostname', details.host, '--method', 'PUT',
            `repos/${details.slug}/pulls/${details.pr}/merge`,
            '-f', `merge_method=${details.mergeMethod || 'squash'}`, '-f', `sha=${details.sha}`], { cwd });
        if (result.status === 0) {
            const merged = JSON.parse(result.stdout);
            if (merged.merged)
                return merged.sha;
        }
        else if (!/HTTP (405|409)/u.test(result.stderr)) {
            throw new ReleaseError(`Cannot merge release PR: ${result.stderr.trim()}`);
        }
        log(`Waiting for release PR #${details.pr} to satisfy merge requirements.`);
        await sleep(pollIntervalMs);
    }
    throw new ReleaseError(`Timed out waiting for release PR #${details.pr}; retry the same release command to continue.`);
}
async function release(bump, dependencies) {
    const { cwd, spawnSync, environment, now, sleep, log } = dependencies;
    const exec = (command, args, options) => execute(spawnSync, environment, command, args, options);
    const common = path.resolve(cwd, checked(exec, 'git', ['rev-parse', '--git-common-dir'], cwd));
    const statePath = path.join(common, 'worktree-keeper-release.json');
    const lockPath = `${statePath}.lock`;
    if (fs.existsSync(lockPath)) {
        const pid = Number(fs.readFileSync(lockPath, 'utf8'));
        try {
            process.kill(pid, 0);
            throw new ReleaseError('Another release command is running.');
        }
        catch (error) {
            if (error.code !== 'ESRCH') throw error;
            fs.unlinkSync(lockPath);
        }
    }
    const lock = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lock, String(process.pid));
    fs.closeSync(lock);
    let temporary;
    let worktree;
    try {
        let details;
        if (fs.existsSync(statePath)) {
            details = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (details.bump !== bump)
                throw new ReleaseError(`An unfinished ${details.bump} release exists; retry that release type.`);
            const origin = originRepository(checked(exec, 'git', ['remote', 'get-url', 'origin'], cwd));
            if (origin.host !== details.host || origin.slug !== details.slug)
                throw new ReleaseError('Origin differs from the unfinished release repository.');
            log(`Resuming release ${details.tag}.`);
        }
        else {
            details = prepare(exec, cwd, bump, log);
            for (let page = 1; ; page += 1) {
                const open = github(exec, cwd, details.host, `repos/${details.slug}/pulls`, {
                    state: 'open', base: details.defaultBranch, per_page: '100', page: String(page),
                });
                if (open.some((pr) => pr.head.ref.startsWith('release/v')))
                    throw new ReleaseError('An open release PR already exists; finish it from its original checkout.');
                if (open.length < 100) break;
            }
            details.bump = bump;
            details.branch = `release/${details.tag}`;
            saveState(statePath, details);
        }
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-keeper-release-worktree-'));
        worktree = path.join(temporary, 'repo');
        if (!details.sha) {
            checked(exec, 'git', ['worktree', 'add', '--detach', worktree, `origin/${details.defaultBranch}`], cwd);
            const baseline = readPackage(worktree);
            if (baseline.name !== details.name || nextVersion(baseline.version, bump) !== details.version)
                throw new ReleaseError('Default branch version changed before release preparation completed; inspect release state.');
            ensureLockfilesMatch(worktree, baseline.version);
            inspectWorkflow(worktree, details.tag);
            details.sha = makeVersionCommit(exec, worktree, bump, details.version);
            // Keep the commit reachable if interrupted before the remote push.
            checked(exec, 'git', ['update-ref', `refs/worktree-keeper/releases/${details.tag}`, details.sha], cwd);
            saveState(statePath, details);
        }
        else {
            checked(exec, 'git', ['worktree', 'add', '--detach', worktree, details.sha], cwd);
        }
        if (!details.pr) {
            checked(exec, 'git', ['push', 'origin', `${details.sha}:refs/heads/${details.branch}`], cwd);
            const existing = github(exec, cwd, details.host, `repos/${details.slug}/pulls`, {
                state: 'all', head: `${details.slug.split('/')[0]}:${details.branch}`, base: details.defaultBranch,
            });
            if (existing.length > 1)
                throw new ReleaseError('Multiple release PRs found; inspect before continuing.');
            if (existing.length) details.pr = existing[0].number;
            else {
                const body = path.join(temporary, 'pr-body.md');
                fs.writeFileSync(body, `Bump ${details.name} to ${details.version}. After merge, the release command tags the merge commit and waits for npm publication.\n`);
                checked(exec, 'gh', ['pr', 'create', '--repo', `${details.host}/${details.slug}`,
                    '--base', details.defaultBranch, '--head', details.branch,
                    '--title', `Release ${details.tag}`, '--body-file', body], cwd);
                const created = github(exec, cwd, details.host, `repos/${details.slug}/pulls`, {
                    state: 'all', head: `${details.slug.split('/')[0]}:${details.branch}`, base: details.defaultBranch,
                });
                if (created.length !== 1) throw new ReleaseError('Cannot identify created release PR.');
                details.pr = created[0].number;
            }
            saveState(statePath, details);
        }
        log(`Release PR: https://${details.host}/${details.slug}/pull/${details.pr}`);
        const sha = await mergeRelease(exec, cwd, details, now, sleep, log);
        checked(exec, 'git', ['fetch', 'origin', details.defaultBranch], cwd);
        checked(exec, 'git', ['merge-base', '--is-ancestor', sha, `origin/${details.defaultBranch}`], cwd);
        checked(exec, 'git', ['checkout', '--detach', sha], worktree);
        const manifest = readPackage(worktree);
        if (manifest.version !== details.version || manifest.name !== details.name)
            throw new ReleaseError('Merged package does not match the intended release.');
        ensureLockfilesMatch(worktree, details.version);
        details.workflow = inspectWorkflow(worktree, details.tag);
        const remote = checked(exec, 'git', ['ls-remote', '--tags', 'origin', `refs/tags/${details.tag}`, `refs/tags/${details.tag}^{}`], cwd);
        if (remote && !remote.split('\n').some((line) => line.startsWith(`${sha}\t`)))
            throw new ReleaseError(`Origin tag ${details.tag} points to another commit.`);
        if (!remote) {
            const local = exec('git', ['rev-parse', '--verify', `refs/tags/${details.tag}^{commit}`], { cwd });
            if (local.status === 0 && local.stdout.trim() !== sha)
                throw new ReleaseError(`Local tag ${details.tag} points to another commit.`);
            if (local.status !== 0) checked(exec, 'git', ['tag', details.tag, sha], cwd);
            checked(exec, 'git', ['push', 'origin', `refs/tags/${details.tag}`], cwd);
        }
        const workflow = await waitForWorkflow(exec, cwd, details, sha, now, sleep, log);
        const elapsedMs = await waitForRegistry(exec, cwd, details, workflow, now, sleep, log);
        log(`Published ${details.name}@${details.version}; visible on npm ${(elapsedMs / 1000).toFixed(1)} seconds after the workflow run completed.`);
        fs.unlinkSync(statePath);
        checked(exec, 'git', ['update-ref', '-d', `refs/worktree-keeper/releases/${details.tag}`], cwd);
    }
    finally {
        if (worktree) exec('git', ['worktree', 'remove', '--force', worktree], { cwd });
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
        fs.unlinkSync(lockPath);
    }
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

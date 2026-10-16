'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const release = require('../../scripts/release-core.js');
function withTemporaryRepository(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-keeper-release-'));
    try {
        callback(directory);
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
async function withTemporaryRepositoryAsync(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-keeper-release-'));
    try {
        await callback(directory);
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
function fixture(directory) {
    const repo = path.join(directory, 'repo');
    const origin = path.join(directory, 'origin.git');
    fs.mkdirSync(repo);
    function command(cwd, executable, args) {
        const actualCommand = executable === 'npm' && process.env.npm_execpath ? process.execPath : executable;
        const actualArgs = executable === 'npm' && process.env.npm_execpath
            ? [process.env.npm_execpath, ...args]
            : args;
        const result = spawnSync(actualCommand, actualArgs, { cwd, encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    }
    function git(...args) {
        const result = command(repo, 'git', args);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    }
    assert.equal(command(directory, 'git', ['init', '--bare', origin]).status, 0);
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'example', version: '1.3.5' }));
    fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
        name: 'example', version: '1.3.5', lockfileVersion: 3,
        packages: { '': { name: 'example', version: '1.3.5' } },
    }));
    const condition = "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}";
    writeWorkflow(repo, condition, 'npm publish', 'v*');
    require('./project-config-fixture').writeProjectConfig(repo, { git: { releaseRequiredChecks: ['test'] } });
    git('add', '.');
    git('commit', '-m', 'initial');
    git('push', '-u', 'origin', 'main');
    return { repo, origin, command, git };
}
function fakeServices(testFixture, settings) {
    const calls = [];
    let registryChecks = 0;
    let pr;
    let mergedSha;
    const completed = Date.parse('2026-10-11T12:00:00Z');
    let now = completed + 3_000;
    const spawnSync = (command, args, options) => {
        calls.push([command, ...args]);
        if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
            return { status: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
        }
        if (command === 'git' && args[0] === 'push' && args[2]?.endsWith(':refs/heads/release/v1.3.6') && settings.failBranchPush) {
            return { status: 1, stdout: '', stderr: 'non-fast-forward' };
        }
        if (command === 'git' && args[0] === 'push' && args[2] === 'refs/tags/v1.3.6' && settings.failTagPush) {
            return { status: 1, stdout: '', stderr: 'tag rejected' };
        }
        if (command === 'gh') {
            if (args[0] === 'pr' && args[1] === 'create') {
                pr = { number: 7, state: 'open', merged: false,
                    head: { ref: 'release/v1.3.6', sha: testFixture.git('rev-parse', 'refs/worktree-keeper/releases/v1.3.6') },
                    base: { ref: 'main' } };
                return { status: 0, stdout: 'https://github.com/owner/repo/pull/7', stderr: '' };
            }
            const endpoint = args[5];
            let response;
            if (endpoint === 'repos/owner/repo') {
                response = { default_branch: 'main', allow_merge_commit: true, allow_rebase_merge: true,
                    allow_squash_merge: true, ...settings.repository };
            }
            else if (endpoint.endsWith('/branches/main/protection')) {
                if (settings.policyError) return { status: 1, stderr: settings.policyError };
                response = { enforce_admins: { enabled: true }, required_status_checks: { strict: !settings.loosePolicy, contexts: ['test'] } };
            }
            else if (endpoint.includes('/rules/branches/main?')) response = [];
            else if (endpoint === 'repos/owner/repo/pulls') response = pr ? [pr] : [];
            else if (endpoint.endsWith('/pulls/7/merge')) {
                if (settings.blockMerge) return { status: 1, stderr: 'HTTP 405: required checks pending' };
                if (!pr.merged) {
                    const dir = options.cwd;
                    const tree = testFixture.command(dir, 'git', ['rev-parse', `${pr.head.sha}^{tree}`]).stdout.trim();
                    mergedSha = testFixture.command(dir, 'git', ['commit-tree', tree, '-p', testFixture.git('rev-parse', 'origin/main'), '-m', 'Squashed release']).stdout.trim();
                    assert.equal(testFixture.command(dir, 'git', ['push', 'origin', `${mergedSha}:refs/heads/main`]).status, 0);
                    pr.merged = true;
                    pr.merge_commit_sha = mergedSha;
                    if (settings.advanceMain) {
                        const later = testFixture.command(dir, 'git', ['commit-tree', tree, '-p', mergedSha, '-m', 'Later change']).stdout.trim();
                        assert.equal(testFixture.command(dir, 'git', ['push', 'origin', `${later}:refs/heads/main`]).status, 0);
                    }
                }
                response = { merged: true, sha: mergedSha };
            }
            else if (endpoint.endsWith('/pulls/7')) response = pr;
            else if (endpoint.endsWith('/workflows/package.yml/runs')) {
                response = { workflow_runs: [
                        { id: 42, head_sha: mergedSha, head_branch: 'v1.3.6',
                            path: '.github/workflows/package.yml' },
                    ] };
            }
            else if (endpoint.endsWith('/runs/42/jobs')) {
                response = { jobs: [
                        { name: 'Publish to npm', status: 'completed',
                            conclusion: settings.failJob ? 'failure' : 'success',
                            started_at: new Date(completed - 23_000).toISOString(), completed_at: new Date(completed).toISOString() },
                    ] };
            }
            else if (endpoint.endsWith('/runs/42')) {
                response = { status: 'completed', conclusion: 'success',
                    run_started_at: new Date(completed - 90_000).toISOString(), updated_at: new Date(completed).toISOString() };
            }
            else {
                throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
            }
            return { status: 0, stdout: JSON.stringify(response), stderr: '' };
        }
        if (command === 'npm' && args[0] === 'view') {
            registryChecks += 1;
            return registryChecks === 1
                ? { status: 1, stdout: '', stderr: 'not found' }
                : { status: 0, stdout: '"1.3.6"', stderr: '' };
        }
        return testFixture.command(options.cwd, command, args);
    };
    return {
        spawnSync, calls, now: () => now, sleep: async (ms) => { now += ms; },
        registryChecks: () => registryChecks,
    };
}
function writeWorkflow(directory, condition, command, trigger) {
    const workflows = path.join(directory, '.github', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'package.yml'), `on:\n  push:\n    tags: ['${trigger}']\njobs:\n  publish:\n    name: Publish to npm\n    if: ${condition}\n    steps:\n      - run: ${command}\n`);
}
test('release level increments exactly one stable version component', () => {
    assert.equal(release.nextVersion('1.3.5', 'major'), '2.0.0');
    assert.equal(release.nextVersion('1.3.5', 'minor'), '1.4.0');
    assert.equal(release.nextVersion('1.3.5', 'patch'), '1.3.6');
    assert.equal(release.nextVersion('9999999999999999.3.5', 'major'), '10000000000000000.0.0');
    assert.throws(() => release.nextVersion('1.3.5', undefined), /Choose one release type/u);
    assert.throws(() => release.nextVersion('1.3.5-beta.1', 'patch'), /Unsupported version/u);
});
test('release rejects a lockfile version that differs from the package version', () => {
    withTemporaryRepository((directory) => {
        fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
            version: '1.3.5', packages: { '': { version: '1.3.4' } },
        }));
        assert.throws(() => release.ensureLockfilesMatch(directory, '1.3.5'), /does not match/u);
        fs.rmSync(path.join(directory, 'package-lock.json'));
        assert.doesNotThrow(() => release.ensureLockfilesMatch(directory, '1.3.5'));
    });
});
test('package preflight requires a root package.json and a stable version', () => {
    withTemporaryRepository((directory) => {
        assert.throws(() => release.readPackage(directory), /No package.json/u);
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'example' }));
        assert.throws(() => release.readPackage(directory), /stable MAJOR.MINOR.PATCH/u);
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'example', version: '1.3.5' }));
        assert.deepEqual(release.readPackage(directory), { name: 'example', version: '1.3.5' });
    });
});
test('version commit updates package files and uses only the version as its message', () => {
    withTemporaryRepository((directory) => {
        function exec(command, args, options) {
            const actualCommand = command === 'npm' && process.env.npm_execpath ? process.execPath : command;
            const actualArgs = command === 'npm' && process.env.npm_execpath
                ? [process.env.npm_execpath, ...args]
                : args;
            const result = spawnSync(actualCommand, actualArgs, { cwd: options.cwd, encoding: 'utf8' });
            return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
        }
        function git(...args) {
            const result = exec('git', args, { cwd: directory });
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.trim();
        }
        git('init', '-b', 'main');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'example', version: '1.3.5' }));
        fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
            name: 'example', version: '1.3.5', lockfileVersion: 3,
            packages: { '': { name: 'example', version: '1.3.5' } },
        }));
        git('add', '.');
        git('commit', '-m', 'initial');
        const commit = release.makeVersionCommit(exec, directory, 'minor', '1.4.0');
        assert.equal(commit, git('rev-parse', 'HEAD'));
        assert.equal(git('log', '-1', '--format=%B'), '1.4.0');
        assert.equal(release.readPackage(directory).version, '1.4.0');
        assert.deepEqual(new Set(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n')), new Set(['package.json', 'package-lock.json']));
    });
});
test('version commit also works for a package without an npm lockfile', () => {
    withTemporaryRepository((directory) => {
        function exec(command, args, options) {
            const actualCommand = command === 'npm' && process.env.npm_execpath ? process.execPath : command;
            const actualArgs = command === 'npm' && process.env.npm_execpath
                ? [process.env.npm_execpath, ...args]
                : args;
            const result = spawnSync(actualCommand, actualArgs, { cwd: options.cwd, encoding: 'utf8' });
            return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
        }
        function git(...args) {
            const result = exec('git', args, { cwd: directory });
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.trim();
        }
        git('init', '-b', 'main');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'example', version: '1.3.5' }));
        git('add', '.');
        git('commit', '-m', 'initial');
        release.makeVersionCommit(exec, directory, 'patch', '1.3.6');
        assert.equal(git('log', '-1', '--format=%B'), '1.3.6');
        assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'package.json');
    });
});
test('publish workflow requires the exact job condition, command, and tag trigger', () => {
    withTemporaryRepository((directory) => {
        const condition = "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}";
        writeWorkflow(directory, condition, 'npm publish', 'v*');
        assert.equal(release.inspectWorkflow(directory, 'v1.3.6').name, 'Publish to npm');
        writeWorkflow(directory, "${{ github.event_name == 'push' }}", 'npm publish', 'v*');
        assert.throws(() => release.inspectWorkflow(directory, 'v1.3.6'), /exact required if condition/u);
        writeWorkflow(directory, condition, 'npm publish --access public', 'v*');
        assert.throws(() => release.inspectWorkflow(directory, 'v1.3.6'), /exactly npm publish/u);
        writeWorkflow(directory, condition, 'npm publish', 'release-*');
        assert.throws(() => release.inspectWorkflow(directory, 'v1.3.6'), /does not trigger/u);
        writeWorkflow(directory, condition, 'npm publish', 'v*');
        const workflowPath = path.join(directory, '.github', 'workflows', 'package.yml');
        fs.writeFileSync(workflowPath, fs.readFileSync(workflowPath, 'utf8').replace('  publish:', '  deploy:'));
        assert.throws(() => release.inspectWorkflow(directory, 'v1.3.6'), /found 0/u);
    });
});
test('this package has a supported publish workflow for its next tag', () => {
    const root = path.resolve(__dirname, '../..');
    const next = release.nextVersion(require('../../package.json').version, 'patch');
    const workflow = release.inspectWorkflow(root, `v${next}`);
    assert.equal(workflow.path, '.github/workflows/package.yml');
    assert.equal(workflow.name, 'Publish to npm');
});

test('direct CLI usage shows the shared release command', () => {
    const script = path.resolve(__dirname, '../../scripts/release.js');
    const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, npm_lifecycle_event: 'test', npm_lifecycle_script: 'worktree-keeper run-tests' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: worktree-keeper release <major\|minor\|patch>/u);
});
test('npm script without a bump shows the shared release command', () => {
    const npmArgs = process.env.npm_execpath
        ? [process.env.npm_execpath, 'run', 'release', '--']
        : ['run', 'release', '--'];
    const npmCommand = process.env.npm_execpath ? process.execPath : 'npm';
    const result = spawnSync(npmCommand, npmArgs, {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '../..'),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: worktree-keeper release <major\|minor\|patch>/u);
});
test('usage is independent of an inherited npm script name', () => {
    const script = path.resolve(__dirname, '../../scripts/release.js');
    const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '../..'),
        env: {
            ...process.env,
            npm_lifecycle_event: 'publish:version',
            npm_lifecycle_script: 'node scripts/release.js',
        },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: worktree-keeper release <major\|minor\|patch>/u);
});
test('publish workflow monitoring uses the pushed tag and commit, then measures the whole run', async () => {
    const workflow = { path: '.github/workflows/package.yml', name: 'Publish to npm' };
    const details = { host: 'github.com', slug: 'owner/repo', tag: 'v1.3.6', workflow };
    const endpoints = [];
    let jobChecks = 0;
    let runChecks = 0;
    let currentTime = Date.parse('2026-10-11T12:00:00Z');
    const exec = (_command, args) => {
        const endpoint = args[5];
        endpoints.push(endpoint);
        if (endpoint.endsWith('/runs')) {
            return { status: 0, stdout: JSON.stringify({ workflow_runs: [
                        { id: 11, head_sha: 'other', head_branch: 'v1.3.6', path: workflow.path },
                        { id: 12, head_sha: 'abc', head_branch: 'v1.3.6', path: `${workflow.path}@refs/tags/v1.3.6`,
                            html_url: 'https://github.com/owner/repo/actions/runs/12' },
                    ] }) };
        }
        if (endpoint.endsWith('/runs/12/jobs')) {
            jobChecks += 1;
            if (jobChecks === 1)
                return { status: 0, stdout: JSON.stringify({ jobs: [] }) };
            return { status: 0, stdout: JSON.stringify({ jobs: [
                        { name: 'Publish to npm', status: 'completed', conclusion: 'success',
                            started_at: '2026-10-11T11:59:37Z', completed_at: '2026-10-11T12:00:00Z' },
                    ] }) };
        }
        if (endpoint.endsWith('/runs/12')) {
            runChecks += 1;
            return { status: 0, stdout: JSON.stringify(runChecks < 3
                    ? { status: 'in_progress' }
                    : { status: 'completed', conclusion: 'success',
                        run_started_at: '2026-10-11T11:58:30Z', updated_at: '2026-10-11T12:00:00Z' }) };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    };
    const messages = [];
    const workflowRun = await release.waitForWorkflow(exec, '/tmp', details, 'abc', () => currentTime, async (ms) => {
        assert.deepEqual(messages, [
            'Waiting for GitHub to start the workflow run for v1.3.6.',
            'Tag workflow run found: https://github.com/owner/repo/actions/runs/12',
        ]);
        currentTime += ms;
    }, (message) => messages.push(message));
    assert.deepEqual(workflowRun, { completedAt: Date.parse('2026-10-11T12:00:00Z'), durationMs: 90_000 });
    assert.equal(jobChecks, 3);
    assert.equal(runChecks, 3);
    assert.ok(endpoints.some((endpoint) => endpoint.endsWith('/runs/12/jobs')));
    assert.deepEqual(messages, [
        'Waiting for GitHub to start the workflow run for v1.3.6.',
        'Tag workflow run found: https://github.com/owner/repo/actions/runs/12',
    ]);
});
test('registry wait measures from the workflow completion without real time delays', async () => {
    const completed = Date.parse('2026-10-11T12:00:00Z');
    let now = completed + 3_000;
    let checks = 0;
    let cache;
    const exec = (command, args) => {
        assert.equal(command, 'npm');
        assert.deepEqual(args.slice(0, 5), [
            'view', '@example/package@1.3.6', 'version', '--json',
            '--registry',
        ]);
        assert.equal(args[5], 'https://registry.npmjs.org/');
        assert.equal(args[6], '--prefer-online');
        assert.equal(args[7], '--cache');
        cache ??= args[8];
        assert.equal(args[8], cache);
        assert.equal(fs.existsSync(cache), true);
        checks += 1;
        return checks === 1 ? { status: 1, stdout: '', stderr: 'not found' }
            : { status: 0, stdout: '"1.3.6"', stderr: '' };
    };
    const messages = [];
    const elapsed = await release.waitForRegistry(exec, '/tmp', {
        name: '@example/package', version: '1.3.6', tag: 'v1.3.6',
    }, { completedAt: completed, durationMs: 90_000 }, () => now, async (ms) => { now += ms; }, (message) => messages.push(message));
    assert.equal(elapsed, 8_000);
    assert.equal(checks, 2);
    assert.equal(fs.existsSync(cache), false);
    assert.deepEqual(messages, [
        'Workflow run for v1.3.6 completed in 90.0 seconds; waiting for @example/package@1.3.6 on npm.',
    ]);
});
test('preflight rejects dirty work but leaves a divergent feature branch unchanged', () => {
    withTemporaryRepository((directory) => {
        const project = fixture(directory);
        const services = fakeServices(project, {});
        fs.writeFileSync(path.join(project.repo, 'untracked.txt'), 'local work');
        assert.throws(() => release.prepare(services.spawnSync, project.repo, 'patch', () => {}), /uncommitted or untracked/u);
        project.git('add', '.');
        project.git('commit', '-m', 'local');
        project.git('switch', '-c', 'feature');
        const sha = project.git('rev-parse', 'HEAD');
        assert.equal(release.prepare(services.spawnSync, project.repo, 'patch', () => {}).version, '1.3.6');
        assert.equal(project.git('branch', '--show-current'), 'feature');
        assert.equal(project.git('rev-parse', 'HEAD'), sha);
    });
});
test('preflight refuses to reuse an existing release tag', () => {
    withTemporaryRepository((directory) => {
        const project = fixture(directory);
        project.git('tag', 'v1.3.6');
        const services = fakeServices(project, { failBranchPush: false, failTagPush: false, failJob: false });
        assert.throws(() => release.prepare(services.spawnSync, project.repo, 'patch', () => { }), /Local tag v1.3.6 already exists/u);
    });
});
test('a failed branch push leaves no version tag', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const services = fakeServices(project, { failBranchPush: true, failJob: false });
        await assert.rejects(release.release('patch', {
            cwd: project.repo, spawnSync: services.spawnSync, environment: {},
            now: services.now, sleep: services.sleep, log: () => { },
        }), /non-fast-forward/u);
        assert.equal(project.git('log', '-1', '--format=%B'), 'initial');
        assert.equal(project.command(project.repo, 'git', ['show-ref', '--verify', '--quiet', 'refs/tags/v1.3.6']).status, 1);
        assert.equal(services.calls.some(([command, subcommand]) => command === 'git' && subcommand === 'tag'), false);
    });
});
test('a failed tag push stops before workflow polling', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const services = fakeServices(project, { failBranchPush: false, failTagPush: true, failJob: false });
        await assert.rejects(release.release('patch', {
            cwd: project.repo, spawnSync: services.spawnSync, environment: {},
            now: services.now, sleep: services.sleep, log: () => { },
        }), /tag rejected/u);
        assert.equal(project.git('rev-parse', 'refs/tags/v1.3.6'), project.git('rev-parse', 'origin/main'));
        assert.equal(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), '');
        assert.equal(services.calls.some((call) => call[0] === 'gh' && call[6]?.includes('/actions/')), false);
    });
});
test('CLI merges a release PR and tags the resulting commit before waiting for npm visibility', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const services = fakeServices(project, { failBranchPush: false, failJob: false });
        const messages = [];
        await release.runCli({
            argv: [process.execPath, path.resolve(__dirname, '../../scripts/release.js'), 'patch'],
            environment: {}, invocationDirectory: project.repo, repositoryDirectory: project.repo,
            spawnSync: services.spawnSync, now: services.now, sleep: services.sleep,
            log: (message) => messages.push(message),
        });
        const sha = project.git('rev-parse', 'origin/main');
        assert.notEqual(sha, project.git('rev-parse', 'HEAD'));
        assert.equal(release.readPackage(project.repo).version, '1.3.5');
        assert.match(project.git('ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${sha}`, 'u'));
        assert.match(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), new RegExp(`^${sha}`, 'u'));
        const branchPush = services.calls.findIndex((call) => call[0] === 'git' && call[1] === 'push' &&
            call[3]?.endsWith(':refs/heads/release/v1.3.6'));
        const tag = services.calls.findIndex((call) => call[0] === 'git' && call[1] === 'tag');
        const tagPush = services.calls.findIndex((call) => call[0] === 'git' && call[1] === 'push' &&
            call[3] === 'refs/tags/v1.3.6');
        assert.ok(branchPush >= 0 && branchPush < tag && tag < tagPush);
        assert.equal(services.registryChecks(), 2);
        assert.match(messages.at(-1), /visible on npm 8\.0 seconds after the workflow run completed/u);
    });
});
test('a failed publish job stops before npm registry polling', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const services = fakeServices(project, { failBranchPush: false, failJob: true });
        await assert.rejects(release.release('patch', {
            cwd: project.repo, spawnSync: services.spawnSync, environment: {},
            now: services.now, sleep: services.sleep, log: () => { },
        }), /Publish job .* ended as failure/u);
        assert.equal(services.registryChecks(), 0);
    });
});

test('blocked merge can resume, and a failed tag push resumes without another bump or PR', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const settings = { blockMerge: true, failTagPush: true };
        const services = fakeServices(project, settings);
        const dependencies = { cwd: project.repo, spawnSync: services.spawnSync, environment: {},
            now: services.now, sleep: services.sleep, log: () => {} };
        await assert.rejects(release.release('patch', dependencies), /Timed out waiting for release PR/u);
        assert.equal(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), '');
        settings.blockMerge = false;
        await assert.rejects(release.release('patch', dependencies), /tag rejected/u);
        settings.failTagPush = false;
        await release.release('patch', dependencies);
        assert.equal(services.calls.filter((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create').length, 1);
        assert.equal(services.calls.filter((c) => c[0] === 'npm' && c[1] === 'version').length, 1);
        assert.equal(services.calls.some((c) => c[0] === 'git' && c[1] === 'push' && c[3]?.endsWith(':refs/heads/main')), false);
        assert.equal(project.git('worktree', 'list', '--porcelain').split('worktree ').length, 2);
    });
});

test('resume after tag publication reuses the tag and targets the merge commit despite later main commits', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const settings = { failJob: true, advanceMain: true };
        const services = fakeServices(project, settings);
        const dependencies = { cwd: project.repo, spawnSync: services.spawnSync, environment: {},
            now: services.now, sleep: services.sleep, log: () => {} };
        await assert.rejects(release.release('patch', dependencies), /ended as failure/u);
        const tag = project.git('rev-parse', 'refs/tags/v1.3.6');
        assert.notEqual(tag, project.git('rev-parse', 'origin/main'));
        assert.equal(tag, project.git('rev-parse', 'origin/main^'));
        settings.failJob = false;
        await release.release('patch', dependencies);
        assert.equal(services.calls.filter((c) => c[0] === 'git' && c[1] === 'push' && c[3] === 'refs/tags/v1.3.6').length, 1);
        assert.equal(services.calls.filter((c) => c[0] === 'npm' && c[1] === 'version').length, 1);
    });
});
test('resume refuses a conflicting local tag and preserves it', async () => {
    await withTemporaryRepositoryAsync(async (directory) => {
        const project = fixture(directory);
        const settings = { blockMerge: true };
        const services = fakeServices(project, settings);
        const dependencies = { cwd: project.repo, spawnSync: services.spawnSync, environment: {},
            now: services.now, sleep: services.sleep, log: () => {} };
        await assert.rejects(release.release('patch', dependencies), /Timed out/u);
        project.git('tag', 'v1.3.6');
        settings.blockMerge = false;
        await assert.rejects(release.release('patch', dependencies), /Local tag .* points to another commit/u);
        assert.equal(project.git('rev-parse', 'v1.3.6'), project.git('rev-parse', 'HEAD'));
        assert.equal(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), '');
    });
});

for (const scenario of [
    { name: 'defaults to merge', allowed: [true, true, true], expected: 'merge' },
    { name: 'falls back to rebase', allowed: [false, true, true], expected: 'rebase' },
    { name: 'uses only merge despite preference', allowed: [true, false, false], preference: 'squash', expected: 'merge' },
    { name: 'uses only rebase', allowed: [false, true, false], expected: 'rebase' },
    { name: 'uses only squash', allowed: [false, false, true], expected: 'squash' },
    { name: 'honors caller squash preference', allowed: [true, true, true], preference: 'squash', expected: 'squash' },
    { name: 'honors caller rebase preference', allowed: [true, true, true], preference: 'rebase', expected: 'rebase' },
    { name: 'rejects disallowed preference', allowed: [false, true, true], preference: 'merge', error: /not enabled on GitHub/ },
    { name: 'rejects no allowed methods', allowed: [false, false, false], error: /No supported PR merge method/ },
    { name: 'rejects invalid preference', allowed: [true, true, true], preference: 'invalid', error: /git.releaseMergeMethod/ },
]) {
    test(`release merge selection ${scenario.name}`, async () => {
        await withTemporaryRepositoryAsync(async (directory) => {
            const project = fixture(directory);
            if (scenario.preference !== undefined) {
                require('./project-config-fixture').writeProjectConfig(project.repo, {
                    git: { releaseMergeMethod: scenario.preference, releaseRequiredChecks: ['test'] },
                });
                project.git('add', '.');
                project.git('commit', '-m', 'Configure caller merge preference');
                project.git('push', 'origin', 'main');
            }
            const [allow_merge_commit, allow_rebase_merge, allow_squash_merge] = scenario.allowed;
            const services = fakeServices(project, {
                repository: { allow_merge_commit, allow_rebase_merge, allow_squash_merge },
            });
            const run = () => release.release('patch', {
                cwd: project.repo, spawnSync: services.spawnSync, environment: {},
                now: services.now, sleep: services.sleep, log: () => {},
            });
            if (scenario.error) {
                await assert.rejects(run(), scenario.error);
                assert.equal(services.calls.some(call => call[0] === 'git' && call[1] === 'push'), false);
                assert.equal(services.calls.some(call => call[0] === 'gh' && call[1] === 'pr'), false);
            } else {
                await run();
                const mergeCall = services.calls.find(call => call.includes('repos/owner/repo/pulls/7/merge'));
                assert.ok(mergeCall.includes(`merge_method=${scenario.expected}`));
                const sha = project.git('rev-parse', 'origin/main');
                assert.match(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), new RegExp(`^${sha}`, 'u'));
            }
        });
    });
}

for (const legacy of [false, true]) {
    test(`release retry preserves ${legacy ? 'legacy squash' : 'selected merge'} method`, async () => {
        await withTemporaryRepositoryAsync(async (directory) => {
            const project = fixture(directory);
            const settings = { blockMerge: true };
            const services = fakeServices(project, settings);
            const dependencies = { cwd: project.repo, spawnSync: services.spawnSync, environment: {},
                now: services.now, sleep: services.sleep, log: () => {} };
            await assert.rejects(release.release('patch', dependencies), /Timed out waiting/);
            const stateFile = path.join(project.repo, '.git', 'worktree-keeper-release.json');
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            assert.equal(state.mergeMethod, 'merge');
            if (legacy) {
                delete state.mergeMethod;
                fs.writeFileSync(stateFile, JSON.stringify(state));
            }
            settings.blockMerge = false;
            settings.repository = { allow_merge_commit: false, allow_rebase_merge: true };
            const previousCalls = services.calls.length;
            await release.release('patch', dependencies);
            const mergeCall = services.calls.slice(previousCalls).find(call => call.includes('repos/owner/repo/pulls/7/merge'));
            assert.ok(mergeCall.includes(`merge_method=${legacy ? 'squash' : 'merge'}`));
        });
    });
}

for (const [name, settings, message] of [
    ['loose branch policy', { loosePolicy: true }, /strict status checks/],
    ['unreadable branch policy', { policyError: 'HTTP 403: Forbidden' }, /Administration read.*rerun/],
]) {
    test(`release stops before creating a PR with ${name}`, async () => {
        await withTemporaryRepositoryAsync(async directory => {
            const project = fixture(directory);
            const services = fakeServices(project, settings);
            await assert.rejects(release.release('patch', {
                cwd: project.repo, spawnSync: services.spawnSync, environment: {},
                now: services.now, sleep: services.sleep, log: () => {},
            }), message);
            assert.equal(services.calls.some(call => call[0] === 'gh' && call[1] === 'pr'), false);
            assert.equal(services.calls.some(call => call[0] === 'git' && call[1] === 'push'), false);
        });
    });
}

test('release rechecks policy before merge and stops if it changed after preflight', async () => {
    await withTemporaryRepositoryAsync(async directory => {
        const project = fixture(directory);
        const settings = {};
        const services = fakeServices(project, settings);
        const spawn = (command, args, options) => {
            const result = services.spawnSync(command, args, options);
            if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') settings.loosePolicy = true;
            return result;
        };
        await assert.rejects(release.release('patch', {
            cwd: project.repo, spawnSync: spawn, environment: {},
            now: services.now, sleep: services.sleep, log: () => {},
        }), /strict status checks/);
        assert.equal(services.calls.some(call => call.includes('repos/owner/repo/pulls/7/merge')), false);
        assert.equal(project.git('ls-remote', '--tags', 'origin'), '');
    });
});

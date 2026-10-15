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
    git('add', '.');
    git('commit', '-m', 'initial');
    git('push', '-u', 'origin', 'main');
    return { repo, origin, command, git };
}
function fakeServices(testFixture, settings) {
    const calls = [];
    let registryChecks = 0;
    const completed = Date.parse('2026-10-11T12:00:00Z');
    let now = completed + 3_000;
    const spawnSync = (command, args, options) => {
        calls.push([command, ...args]);
        if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
            return { status: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' };
        }
        if (command === 'git' && args[0] === 'push' && args[2] === 'HEAD:refs/heads/main' && settings.failBranchPush) {
            return { status: 1, stdout: '', stderr: 'non-fast-forward' };
        }
        if (command === 'git' && args[0] === 'push' && args[2] === 'refs/tags/v1.3.6' && settings.failTagPush) {
            return { status: 1, stdout: '', stderr: 'tag rejected' };
        }
        if (command === 'gh') {
            const endpoint = args[5];
            let response;
            if (endpoint === 'repos/owner/repo') {
                response = { default_branch: 'main' };
            }
            else if (endpoint.endsWith('/workflows/package.yml/runs')) {
                response = { workflow_runs: [
                        { id: 42, head_sha: testFixture.git('rev-parse', 'HEAD'), head_branch: 'v1.3.6',
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
    const exec = () => {
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
    assert.deepEqual(messages, [
        'Workflow run for v1.3.6 completed in 90.0 seconds; waiting for @example/package@1.3.6 on npm.',
    ]);
});
test('release stops before versioning when the worktree is dirty or default branch diverges', () => {
    withTemporaryRepository((directory) => {
        const project = fixture(directory);
        const services = fakeServices(project, { failBranchPush: false, failJob: false });
        fs.writeFileSync(path.join(project.repo, 'untracked.txt'), 'local work');
        assert.throws(() => release.prepare(services.spawnSync, project.repo, 'patch', () => { }), /uncommitted or untracked/u);
        fs.rmSync(path.join(project.repo, 'untracked.txt'));
        fs.writeFileSync(path.join(project.repo, 'local.txt'), 'local commit');
        project.git('add', 'local.txt');
        project.git('commit', '-m', 'local');
        assert.throws(() => release.prepare(services.spawnSync, project.repo, 'patch', () => { }), /differs from origin\/main/u);
        assert.equal(services.calls.some(([command, subcommand]) => command === 'npm' && subcommand === 'version'), false);
    });
});
test('preflight switches a clean feature branch to the synchronized default branch', () => {
    withTemporaryRepository((directory) => {
        const project = fixture(directory);
        project.git('switch', '-c', 'feature');
        const services = fakeServices(project, { failBranchPush: false, failTagPush: false, failJob: false });
        const details = release.prepare(services.spawnSync, project.repo, 'patch', () => { });
        assert.equal(details.defaultBranch, 'main');
        assert.equal(project.git('branch', '--show-current'), 'main');
        assert.equal(release.readPackage(project.repo).version, '1.3.5');
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
        assert.equal(project.git('log', '-1', '--format=%B'), '1.3.6');
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
        assert.equal(project.git('rev-parse', 'refs/tags/v1.3.6'), project.git('rev-parse', 'HEAD'));
        assert.equal(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), '');
        assert.equal(services.calls.some((call) => call[0] === 'gh' && call[6]?.includes('/actions/')), false);
    });
});
test('CLI accepts a mocked spawnSync and pushes the version before waiting for npm visibility', async () => {
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
        const sha = project.git('rev-parse', 'HEAD');
        assert.match(project.git('ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${sha}`, 'u'));
        assert.match(project.git('ls-remote', 'origin', 'refs/tags/v1.3.6'), new RegExp(`^${sha}`, 'u'));
        const branchPush = services.calls.findIndex((call) => call[0] === 'git' && call[1] === 'push' &&
            call[3] === 'HEAD:refs/heads/main');
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

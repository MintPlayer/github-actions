import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `bash` on PATH is WSL on a Windows dev box, and WSL cannot see `C:\` paths -- it reads the
 * backslashes as escapes and reports "No such file or directory". Resolve Git Bash instead,
 * from git's own exec-path, so the suite runs the same script CI runs.
 */
function gitBash(): string {
    if (process.platform !== 'win32') return '/bin/bash';
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const bash = path.join(path.resolve(execPath, '..', '..', '..'), 'bin', 'bash.exe');
    if (!fs.existsSync(bash)) throw new Error(`Git Bash not found near ${execPath}`);
    return bash;
}

const BASH = gitBash();
const ACTION_DIR = path.join(__dirname, '..', '..', 'compile-ts-action');
const SCRIPT = path.join(ACTION_DIR, 'publish.sh');

let root: string;
let origin: string;
let work: string;
let outputFile: string;

/** Run git in `cwd`, returning trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Run publish.sh in the work clone. Never throws -- the failure paths are under test. */
function publish(env: Record<string, string> = {}) {
    const base: Record<string, string> = {
        GITHUB_REF_NAME: 'main',
        GITHUB_REF_TYPE: 'branch',
        GITHUB_OUTPUT: outputFile,
        WORKING_DIRECTORY: '.',
        OUTPUT_DIR: 'dist',
        COMMIT_MESSAGE: 'build: repack the action bundle',
        VERSION_TAG_PREFIX: 'v'
    };
    try {
        const stdout = execFileSync(BASH, ['--noprofile', '--norc', SCRIPT], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, ...base, ...env }
        });
        return { status: 0, stdout, stderr: '' };
    } catch (e: any) {
        return { status: e.status as number, stdout: String(e.stdout), stderr: String(e.stderr) };
    }
}

/** Parse $GITHUB_OUTPUT into a map, tolerating CRLF. */
function outputs(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const line of fs.readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
    }
    return map;
}

/** Rewrite the bundle, the way a rebuild that actually changed something would. */
function rebuild(contents = `console.log(${Date.now()});\n`): void {
    fs.writeFileSync(path.join(work, 'dist', 'index.js'), contents);
}

/** Set the version publish.sh will read for the immutable tag. */
function setVersion(version: string): void {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version }));
}

function tagsOn(repo: string): string[] {
    const list = git(repo, 'tag', '--list');
    return list === '' ? [] : list.split(/\r?\n/).sort();
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-ts-action-'));
    origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    outputFile = path.join(root, 'github_output');

    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);

    // A temp repo inherits the developer's GLOBAL config, not just defaults: a global
    // commit.gpgsign would hang the suite on a passphrase prompt, and autocrlf writes a
    // CRLF warning to stderr that the assertions below would trip over.
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'config', 'core.autocrlf', 'false');

    fs.mkdirSync(path.join(work, 'dist'));
    fs.writeFileSync(path.join(work, 'dist', 'index.js'), 'console.log(0);\n');
    setVersion('1.4.2');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'init');
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(outputFile, '');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('publish.sh', () => {
    it('commits a rebuilt bundle, pushes it, and cuts both tags', () => {
        rebuild();

        const result = publish({ MAJOR_TAG: 'v1', VERSION_TAG_FROM: 'package.json' });

        expect(result.status).toBe(0);
        expect(outputs()['changed']).toBe('true');
        expect(outputs()['version-tag']).toBe('v1.4.2');
        expect(tagsOn(origin)).toEqual(['v1', 'v1.4.2']);
        expect(git(origin, 'log', '--oneline', 'main').split(/\r?\n/)).toHaveLength(2);
    });

    it('commits an untracked bundle -- the first-ever build of a new action', () => {
        // The workflow this replaces used `git diff`, which sees tracked files only, so a
        // brand-new action folder committed nothing and published an empty directory.
        fs.rmSync(path.join(work, 'dist'), { recursive: true });
        fs.mkdirSync(path.join(work, 'dist'));
        fs.writeFileSync(path.join(work, 'dist', 'brand-new.js'), 'console.log(1);\n');
        git(work, 'rm', '-q', '--cached', 'dist/index.js');
        git(work, 'commit', '-qm', 'drop the old bundle');
        git(work, 'push', '-q', 'origin', 'HEAD:main');

        expect(publish().status).toBe(0);

        expect(git(origin, 'ls-tree', '--name-only', 'main', 'dist/')).toContain('brand-new.js');
    });

    it('does nothing when the bundle is already current', () => {
        const before = git(origin, 'rev-parse', 'main');

        const result = publish();

        expect(result.status).toBe(0);
        expect(outputs()['changed']).toBe('false');
        expect(git(origin, 'rev-parse', 'main')).toBe(before);
    });

    it('refuses to move a version tag that already exists, and leaves it where it was', () => {
        rebuild();
        expect(publish({ VERSION_TAG_FROM: 'package.json' }).status).toBe(0);
        const pinned = git(origin, 'rev-parse', 'v1.4.2');

        rebuild('console.log("second");\n');
        const second = publish({ VERSION_TAG_FROM: 'package.json' });

        expect(second.status).not.toBe(0);
        expect(second.stderr).toContain('Bump the version');
        expect(git(origin, 'rev-parse', 'v1.4.2')).toBe(pinned);
    });

    it('accepts an annotated tag that already points at HEAD', () => {
        // rev-parse on an annotated tag returns the TAG OBJECT's sha, which never equals
        // HEAD -- so without ^{commit} peeling, a correct tag reads as a conflict.
        rebuild();
        publish({ VERSION_TAG_FROM: 'package.json' });
        git(work, 'tag', '-d', 'v1.4.2');
        git(work, 'tag', '-a', '-m', 'annotated', 'v1.4.2');
        git(work, 'push', '-qf', 'origin', 'refs/tags/v1.4.2');

        const result = publish({ VERSION_TAG_FROM: 'package.json' });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('already points here');
    });

    it('force-moves the major tag onto a newer release', () => {
        rebuild();
        publish({ MAJOR_TAG: 'v1', VERSION_TAG_FROM: 'package.json' });

        setVersion('1.5.0');
        rebuild('console.log("next");\n');
        const result = publish({ MAJOR_TAG: 'v1', VERSION_TAG_FROM: 'package.json' });

        expect(result.status).toBe(0);
        expect(git(origin, 'rev-parse', 'v1')).toBe(git(origin, 'rev-parse', 'v1.5.0'));
    });

    it('refuses to run on a ref that is not a branch', () => {
        // GITHUB_REF_NAME is the tag name on a tag-triggered run, so `git push HEAD:$REF`
        // would create a BRANCH called v1.2.0.
        rebuild();

        const result = publish({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.0' });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('needs a branch ref');
        expect(git(origin, 'branch', '--list', 'v1.2.0')).toBe('');
    });

    it('refuses a package.json with no version rather than tagging vundefined', () => {
        fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x' }));
        rebuild();

        const result = publish({ VERSION_TAG_FROM: 'package.json' });

        expect(result.status).not.toBe(0);
        expect(tagsOn(origin)).toEqual([]);
    });

    it('never leaks the token to stdout, stderr, or the git config it leaves behind', () => {
        rebuild();

        const result = publish({ GH_TOKEN: 'ghs_notarealtoken_0123456789' });

        expect(result.status).toBe(0);
        expect(result.stdout + result.stderr).not.toContain('notarealtoken');
        // The extraheader is trap-cleared, so it does not outlive the step. --get-regexp
        // exits 1 when nothing matches, which is the passing case.
        let persisted = '';
        try {
            persisted = git(work, 'config', '--local', '--get-regexp', 'http\\.');
        } catch {
            persisted = '';
        }
        expect(persisted).not.toContain('notarealtoken');
    });

    it('restores the credential actions/checkout persisted, rather than stripping it', () => {
        // Same git config key checkout writes. Clearing it instead of restoring it would
        // strip auth from every later step in the job -- invisibly, at the call site.
        const persistedByCheckout = 'AUTHORIZATION: basic persisted-by-checkout';
        git(work, 'config', '--local', '--add', 'http.https://github.com/.extraheader', persistedByCheckout);
        rebuild();

        const result = publish({ GH_TOKEN: 'ghs_notarealtoken_0123456789' });

        expect(result.status).toBe(0);
        expect(git(work, 'config', '--local', '--get-all', 'http.https://github.com/.extraheader'))
            .toBe(persistedByCheckout);
    });
});

describe('drift.sh', () => {
    /** detect_drift is a shell function, so exercise it the way publish.sh does. */
    function detect(target: string) {
        const script = `. "${ACTION_DIR.replace(/\\/g, '/')}/drift.sh"; detect_drift "${target}"`;
        try {
            return {
                status: 0,
                stdout: execFileSync(BASH, ['--noprofile', '--norc', '-c', script], {
                    cwd: work, encoding: 'utf8'
                }).trim(),
                stderr: ''
            };
        } catch (e: any) {
            return { status: e.status as number, stdout: String(e.stdout), stderr: String(e.stderr) };
        }
    }

    it('reports drift for a rebuilt bundle and none for a current one', () => {
        expect(detect('./dist')).toMatchObject({ status: 0, stdout: 'false' });

        rebuild();

        expect(detect('./dist')).toMatchObject({ status: 0, stdout: 'true' });
    });

    it('fails closed when the bundle directory does not exist', () => {
        // The whole point: `git status --porcelain` exits 0 with empty output here, so the
        // obvious implementation would report "no drift" and pass a verify job that
        // checked nothing at all.
        const result = detect('./nope');

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('does not exist');
    });

    it('fails closed when the bundle is gitignored and untracked', () => {
        // Gitignoring a bundle that is already TRACKED is harmless -- git keeps reporting
        // its changes, so drift detection still works. The trap is ignored AND untracked:
        // git status then reports nothing forever, verify passes while checking nothing,
        // and push fails hard on `git add` of an ignored path. Same repo, opposite answers.
        git(work, 'rm', '-q', '--cached', 'dist/index.js');
        fs.writeFileSync(path.join(work, '.gitignore'), 'dist/\n');
        git(work, 'add', '.gitignore');
        git(work, 'commit', '-qm', 'ignore the bundle');

        const result = detect('./dist');

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('gitignored');
    });

    it('fails closed outside a git work tree', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
        fs.mkdirSync(path.join(outside, 'dist'));
        try {
            const script = `. "${ACTION_DIR.replace(/\\/g, '/')}/drift.sh"; detect_drift "./dist"`;
            let status = 0;
            let stderr = '';
            try {
                execFileSync(BASH, ['--noprofile', '--norc', '-c', script], {
                    cwd: outside, encoding: 'utf8'
                });
            } catch (e: any) {
                status = e.status;
                stderr = String(e.stderr);
            }

            expect(status).not.toBe(0);
            expect(stderr).toContain('not a git work tree');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

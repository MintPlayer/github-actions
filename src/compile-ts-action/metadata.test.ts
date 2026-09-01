import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

/**
 * A composite action has no compiler and no type checker: a `${{ inputs.typo }}`, a `run:`
 * step missing its `shell:`, or an output bound to a step id that no longer exists all fail
 * at run time, in CI, on somebody else's pull request. These are the cheap checks that
 * catch that class before it ships.
 */

const ACTION_YML = path.join(__dirname, '..', '..', 'compile-ts-action', 'action.yml');
const action = parse(fs.readFileSync(ACTION_YML, 'utf8'));
const steps: any[] = action.runs.steps;
const stepIds = new Set(steps.map((s) => s.id).filter(Boolean));
const source = fs.readFileSync(ACTION_YML, 'utf8');

/** Every distinct `<context>.<name>` reference in the file. */
function references(context: string): string[] {
    const found = [...source.matchAll(new RegExp(`${context}\\.([A-Za-z0-9_-]+)`, 'g'))].map((m) => m[1]);
    return [...new Set(found)];
}

describe('action.yml', () => {
    it('is a composite action', () => {
        expect(action.runs.using).toBe('composite');
    });

    it('references only inputs it declares', () => {
        const declared = new Set(Object.keys(action.inputs ?? {}));

        expect(references('inputs').filter((name) => !declared.has(name))).toEqual([]);
    });

    it('declares no input it never uses', () => {
        // inputs.token was declared with a paragraph of documentation and wired to nothing,
        // so a caller passing a PAT silently got GITHUB_TOKEN behaviour instead.
        const used = new Set(references('inputs'));

        expect(Object.keys(action.inputs ?? {}).filter((name) => !used.has(name))).toEqual([]);
    });

    it('gives every run step a shell', () => {
        const missing = steps.filter((s) => s.run !== undefined && !s.shell);

        expect(missing.map((s) => s.name ?? s.id)).toEqual([]);
    });

    it('binds every output to a step that exists', () => {
        const dangling = Object.entries(action.outputs ?? {}).flatMap(([name, output]: [string, any]) =>
            [...String(output.value).matchAll(/steps\.([A-Za-z0-9_-]+)\./g)]
                .filter((m) => !stepIds.has(m[1]))
                .map((m) => `${name} -> steps.${m[1]}`));

        expect(dangling).toEqual([]);
    });

    it('never interpolates an expression into a run: block', () => {
        // The invariant that keeps a commit message containing a quote from breaking the
        // command line it was pasted into. Inputs cross into bash through env: instead,
        // where the runner passes them as data.
        const interpolating = steps
            .filter((s) => typeof s.run === 'string' && s.run.includes('${{'))
            .map((s) => s.name ?? s.id);

        expect(interpolating).toEqual([]);
    });

    it('passes every shell variable its step actually declares', () => {
        // Provided by the runner rather than by the step.
        const ambient = new Set(['GITHUB_OUTPUT', 'GITHUB_ACTION_PATH']);

        const undeclared = steps.flatMap((step) => {
            if (typeof step.run !== 'string') return [];
            const declared = new Set(Object.keys(step.env ?? {}));
            return [...step.run.matchAll(/\$\{?([A-Z][A-Z0-9_]+)\}?/g)]
                .map((m) => m[1])
                .filter((name) => !declared.has(name) && !ambient.has(name))
                .map((name) => `${step.name ?? step.id}: $${name}`);
        });

        expect([...new Set(undeclared)]).toEqual([]);
    });

    it('defaults to the safe mode and to a lockfile-enforcing install', () => {
        expect(action.inputs.mode.default).toBe('verify');
        expect(action.inputs['install-command'].default).toBe('npm ci');
    });
});

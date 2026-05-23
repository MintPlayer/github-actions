import * as core from '@actions/core';
import { run } from './main';
import { defaultProvenance } from './publish';
import { Registry, RegistryInput, RunInputs } from './types';

async function main(): Promise<void> {
    try {
        const inputs = parseInputs();
        await run(inputs);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        core.setFailed(msg);
    }
}

function parseInputs(): RunInputs {
    const folder = core.getInput('folder', { required: true });

    const registriesRaw = core.getInput('registries', { required: true });
    let parsed: unknown;
    try {
        parsed = JSON.parse(registriesRaw);
    } catch (e) {
        throw new Error(`'registries' is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`'registries' must be a JSON array`);
    }
    const registries: Registry[] = parsed.map((r, i) => validateRegistry(r, i));
    for (const r of registries) core.setSecret(r.token);

    let order: string[][] | undefined;
    const orderRaw = core.getInput('order');
    if (orderRaw) {
        let parsedOrder: unknown;
        try {
            parsedOrder = JSON.parse(orderRaw);
        } catch (e) {
            throw new Error(`'order' is not valid JSON: ${(e as Error).message}`);
        }
        if (!Array.isArray(parsedOrder) || !parsedOrder.every(g => Array.isArray(g) && g.every(s => typeof s === 'string'))) {
            throw new Error(`'order' must be a JSON array of string arrays`);
        }
        order = parsedOrder as string[][];
    }

    const concurrencyRaw = core.getInput('concurrency') || '4';
    const concurrency = parseInt(concurrencyRaw, 10);
    if (!Number.isFinite(concurrency) || concurrency < 1) {
        throw new Error(`'concurrency' must be a positive integer, got '${concurrencyRaw}'`);
    }

    const dryRun = (core.getInput('dry-run') || 'false').toLowerCase() === 'true';

    return { folder, registries, order, concurrency, dryRun };
}

function validateRegistry(raw: unknown, i: number): Registry {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`registries[${i}] must be an object`);
    }
    const r = raw as Partial<RegistryInput>;
    if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) {
        throw new Error(`registries[${i}].url must be an http(s) URL`);
    }
    if (typeof r.token !== 'string' || !r.token) {
        throw new Error(`registries[${i}].token is required`);
    }
    const access = r.access ?? 'public';
    if (access !== 'public' && access !== 'restricted') {
        throw new Error(`registries[${i}].access must be 'public' or 'restricted'`);
    }
    return {
        url: r.url,
        token: r.token,
        access,
        skipDuplicate: r.skipDuplicate ?? true,
        provenance: r.provenance ?? defaultProvenance(r.url),
    };
}

main();

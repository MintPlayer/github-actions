import * as core from '@actions/core';
import pLimit from 'p-limit';
import { discoverPackages } from './discover';
import { applyOrderOverride, toWaves } from './topo';
import { publishOne } from './publish';
import { writeSummary } from './summary';
import { PublishResult, RunInputs } from './types';

export async function run(inputs: RunInputs): Promise<void> {
    const packages = await discoverPackages(inputs.folder);
    if (packages.length === 0) {
        throw new Error(`No publishable package.json found under ${inputs.folder}`);
    }
    core.info(`Discovered ${packages.length} publishable package(s):`);
    for (const p of packages) core.info(`  - ${p.name}@${p.version}`);

    const waves = inputs.order
        ? applyOrderOverride(packages, inputs.order)
        : toWaves(packages);

    core.info(`Publish plan: ${waves.length} wave(s)`);
    waves.forEach((w, i) => {
        core.info(`  wave ${i + 1}: ${w.map(p => p.name).join(', ')}`);
    });

    const limit = pLimit(Math.max(1, inputs.concurrency));
    const allResults: PublishResult[] = [];

    for (let i = 0; i < waves.length; i++) {
        const wave = waves[i];
        core.startGroup(`Wave ${i + 1} of ${waves.length}`);
        const waveResults = await Promise.all(
            wave.map(pkg =>
                limit(async () => {
                    const perPkg: PublishResult[] = [];
                    for (const registry of inputs.registries) {
                        const r = await publishOne(pkg, registry, inputs.dryRun);
                        perPkg.push(r);
                    }
                    return perPkg;
                }),
            ),
        );
        for (const arr of waveResults) allResults.push(...arr);
        core.endGroup();
    }

    const published = allResults.filter(r => r.status === 'published');
    const skipped = allResults.filter(r => r.status === 'skipped');
    const failed = allResults.filter(r => r.status === 'failed');

    core.setOutput('published', JSON.stringify(published.map(({ name, version, registry }) => ({ name, version, registry }))));
    core.setOutput('skipped', JSON.stringify(skipped.map(({ name, version, registry, detail }) => ({ name, version, registry, reason: detail }))));
    core.setOutput('failed', JSON.stringify(failed.map(({ name, version, registry, detail }) => ({ name, version, registry, error: detail }))));

    await writeSummary(allResults);

    core.info(`Published: ${published.length}, skipped: ${skipped.length}, failed: ${failed.length}`);

    if (failed.length > 0) {
        throw new Error(`${failed.length} publish(es) failed`);
    }
}

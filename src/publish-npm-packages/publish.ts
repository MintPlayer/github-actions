import * as core from '@actions/core';
import { DiscoveredPackage, PublishResult, Registry } from './types';

const NPMJS = 'https://registry.npmjs.org';

let cachedNpmPublish: any;
async function getNpmPublish(): Promise<(opts: any) => Promise<any>> {
    if (!cachedNpmPublish) {
        const mod: any = await import('@jsdevtools/npm-publish');
        cachedNpmPublish = mod.npmPublish;
    }
    return cachedNpmPublish;
}

export async function publishOne(
    pkg: DiscoveredPackage,
    registry: Registry,
    dryRun: boolean,
): Promise<PublishResult> {
    const label = `${pkg.name}@${pkg.version} -> ${registry.url}`;
    try {
        const npmPublish = await getNpmPublish();
        const result = await npmPublish({
            package: pkg.manifestPath,
            registry: registry.url,
            token: registry.token,
            access: registry.access,
            strategy: registry.skipDuplicate ? 'all' : 'all',
            provenance: registry.provenance,
            dryRun,
            logger: {
                debug: (m: string) => core.debug(`[${label}] ${m}`),
                info: (m: string) => core.info(`[${label}] ${m}`),
                warn: (m: string) => core.warning(`[${label}] ${m}`),
                error: (m: string) => core.error(`[${label}] ${m}`),
            },
        });
        if (result.type === undefined) {
            return {
                name: pkg.name,
                version: pkg.version,
                registry: registry.url,
                status: 'skipped',
                detail: 'already published',
            };
        }
        return {
            name: pkg.name,
            version: pkg.version,
            registry: registry.url,
            status: 'published',
        };
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (registry.skipDuplicate && isAlreadyPublishedError(msg)) {
            return {
                name: pkg.name,
                version: pkg.version,
                registry: registry.url,
                status: 'skipped',
                detail: 'already published',
            };
        }
        return {
            name: pkg.name,
            version: pkg.version,
            registry: registry.url,
            status: 'failed',
            detail: msg,
        };
    }
}

function isAlreadyPublishedError(msg: string): boolean {
    const m = msg.toLowerCase();
    return (
        m.includes('eexists') ||
        m.includes('epublishconflict') ||
        m.includes('cannot publish over') ||
        m.includes('previously published')
    );
}

export function defaultProvenance(url: string): boolean {
    return url === NPMJS;
}

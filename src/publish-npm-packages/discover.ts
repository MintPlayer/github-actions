import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import { DiscoveredPackage } from './types';

export async function discoverPackages(root: string): Promise<DiscoveredPackage[]> {
    const absRoot = path.resolve(root);
    if (!fs.existsSync(absRoot)) {
        throw new Error(`folder does not exist: ${absRoot}`);
    }

    const manifests = await fg('**/package.json', {
        cwd: absRoot,
        absolute: true,
        followSymbolicLinks: false,
        ignore: ['**/node_modules/**'],
        suppressErrors: true,
    });

    const results: DiscoveredPackage[] = [];
    for (const manifestPath of manifests) {
        let pkg: any;
        try {
            pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
            continue;
        }
        if (pkg.private === true) continue;
        if (typeof pkg.name !== 'string' || !pkg.name) continue;
        if (typeof pkg.version !== 'string' || !pkg.version) continue;

        results.push({
            name: pkg.name,
            version: pkg.version,
            manifestPath,
            packageDir: path.dirname(manifestPath),
            peerDependencies: (pkg.peerDependencies ?? {}) as Record<string, string>,
            dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
        });
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

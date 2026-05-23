import { DiscoveredPackage } from './types';

export function toWaves(packages: DiscoveredPackage[]): DiscoveredPackage[][] {
    const byName = new Map<string, DiscoveredPackage>(packages.map(p => [p.name, p]));
    const discoveredNames = new Set(byName.keys());

    const edges = new Map<string, Set<string>>();
    const remainingDeps = new Map<string, Set<string>>();
    for (const p of packages) {
        const intra = new Set<string>();
        for (const dep of Object.keys(p.peerDependencies)) if (discoveredNames.has(dep)) intra.add(dep);
        for (const dep of Object.keys(p.dependencies)) if (discoveredNames.has(dep)) intra.add(dep);
        intra.delete(p.name);
        remainingDeps.set(p.name, intra);
        for (const dep of intra) {
            if (!edges.has(dep)) edges.set(dep, new Set());
            edges.get(dep)!.add(p.name);
        }
    }

    const waves: DiscoveredPackage[][] = [];
    const placed = new Set<string>();
    while (placed.size < packages.length) {
        const wave: DiscoveredPackage[] = [];
        for (const p of packages) {
            if (placed.has(p.name)) continue;
            if (remainingDeps.get(p.name)!.size === 0) wave.push(p);
        }
        if (wave.length === 0) {
            const stuck = packages.filter(p => !placed.has(p.name)).map(p => p.name);
            throw new Error(
                `peerDependency cycle detected among discovered packages: [${stuck.join(', ')}]`,
            );
        }
        wave.sort((a, b) => a.name.localeCompare(b.name));
        waves.push(wave);
        for (const p of wave) {
            placed.add(p.name);
            const dependents = edges.get(p.name);
            if (!dependents) continue;
            for (const dependent of dependents) {
                remainingDeps.get(dependent)!.delete(p.name);
            }
        }
    }
    return waves;
}

export function applyOrderOverride(
    packages: DiscoveredPackage[],
    order: string[][],
): DiscoveredPackage[][] {
    const byName = new Map(packages.map(p => [p.name, p]));
    const used = new Set<string>();
    const waves: DiscoveredPackage[][] = [];

    for (const groupGlobs of order) {
        const wave: DiscoveredPackage[] = [];
        for (const pkg of packages) {
            if (used.has(pkg.name)) continue;
            if (groupGlobs.some(g => matchesGlob(pkg.name, g))) {
                wave.push(pkg);
                used.add(pkg.name);
            }
        }
        wave.sort((a, b) => a.name.localeCompare(b.name));
        if (wave.length > 0) waves.push(wave);
    }

    const leftover = packages.filter(p => !used.has(p.name));
    if (leftover.length > 0) {
        leftover.sort((a, b) => a.name.localeCompare(b.name));
        waves.push(leftover);
    }
    void byName;
    return waves;
}

function matchesGlob(name: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name);
}

export interface RegistryInput {
    url: string;
    token: string;
    access?: 'public' | 'restricted';
    skipDuplicate?: boolean;
    provenance?: boolean;
}

export interface Registry {
    url: string;
    token: string;
    access: 'public' | 'restricted';
    skipDuplicate: boolean;
    provenance: boolean;
}

export interface DiscoveredPackage {
    name: string;
    version: string;
    manifestPath: string;
    packageDir: string;
    peerDependencies: Record<string, string>;
    dependencies: Record<string, string>;
}

export type PublishStatus = 'published' | 'skipped' | 'failed';

export interface PublishResult {
    name: string;
    version: string;
    registry: string;
    status: PublishStatus;
    detail?: string;
}

export interface RunInputs {
    folder: string;
    registries: Registry[];
    order?: string[][];
    concurrency: number;
    dryRun: boolean;
}

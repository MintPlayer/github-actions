declare module '@jsdevtools/npm-publish' {
    export interface NpmPublishOptions {
        package?: string;
        token?: string;
        registry?: string;
        tag?: string;
        access?: 'public' | 'restricted';
        provenance?: boolean;
        strategy?: 'all' | 'upgrade';
        ignoreScripts?: boolean;
        dryRun?: boolean;
        logger?: {
            debug?: (message: string) => void;
            info?: (message: string) => void;
            warn?: (message: string) => void;
            error?: (message: string) => void;
        };
        temporaryDirectory?: string;
    }

    export interface NpmPublishResult {
        id: string;
        name: string;
        version: string;
        type: 'public' | 'restricted' | undefined;
        oldVersion?: string;
        registry: string;
        tag: string;
        access?: 'public' | 'restricted';
        strategy?: 'all' | 'upgrade';
        dryRun?: boolean;
    }

    export function npmPublish(options: NpmPublishOptions): Promise<NpmPublishResult>;
}

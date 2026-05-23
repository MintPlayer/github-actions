import * as core from '@actions/core';
import { PublishResult } from './types';

export async function writeSummary(results: PublishResult[]): Promise<void> {
    if (results.length === 0) return;

    const rows = results.map(r => [
        r.name,
        r.version,
        r.registry,
        r.status === 'failed' ? `**FAIL**: ${r.detail ?? ''}` :
            r.status === 'skipped' ? `skipped (${r.detail ?? ''})` :
                'published',
    ]);

    try {
        await core.summary
            .addHeading('npm publish results')
            .addTable([
                [
                    { data: 'package', header: true },
                    { data: 'version', header: true },
                    { data: 'registry', header: true },
                    { data: 'status', header: true },
                ],
                ...rows,
            ])
            .write();
    } catch (e) {
        // Step summaries are best-effort; never fail the action over them.
        core.warning(`Failed to write step summary: ${(e as Error).message}`);
    }
}

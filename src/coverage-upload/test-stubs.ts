/**
 * Small stand-ins for vitest's `stubEnv` / `stubGlobal`, which jest has no equivalent of.
 *
 * Each records the previous value the first time a key is stubbed, so `unstubAll*` restores
 * the environment exactly rather than deleting keys that were already set by the runner.
 * That matters here: GITHUB_* variables leak in from the real runner when these tests run
 * inside a workflow.
 */
const envSnapshot = new Map<string, string | undefined>();
const globalSnapshot = new Map<string, unknown>();

export function stubEnv(key: string, value: string): void {
  if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
  process.env[key] = value;
}

export function unstubAllEnvs(): void {
  for (const [key, previous] of envSnapshot) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  envSnapshot.clear();
}

export function stubGlobal(name: string, value: unknown): void {
  const target = globalThis as unknown as Record<string, unknown>;
  if (!globalSnapshot.has(name)) globalSnapshot.set(name, target[name]);
  target[name] = value;
}

export function unstubAllGlobals(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, previous] of globalSnapshot) {
    if (previous === undefined) delete target[name];
    else target[name] = previous;
  }
  globalSnapshot.clear();
}

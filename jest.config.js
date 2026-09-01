module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    // 'd.ts' deliberately absent. Listing it makes jest resolve a package's index.d.ts
    // ahead of its index.js -- pretty-format -> ansi-styles then fails to parse as JS with
    // "Unexpected identifier 'namespace'". Latent until this repo had its first test.
    moduleFileExtensions: ['ts', 'js', 'node'],
    // tsc emits *.test.ts into lib/ (tsconfig includes them, rootDir is src/), and jest's
    // default testMatch sweeps the whole tree -- so every suite was collected twice, once
    // from source and once from a stale build artifact. CI only escaped it because `npm ci`
    // starts without lib/ and the compile action runs Test before Build.
    testPathIgnorePatterns: ['/node_modules/', '/lib/', '/dist/']
};
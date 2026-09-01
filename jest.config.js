module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    // 'd.ts' deliberately absent. Listing it makes jest resolve a package's index.d.ts
    // ahead of its index.js -- pretty-format -> ansi-styles then fails to parse as JS with
    // "Unexpected identifier 'namespace'". Latent until this repo had its first test.
    moduleFileExtensions: ['ts', 'js', 'node']
};
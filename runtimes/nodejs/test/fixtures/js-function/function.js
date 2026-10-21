// Also says whether this thread loaded the TypeScript compiler, which a .js handler has no use for.
const typescriptLoaded = () => Object.keys(require.cache).some((file) => file.includes('/node_modules/typescript/'));
exports.handler = async (event) => ({ js: true, echo: event, typescriptLoaded: typescriptLoaded() });

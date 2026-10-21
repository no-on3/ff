// A .js file where the package says "type": "module": an ES module, imported, its top-level await allowed.
const greeting = await Promise.resolve('Hello');

export const handler = async () => ({ message: greeting, esModule: typeof require === 'undefined' });

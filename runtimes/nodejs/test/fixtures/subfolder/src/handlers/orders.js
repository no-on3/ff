// A handler in a folder of the package, src/handlers/orders.create, and one further down its exports,
// src/handlers/orders.api.v1.get, as AWS Lambda's Node.js runtime follows them.
exports.create = async (event) => ({ created: event.id, file: __filename.split('/').slice(-3).join('/') });
exports.api = { v1: { get: async () => 'got' } };

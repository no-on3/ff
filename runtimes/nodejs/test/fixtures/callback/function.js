// A callback-style handler, which Lambda's Node.js 24 runtime no longer supports.
exports.handler = (event, context, callback) => callback(null, 'done');

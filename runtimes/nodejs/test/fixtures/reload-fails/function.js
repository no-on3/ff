// Loads once. After the worker crashes, its replacement can't load it any more,
// as when the environment breaks: the marker file says it loaded before.
const fs = require('node:fs');

const marker = process.env.FF_TEST_MARKER;
if (fs.existsSync(marker)) throw new Error('reload fails');
fs.writeFileSync(marker, 'loaded');

exports.handler = async (event) => {
  if (event.crash) process.exit(3);
  return 'ok';
};

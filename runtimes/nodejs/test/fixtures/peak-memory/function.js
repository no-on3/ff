// Holds `mb` megabytes in a short-lived thread, which frees them when it exits: the
// peak no longer shows in the resident size when the invocation ends, only in its maximum.
const { Worker } = require('node:worker_threads');

exports.handler = async (event) => {
  await new Promise((resolve, reject) => {
    const thread = new Worker(`Buffer.alloc(${Number(event.mb)} * 1024 * 1024, 1);`, { eval: true });
    thread.once('error', reject);
    thread.once('exit', resolve);
  });
  return { rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)) };
};

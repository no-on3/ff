// Holds `mb` megabytes on V8's heap, in 1 MB arrays of small integers (8 bytes each), as
// real code grows. V8 enforces its heap limit when it collects garbage, so one huge
// allocation could get past it.
exports.handler = async (event) => {
  const chunks = [];
  for (let i = 0; i < event.mb; i++) chunks.push(new Array(131072).fill(i));
  return chunks.length;
};

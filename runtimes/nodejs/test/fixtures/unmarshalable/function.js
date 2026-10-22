// Results that JSON can't hold.
exports.handler = async (event) => {
  switch (event.kind) {
    case 'function':
      return () => 1;
    case 'symbol':
      return Symbol('x');
    case 'bigint':
      return 10n;
    case 'circular': {
      const node = {};
      node.self = node;
      return node;
    }
    default:
      return 'ok';
  }
};

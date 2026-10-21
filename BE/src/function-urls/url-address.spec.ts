import { URL_ID, functionDomain, hostName, newUrlId, urlAddress, urlIdOf } from './url-address';

describe("a function URL's address", () => {
  const id = '0123456789abcdefghijklmnopqrstuv';

  it('draws IDs as AWS Lambda shapes them: 32 lowercase letters and digits, a new one each time', () => {
    const ids = Array.from({ length: 50 }, newUrlId);

    expect(ids.every((one) => URL_ID.test(one))).toBe(true);
    expect(new Set(ids).size).toBe(50);
  });

  it("puts the ID before the base's host, keeping its scheme and port", () => {
    expect(urlAddress('https://fn.example.tn', id)).toBe(`https://${id}.fn.example.tn/`);
    expect(urlAddress('http://fn.localhost:3001', id)).toBe(`http://${id}.fn.localhost:3001/`);
    expect(functionDomain('http://FN.localhost:3001')).toBe('fn.localhost');
  });

  it("finds the ID in a request's host, whatever its case, port or final dot", () => {
    expect(urlIdOf(`${id}.fn.localhost:3001`, 'fn.localhost')).toBe(id);
    expect(urlIdOf(`${id.toUpperCase()}.FN.example.tn.`, 'fn.example.tn')).toBe(id);
    expect(urlIdOf(`${id}.fn.example.tn`, 'fn.example.tn')).toBe(id);
  });

  it.each([
    ['no host', undefined],
    ['the function domain itself', 'fn.example.tn'],
    ['another domain', `${id}.fn.example.com`],
    ['a domain that only ends like it', `${id}.evilfn.example.tn`],
    ['a label of the wrong length', 'abc.fn.example.tn'],
    ['a label with other characters', `${id.slice(1)}-.fn.example.tn`],
    ['two labels', `a.${id}.fn.example.tn`],
    ['an IP address', '[::1]:3001'],
  ])('finds no URL in %s', (_case, host) => {
    expect(urlIdOf(host, 'fn.example.tn')).toBeUndefined();
  });

  it('reads a host without its port', () => {
    expect(hostName('Example.TN:8443')).toBe('example.tn');
    expect(hostName('')).toBeUndefined();
  });
});

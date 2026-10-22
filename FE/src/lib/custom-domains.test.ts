import { describe, expect, it } from 'vitest';
import { domainInputProblem, domainStatusText, recordText } from './custom-domains';

describe("a URL's own domain, as the form takes it", () => {
  it('lets through what may be a domain, the API checking it fully', () => {
    expect(domainInputProblem('Shop.Example.TN.')).toBeNull();
    expect(domainInputProblem('example.tn')).toBeNull();
  });

  it.each([
    ['nothing', '  ', 'Type a domain, such as shop.example.tn'],
    ['an address', 'https://shop.example.tn/', 'A domain alone, without https:// or a path, such as shop.example.tn'],
    ['a path', 'shop.example.tn/cart', 'A domain alone, without https:// or a path, such as shop.example.tn'],
    ['one label', 'localhost', 'A domain has two labels at least, such as example.tn'],
    ['a space', 'my shop.example.tn', 'A domain has letters, digits, hyphens and dots only'],
  ])('says what is wrong with %s', (_case, text, problem) => {
    expect(domainInputProblem(text)).toBe(problem);
  });
});

describe("a URL's own domain, to read", () => {
  it('writes each record as a DNS provider asks for it, a TXT value in quotes', () => {
    expect(recordText({ type: 'CNAME', name: 'shop.example.tn', value: 'abc.fn.example.tn' })).toBe('CNAME  shop.example.tn  abc.fn.example.tn');
    expect(recordText({ type: 'TXT', name: '_ff-verify.example.tn', value: 'ff-verify=4f1c' })).toBe('TXT  _ff-verify.example.tn  "ff-verify=4f1c"');
  });

  it('says where the domain stands, and where the URL answers there: its scheme and port', () => {
    const production = 'https://abc.fn.example.tn/';
    expect(domainStatusText({ domain: 'shop.example.tn', status: 'verified' }, production)).toBe(
      'Verified: the URL answers at https://shop.example.tn/, its certificate made at the first request.',
    );
    expect(domainStatusText({ domain: 'shop.example.tn', status: 'verified' }, 'http://abc.fn.localhost:3001/')).toBe(
      'Verified: the URL answers at http://shop.example.tn:3001/.',
    );
    expect(domainStatusText({ domain: 'shop.example.tn', status: 'pending' }, production)).toBe(
      'Waiting for its DNS records: make one of the sets below, then check again.',
    );
  });
});

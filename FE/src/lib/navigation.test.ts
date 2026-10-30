import { describe, expect, it } from 'vitest';
import { consoleNav, isOpen, type NavItem } from './navigation';

const labels = (role: Parameters<typeof consoleNav>[0]) => consoleNav(role).map((group) => [group.label, group.items.map((item) => item.label)]);

describe('consoleNav', () => {
  it("gives an owner the account's members and API keys, as the API lets owners alone manage them", () => {
    expect(labels('owner')).toEqual([
      [null, ['Functions', 'Databases', 'Caches', 'Buckets', 'Queues', 'Alarms', 'Usage', 'Billing']],
      ['Account', ['Settings', 'Notifications', 'Members', 'API keys']],
    ]);
  });

  it.each(['developer', 'viewer'] as const)('gives a %s the same pages without members and API keys', (role) => {
    expect(labels(role)).toEqual([
      [null, ['Functions', 'Databases', 'Caches', 'Buckets', 'Queues', 'Alarms', 'Usage', 'Billing']],
      ['Account', ['Settings', 'Notifications']],
    ]);
  });
});

describe('isOpen', () => {
  const item = (label: string): NavItem => consoleNav('owner').flatMap((group) => group.items).find((each) => each.label === label)!;
  const open = (pathname: string) =>
    consoleNav('owner')
      .flatMap((group) => group.items)
      .filter((each) => isOpen(each, pathname))
      .map((each) => each.label);

  it('opens Functions on the home, which lists them, on the list and on a function', () => {
    expect(open('/')).toEqual(['Functions']);
    expect(open('/functions')).toEqual(['Functions']);
    expect(open('/functions/3f6c1a2e-8b1d-4c3a-9a51-0d2f6e7b8c01')).toEqual(['Functions']);
    expect(open('/functions/new')).toEqual(['Functions']);
  });

  it('opens Databases on their list and on a database, Caches on theirs', () => {
    expect(open('/databases')).toEqual(['Databases']);
    expect(open('/databases/7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f')).toEqual(['Databases']);
    expect(open('/caches')).toEqual(['Caches']);
    expect(open('/buckets')).toEqual(['Buckets']);
  });

  it("opens one account page at a time: the settings only on their own path, which the others' start with", () => {
    expect(open('/account')).toEqual(['Settings']);
    expect(open('/account/')).toEqual(['Settings']);
    expect(open('/account/api-keys')).toEqual(['API keys']);
    expect(open('/account/members')).toEqual(['Members']);
  });

  it('opens Billing on a pro-forma, and nothing on a page that only starts with the same letters', () => {
    expect(open('/billing/pro-formas/pf-0001')).toEqual(['Billing']);
    expect(isOpen(item('Usage'), '/usage-export')).toBe(false);
  });
});

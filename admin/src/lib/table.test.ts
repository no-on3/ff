import { describe, expect, it } from 'vitest';
import { currentCursor, firstPage, nextPage, pageNumber, pageParams, previousPage } from './table';

describe('pageParams', () => {
  it('asks for a page: the limit, the search, the filters set, and the cursor', () => {
    expect(pageParams({ search: ' amira ', filters: { status: 'pending', plan: '' } }, '42')).toEqual({
      limit: '50',
      q: 'amira',
      status: 'pending',
      before: '42',
    });
  });

  it('leaves out an empty search and the first page cursor', () => {
    expect(pageParams({ search: '  ', filters: {} }, null, 20)).toEqual({ limit: '20' });
  });
});

describe('paging', () => {
  it('goes forward with the API\'s cursors, and back without asking the API to remember', () => {
    let paging = firstPage();
    expect([pageNumber(paging), currentCursor(paging)]).toEqual([1, null]);

    paging = nextPage(nextPage(paging, '90'), '40');
    expect([pageNumber(paging), currentCursor(paging)]).toEqual([3, '40']);

    paging = previousPage(paging);
    expect([pageNumber(paging), currentCursor(paging)]).toEqual([2, '90']);
    expect(previousPage(previousPage(paging))).toEqual(firstPage());
  });
});

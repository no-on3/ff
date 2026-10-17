import { describe, expect, it } from 'vitest';
import { accountUpdateBody, formatWhen, newAccountBody } from './accounts';

describe('newAccountBody', () => {
  it('sends the name and what the user filled in, trimmed', () => {
    expect(newAccountBody({ name: '  Atelier Sfax ', useCase: ' Image resizing ', country: 'tn', taxId: ' 1234567/A/M/000 ' })).toEqual({
      name: 'Atelier Sfax',
      useCase: 'Image resizing',
      country: 'TN',
      taxId: '1234567/A/M/000',
    });
  });

  it('leaves out the optional fields left empty, so the API applies its defaults', () => {
    expect(newAccountBody({ name: 'Team', useCase: '  ', country: '', taxId: '' })).toEqual({ name: 'Team' });
  });
});

describe('accountUpdateBody', () => {
  const stored = { name: 'Atelier Sfax', taxId: null };

  it('sends nothing when nothing changed', () => {
    expect(accountUpdateBody(stored, { name: 'Atelier Sfax', taxId: '' })).toEqual({});
    expect(accountUpdateBody(stored, { name: ' Atelier Sfax ', taxId: '  ' })).toEqual({});
  });

  it('sends only what changed', () => {
    expect(accountUpdateBody(stored, { name: 'Atelier Gabès', taxId: '' })).toEqual({ name: 'Atelier Gabès' });
    expect(accountUpdateBody(stored, { name: 'Atelier Sfax', taxId: '1234567/A/M/000' })).toEqual({ taxId: '1234567/A/M/000' });
  });

  it('removes the tax ID when the field is emptied: null, as the API expects', () => {
    expect(accountUpdateBody({ name: 'Atelier Sfax', taxId: '1234567/A/M/000' }, { name: 'Atelier Sfax', taxId: '' })).toEqual({
      taxId: null,
    });
  });
});

describe('formatWhen', () => {
  it('shows a dash for a time that never happened', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen(undefined)).toBe('—');
  });

  it('shows a time as day, month, year and minutes', () => {
    expect(formatWhen('2026-10-17T12:05:00.000Z')).toMatch(/^1[78] Oct 2026, \d{2}:\d{2}$/);
  });
});

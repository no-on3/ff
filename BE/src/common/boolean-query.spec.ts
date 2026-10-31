import { BadRequestException } from '@nestjs/common';
import { booleanQuery } from './boolean-query';

describe('booleanQuery', () => {
  it('reads true and false, and absent as false', () => {
    expect([booleanQuery('force', 'true'), booleanQuery('force', 'false'), booleanQuery('force', undefined)]).toEqual([true, false, false]);
  });

  it('refuses anything else, naming the parameter', () => {
    for (const value of ['yes', '1', 'TRUE', '']) {
      expect(() => booleanQuery('force', value)).toThrow(new BadRequestException('force must be true or false'));
    }
  });
});

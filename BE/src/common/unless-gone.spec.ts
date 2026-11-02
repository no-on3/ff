/** L1: a lookup's 404 read as none, and any other failure thrown on. */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { unlessGone } from './unless-gone';

describe('unlessGone (L1)', () => {
  it('answers what is found, none for a 404, and throws any other failure', async () => {
    expect(await unlessGone(Promise.resolve('fn-1'))).toBe('fn-1');
    expect(await unlessGone(Promise.reject(new NotFoundException('gone')))).toBeUndefined();
    await expect(unlessGone(Promise.reject(new BadRequestException('no')))).rejects.toBeInstanceOf(BadRequestException);
  });
});

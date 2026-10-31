import { BadRequestException } from '@nestjs/common';

/** A query parameter that is true or false, as ?force=true is: absent, false; anything else refused, named. */
export function booleanQuery(name: string, value: string | undefined): boolean {
  if (value !== undefined && value !== 'true' && value !== 'false') throw new BadRequestException(`${name} must be true or false`);
  return value === 'true';
}

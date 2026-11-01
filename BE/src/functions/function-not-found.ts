import { NotFoundException } from '@nestjs/common';
import { Function } from './entities/function.entity';

/** The answer for a function the account hasn't: another account's is not found, exactly like one that doesn't exist, so that no account learns of another's. */
export const functionNotFound = (id: string): NotFoundException => new NotFoundException(`Function with ID ${id} not found`);

/** The answer for a version the function hasn't. */
export const noSuchVersion = (function_: Pick<Function, 'name'>, number: number): NotFoundException =>
  new NotFoundException(`The function ${function_.name} has no version ${number}: GET /functions/{id}/versions lists them`);

/** The answer for an alias the function hasn't. */
export const noSuchAlias = (function_: Pick<Function, 'name'>, name: string): NotFoundException =>
  new NotFoundException(`The function ${function_.name} has no alias ${name}: GET /functions/{id}/aliases lists them`);

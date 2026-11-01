import { NotFoundException } from '@nestjs/common';

/** The answer for a function the account hasn't: another account's is not found, exactly like one that doesn't exist, so that no account learns of another's. */
export const functionNotFound = (id: string): NotFoundException => new NotFoundException(`Function with ID ${id} not found`);

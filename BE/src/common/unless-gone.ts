import { NotFoundException } from '@nestjs/common';

/** What `find` finds, or undefined once it is gone: a 404 read as none, any other failure thrown on. */
export async function unlessGone<T>(find: Promise<T>): Promise<T | undefined> {
  try {
    return await find;
  } catch (error) {
    if (error instanceof NotFoundException) return undefined;
    throw error;
  }
}

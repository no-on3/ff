import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'ff:public';

/** A route anyone may call, without a token: the guard denies every other one by default (D4). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

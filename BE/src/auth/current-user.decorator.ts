import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../accounts/entities/user.entity';

/** The logged-in user (P-12), when a token was used; undefined in development mode. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User | undefined => ctx.switchToHttp().getRequest<{ user?: User }>().user,
);

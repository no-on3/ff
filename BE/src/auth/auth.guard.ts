import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';
import { Identity, InvalidTokenError, TokenVerifier, UnverifiedEmailError } from './token-verifier';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  identity?: Identity;
}

/** The token of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | string[] | undefined): string {
  if (header === undefined) throw new UnauthorizedException('Authentication required');
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match) throw new UnauthorizedException('Authentication required: send "Authorization: Bearer <token>"');
  return match[1];
}

/**
 * The global guard (D4): it denies by default. A route passes when it is
 * @Public(), or with a valid access token, whose user it records on the
 * request. @Principal() then turns that user into an account (P-12).
 * Development mode reads no token: @Principal() acts as the development account.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    if (this.config.get<string>('auth.mode') === 'dev') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (token.startsWith('ffk_')) throw new UnauthorizedException('API keys are not accepted yet');
    try {
      request.identity = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw new UnauthorizedException(error.message);
      if (error instanceof UnverifiedEmailError) throw new ForbiddenException(error.message);
      throw error; // the realm's keys couldn't be read: a platform failure
    }
    return true;
  }
}

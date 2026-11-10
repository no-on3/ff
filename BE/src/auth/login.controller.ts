import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from './public.decorator';

/**
 * Where a client logs in to this API: the realm's issuer, whose discovery
 * document names the rest, or none in development mode. The console is told
 * its issuer when it is built; `ff` asks here, so that a customer names the
 * API alone.
 */
export type LoginSettings = { mode: 'oidc'; issuer: string } | { mode: 'dev' };

@ApiTags('auth')
@Controller('login')
export class LoginController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Where to log in, for `ff login`: the issuer whose device flow gives a token for this API, without a token; none in development mode" })
  @ApiResponse({ status: 200, description: '{"mode":"oidc","issuer":"https://login.ff.example/realms/ff"}, or {"mode":"dev"}' })
  settings(): LoginSettings {
    const oidc = this.config.get<{ issuer: string }>('auth.oidc');
    return oidc ? { mode: 'oidc', issuer: oidc.issuer } : { mode: 'dev' };
  }
}

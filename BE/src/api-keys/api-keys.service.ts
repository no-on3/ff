import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { Principal } from '../auth/principal';
import { describeError } from '../common/describe-error';
import { hashSecret, newApiKey, parseApiKey, secretMatches } from './api-key-format';
import { ApiKeyView, CreateApiKeyDto, CreatedApiKey } from './dto/api-key.dto';
import { ApiKey } from './entities/api-key.entity';

/** At most this many keys per account work at once (D3). */
export const MAX_KEYS_PER_ACCOUNT = 20;
/** last_used_at is written at most this often per key, not on every request. */
const LAST_USED_PRECISION_MS = 60_000;

function view(key: ApiKey): ApiKeyView {
  const { id, name, scopes, createdBy, createdAt, expiresAt, lastUsedAt, revokedAt } = key;
  return { id, name, scopes: scopes as ApiKeyView['scopes'], createdBy, createdAt, expiresAt, lastUsedAt, revokedAt };
}

/** API keys (client-readiness plan, P-13, D3), for scripts, CI and the CLI. */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectRepository(ApiKey) private readonly keys: Repository<ApiKey>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
  ) {}

  /** The account's keys, newest first. */
  async list(accountId: string): Promise<ApiKeyView[]> {
    return (await this.keys.find({ where: { accountId }, order: { createdAt: 'DESC' } })).map(view);
  }

  /** A new key for the account, created by `userId`: the whole key is in this answer only. */
  async create(accountId: string, userId: string, dto: CreateApiKeyDto, now = new Date()): Promise<CreatedApiKey> {
    const expiresAt = dto.expiresAt === undefined ? null : new Date(dto.expiresAt);
    if (expiresAt && expiresAt <= now) throw new BadRequestException('expiresAt must be in the future');
    const working = await this.keys.count({
      where: [
        { accountId, revokedAt: IsNull(), expiresAt: IsNull() },
        { accountId, revokedAt: IsNull(), expiresAt: MoreThan(now) },
      ],
    });
    if (working >= MAX_KEYS_PER_ACCOUNT) {
      throw new BadRequestException(`An account has at most ${MAX_KEYS_PER_ACCOUNT} keys: revoke one first`);
    }
    const { id, secret, key } = newApiKey();
    const saved = await this.keys.save(
      this.keys.create({ id, accountId, createdBy: userId, name: dto.name, secretSha256: hashSecret(secret), scopes: dto.scopes, expiresAt }),
    );
    return { ...view(saved), key };
  }

  /** Revokes the account's key at once; another account's is not found. */
  async revoke(accountId: string, id: string, now = new Date()): Promise<ApiKeyView> {
    const key = await this.keys.findOne({ where: { id, accountId } });
    if (!key) throw new NotFoundException(`API key ${id} not found`);
    key.revokedAt ??= now;
    return view(await this.keys.save(key));
  }

  /**
   * The principal of a key, checked on every request: the secret, then that it
   * isn't revoked or expired, then its creator's current role in the account
   * (D3). A key whose creator left the account stops working.
   */
  async authenticate(value: string, now = new Date()): Promise<Principal> {
    const parsed = parseApiKey(value);
    const key = parsed ? await this.keys.findOne({ where: { id: parsed.id }, relations: { account: true } }) : null;
    // The same answer for an unknown key and a wrong secret: a key ID alone reveals nothing.
    if (!parsed || !key || !secretMatches(parsed.secret, key.secretSha256)) throw new UnauthorizedException('The API key is invalid');
    if (key.revokedAt) throw new UnauthorizedException('The API key was revoked');
    if (key.expiresAt && key.expiresAt <= now) throw new UnauthorizedException('The API key has expired');
    const membership = await this.memberships.findOne({ where: { accountId: key.accountId, userId: key.createdBy } });
    if (!membership) throw new UnauthorizedException("The API key's creator is no longer a member of its account");

    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= LAST_USED_PRECISION_MS) {
      this.keys
        .update({ id: key.id }, { lastUsedAt: now })
        .catch((error: unknown) => this.logger.warn(`Could not record the use of API key ${key.id}: ${describeError(error)}`));
    }
    return {
      accountId: key.accountId,
      accountStatus: (key.account as Account).status,
      keyId: key.id,
      userId: key.createdBy,
      role: membership.role,
      scopes: key.scopes,
    };
  }
}

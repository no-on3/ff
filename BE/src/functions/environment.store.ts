import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { Sealed } from '../encryption/envelope';
import { EncryptionService } from '../encryption/encryption.service';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { EnvironmentDocument, FunctionEnvironmentValues, NO_ENVIRONMENT, isEmpty } from './environment';

/** What a function's environment is sealed for: it opens for that function alone. */
const sealedFor = (functionId: string) => `function-environment:${functionId}`;

/** What a version's environment is sealed for: that version of that function alone, so that none opens as another's. */
const sealedForVersion = (functionId: string, version: number) => `function-version-environment:${functionId}:${version}`;

/**
 * Keeps each function's variables and secrets, sealed (EncryptionService), in
 * their own table, and seals and opens its versions'. Nothing else reads or
 * writes that table, nor opens a version's.
 */
@Injectable()
export class EnvironmentStore {
  constructor(
    @InjectRepository(FunctionEnvironment) private readonly rows: Repository<FunctionEnvironment>,
    private readonly encryption: EncryptionService,
  ) {}

  /** The function's environment, opened; NO_ENVIRONMENT when it has none. Throws UnsealError when the platform's keys can't open it. */
  async load(functionId: string, manager: EntityManager = this.rows.manager): Promise<FunctionEnvironmentValues> {
    const row = await manager.findOne(FunctionEnvironment, { where: { functionId } });
    if (!row) return NO_ENVIRONMENT;
    const document = this.encryption.openJson<EnvironmentDocument>(row.document, sealedFor(functionId));
    return { revision: row.revision, variables: document.variables ?? {}, secrets: document.secrets ?? {} };
  }

  /** A version's environment as it was published, sealed for that version alone; null when it was empty. */
  sealVersion(functionId: string, version: number, environment: FunctionEnvironmentValues): Sealed | null {
    if (isEmpty(environment)) return null;
    const document: EnvironmentDocument = { variables: environment.variables, secrets: environment.secrets };
    return this.encryption.sealJson(document, sealedForVersion(functionId, version));
  }

  /** A version's environment, opened; NO_ENVIRONMENT for none. Its revision is the version's own, which its pods are named by. */
  openVersion(functionId: string, version: number, sealed: Sealed | null | undefined): FunctionEnvironmentValues {
    if (!sealed) return NO_ENVIRONMENT;
    const document = this.encryption.openJson<EnvironmentDocument>(sealed, sealedForVersion(functionId, version));
    return { revision: `v${version}`, variables: document.variables ?? {}, secrets: document.secrets ?? {} };
  }

  /** Saves the function's environment, sealed anew; an empty one deletes its row. */
  async save(
    fn: { id: string; accountId: string },
    environment: FunctionEnvironmentValues,
    manager: EntityManager = this.rows.manager,
  ): Promise<void> {
    if (isEmpty(environment)) {
      await manager.delete(FunctionEnvironment, { functionId: fn.id });
      return;
    }
    const document: EnvironmentDocument = { variables: environment.variables, secrets: environment.secrets };
    await manager.save(FunctionEnvironment, {
      functionId: fn.id,
      accountId: fn.accountId,
      revision: environment.revision,
      document: this.encryption.sealJson(document, sealedFor(fn.id)),
    });
  }
}

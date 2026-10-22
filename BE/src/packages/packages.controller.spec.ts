/**
 * L1: who may upload and list packages, as the routes declare it for the global
 * guard; and an upload through the app as main.ts sets it up: the body reaches
 * the service as it comes, past the 100 KB that JSON bodies have, and a body
 * too large closes the connection after its answer.
 */
import { INestApplication, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { AccountStatus } from '../accounts/entities/account.entity';
import { configureApp } from '../app-setup';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { PackagesController } from './packages.controller';
import { PackageView, PackagesService } from './packages.service';

const ACCOUNT = '123456789012';
const VIEW: PackageView = {
  codeSha256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
  codeSize: 204_800,
  unpackedSize: 409_600,
  fileCount: 3,
  createdAt: new Date('2026-10-21T12:00:00Z'),
};

const reflector = new Reflector();
const rules = (handler: keyof PackagesController) => {
  const method = PackagesController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('PackagesController', () => {
  it('lets writers upload, in an approved account, with a key that has functions:write; every member list', () => {
    expect(rules('upload')).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' });
    expect(rules('list')).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
  });

  describe('an upload, through HTTP', () => {
    let app: INestApplication;
    let url: string;
    /** What the service read of each upload, and what it answers. */
    const received: Array<{ accountId: string; bytes: Buffer; contentType?: string; contentLength?: number }> = [];
    let answer: () => { created: boolean; package: PackageView };
    const service = {
      upload: async (accountId: string, body: Readable, contentType?: string, contentLength?: number) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk as Buffer);
        received.push({ accountId, bytes: Buffer.concat(chunks), contentType, contentLength });
        return answer();
      },
      list: async () => [VIEW],
    };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ controllers: [PackagesController], providers: [{ provide: PackagesService, useValue: service }] }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.use((request: { principal?: Principal }, _response: unknown, next: () => void) => {
        request.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
        next();
      });
      const settings: Record<string, unknown> = { 'cors.origins': [], 'http.trustProxy': [], 'http.apiDocs': false };
      configureApp(app, { getOrThrow: (key: string) => settings[key] } as unknown as ConfigService);
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    });

    afterAll(() => app.close());

    beforeEach(() => {
      received.length = 0;
      answer = () => ({ created: true, package: VIEW });
    });

    const post = (body: Buffer, contentType = 'application/zip') =>
      fetch(`${url}/packages`, { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(body) });

    it('hands the service the body as it comes, 200 KB past the limit of JSON bodies, and answers 201 for a new package', async () => {
      const zip = randomBytes(200 * 1024);

      const res = await post(zip);

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ...VIEW, createdAt: VIEW.createdAt.toISOString() });
      expect(received).toEqual([{ accountId: ACCOUNT, bytes: zip, contentType: 'application/zip', contentLength: zip.length }]);
    });

    it('answers 200 for a package the account had already', async () => {
      answer = () => ({ created: false, package: VIEW });

      expect((await post(randomBytes(16))).status).toBe(200);
    });

    it('closes the connection after refusing a body too large, rather than read the rest of it', async () => {
      answer = () => {
        throw new PayloadTooLargeException('A package may have 52,428,800 bytes (50 MB) at most');
      };

      const res = await post(randomBytes(16));

      expect([res.status, res.headers.get('connection')]).toEqual([413, 'close']);
    });

    it('lists the packages', async () => {
      expect(await (await fetch(`${url}/packages`)).json()).toEqual([{ ...VIEW, createdAt: VIEW.createdAt.toISOString() }]);
    });

    it('refuses a codeSha256 that is no SHA-256 in base64, as Lambda gives it', async () => {
      const res = await fetch(`${url}/packages?codeSha256=abc`);

      expect([res.status, ((await res.json()) as { message: string[] }).message]).toEqual([
        400,
        ['codeSha256 must be a SHA-256 in base64, as AWS Lambda gives it: 44 characters ending with ='],
      ]);
    });
  });
});

import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import api, { accountsApi, apiKeysApi, functionsApi, setApiAccount, setApiAuth } from './api';

// The real client and its interceptors, with the network replaced: each request is recorded and answered.
const sent: InternalAxiosRequestConfig[] = [];
let reply: { status: number; data: unknown } = { status: 200, data: {} };
const realAdapter = api.defaults.adapter;

beforeEach(() => {
  sent.length = 0;
  reply = { status: 200, data: {} };
  api.defaults.adapter = async (request) => {
    sent.push(request);
    const response: AxiosResponse = { data: reply.data, status: reply.status, statusText: '', headers: {}, config: request };
    if (reply.status >= 400) {
      throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', request, null, response);
    }
    return response;
  };
});

afterEach(() => {
  api.defaults.adapter = realAdapter;
  setApiAuth(null);
  setApiAccount(undefined);
});

const header = (request: InternalAxiosRequestConfig, name: string) => request.headers.get(name) ?? undefined;

describe('the API client', () => {
  it('calls the configured API', async () => {
    await functionsApi.getAllFunctions();

    expect(sent[0].baseURL).toBe(config.apiUrl);
  });

  it("sends the user's token and the chosen account with every request", async () => {
    setApiAuth({ accessToken: async () => 'token-1', onUnauthorized: vi.fn() });
    setApiAccount('123456789012');

    await functionsApi.getAllFunctions();
    await apiKeysApi.listKeys();
    await accountsApi.updateAccount('123456789012', { name: 'Renamed' });

    for (const request of sent) {
      expect(header(request, 'Authorization')).toBe('Bearer token-1');
      expect(header(request, 'X-FF-Account')).toBe('123456789012');
    }
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'get /functions',
      'get /api-keys',
      'patch /accounts/123456789012',
    ]);
  });

  it('asks for the token at each request, so a renewed token is used at once', async () => {
    const tokens = ['token-1', 'token-2'];
    setApiAuth({ accessToken: async () => tokens.shift(), onUnauthorized: vi.fn() });

    await accountsApi.me();
    await accountsApi.me();

    expect(sent.map((request) => header(request, 'Authorization'))).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('sends no X-FF-Account before an account is chosen, e.g. when creating the first one', async () => {
    setApiAuth({ accessToken: async () => 'token-1', onUnauthorized: vi.fn() });

    await accountsApi.createAccount({ name: 'Atelier Sfax' });

    expect(header(sent[0], 'X-FF-Account')).toBeUndefined();
    expect(sent[0].data).toBe('{"name":"Atelier Sfax"}');
  });

  it('sends no token in development mode', async () => {
    await functionsApi.getAllFunctions();

    expect(header(sent[0], 'Authorization')).toBeUndefined();
  });

  it("ends the session on a 401 with the API's reason, and still fails the request", async () => {
    const onUnauthorized = vi.fn();
    setApiAuth({ accessToken: async () => 'expired', onUnauthorized });
    reply = { status: 401, data: { statusCode: 401, message: 'The token has expired', requestId: 'r-1' } };

    await expect(functionsApi.getAllFunctions()).rejects.toThrow('Request failed with status code 401');
    expect(onUnauthorized).toHaveBeenCalledWith('The token has expired');
  });

  it('leaves any other refusal to the page: a 403 keeps the session', async () => {
    const onUnauthorized = vi.fn();
    setApiAuth({ accessToken: async () => 'token-1', onUnauthorized });
    reply = { status: 403, data: { statusCode: 403, message: "The viewer role can't do this" } };

    await expect(functionsApi.createFunction({ name: 'f', runtime: 'nodejs', code: '', memory: 128, timeout: 3 })).rejects.toThrow();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

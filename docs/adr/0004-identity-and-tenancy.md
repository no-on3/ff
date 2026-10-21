# ADR 0004: Identity and tenancy

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Supersedes** | The development tenant `FF_DEV_USER_ID` and the `@User()` decorator (migration plan K-07); the parent plan's sketch of F-01, a principal `{ userId, orgId, roles }` |
| **Implementation** | [Client-readiness plan](../client-readiness-plan.md): decisions D1 to D5 and D12; tasks P-02, P-10 to P-17, P-70 and P-71 |
| **Related** | [Parent plan](../local-markets-and-aws-portability-plan.md) §4.8 (identity) and §9.2 (personal data); its ADR-006 (12-digit account IDs) |

## Context

FF runs customers' code and will bill them for it, but it has no accounts yet:
- **The tenant is whatever `@User()` returns:** a token subject that nothing sets, else `FF_DEV_USER_ID`. If that variable is set in production, every anonymous caller is that tenant. If it isn't, every request gets 401.
- **Ownership is checked only on update and delete.** Anyone who knows a function ID can read its code, run it on the owner's bill, and read its callers' inputs and outputs (parent finding C-3).
- **Every tenant gets the same quota,** and nothing limits request rates.

Three facts shape the decision:
1. **The pilot customers are teams:** agencies, startups, a university lab.
2. **Personal data must stay in Tunisia** (parent §9.2). That rules out a foreign identity service.
3. **The tenancy key is hard to change later.** It names each tenant's Kubernetes namespace, so changing it means moving every customer's Deployments.

## Decision

### 1. The tenant is an account (D1)
- **Accounts** own everything a customer creates. An account has:
  - an ID of **12 random decimal digits**, the AWS-shaped format of parent ADR-006. Leading zeros are allowed, so the ID is a string, never a number;
  - a name, a plan, a country (default `TN`), and an optional tax ID for B2B invoices;
  - a status: `pending`, `active`, `rejected`, `suspended` or `closed`.
- **Users** are people. A user belongs to one or more accounts through **memberships**, each with a role (§4).
- **Functions belong to the account,** not to the user who created them.
- **Kubernetes:** the tenant namespace is `ff-t-` followed by the first 12 hexadecimal characters of the SHA-256 of the account ID. Its `ff.dev/tenant-id` annotation holds the account ID.
- **Development data is reset** once, when `functions.userId` becomes `account_id`. No customer data exists yet.

### 2. Identity comes from Keycloak; the backend only checks tokens (D2)
- **Keycloak** (Apache-2.0), self-hosted in Tunisia, with one realm, `ff`. FF stores no passwords and keeps no sessions.
- **Clients:**

  | Client | Who | Flow |
  |---|---|---|
  | `ff-console` | The customer console | Authorization Code with PKCE (public client) |
  | `ff-cli` | The `ff` CLI | OAuth device flow (RFC 8628) |
  | `ff-admin` | The admin dashboard, operators only (§6) | Authorization Code with PKCE (public client) |
  | `ff-e2e` | End-to-end tests | Password grant, in the development realm only |

- **The backend is a resource server.** For each access token it checks:
  - the signature, against the realm's published keys (JWKS). The keys are cached, and fetched again when a token names an unknown key;
  - the algorithm: asymmetric only. `none` and HMAC algorithms are refused;
  - `iss` (the realm), `aud` (the API's audience, `ff-api`), `exp` and `nbf`, with at most 30 seconds of clock skew;
  - `email_verified` is true.
- **Sign-up:**
  1. Keycloak's self-registration, with e-mail verification and acceptance of the terms.
  2. The backend creates the user record on the user's first authenticated call. It is keyed by the token's `sub`.
  3. `POST /accounts` creates an account, with the caller as its owner.
  4. **During the beta, a new account is `pending`** until an operator approves it (§6). A pending account can't deploy or invoke.
- **Development mode:** `FF_AUTH_MODE=dev` with `FF_DEV_ACCOUNT_ID` acts as that account's owner without a token. The header `X-FF-Dev-Account` acts as another account, so tests can prove isolation. **Production refuses to start in this mode.**

### 3. API keys for scripts, CI and the CLI (D3)
- **Format:** `Authorization: Bearer ffk_<key ID>_<secret>`.
  - The key ID is 12 random lowercase hexadecimal characters. It is the key's primary key, and it is safe to show and log.
  - The secret is 32 random bytes in base64url: 43 characters.
  - The whole key matches `^ffk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$`. The guard tells keys from tokens by the `ffk_` prefix, which secret scanners can match too.
- **Storage:** only the SHA-256 of the secret, compared in constant time. The secret is shown once, when the key is created.
- **Scopes:** `functions:read`, `functions:write`, `functions:invoke`, `logs:read`, `metrics:read`, `usage:read`.
- **A key never gets more than its creator's role.** This is checked on every request, not only when the key is created: a key loses access when its creator's role is lowered, or when its creator leaves the account.
- **Life cycle:** an optional expiry, `last_used_at`, and revocation. At most 20 keys per account.

### 4. Authorization: deny by default, queries scoped to the account (D4)
- **The guard is global** (`APP_GUARD`) and denies by default. `@Public()` marks the few open routes: health checks and payment webhooks.
- **The principal** is `{ accountId, userId or keyId, role, scopes }`. The guard sets it, and `@Principal()` replaces `@User()`.
- **Choosing the account:**
  - an API key acts on its own account;
  - a user's token acts on the account named by the `X-FF-Account` header. Without the header, the user's only account is used. A user with several accounts and no header gets 400, and one who names an account they don't belong to gets 404;
  - `GET /me` lists the user's accounts and roles, so the console and the CLI can choose. An API key reads it too, whatever its scopes: the key itself and its own account, with its creator's role (added on 2026-10-21 with the [CLI plan](../cli-plan.md)'s C-02, for `ff whoami`).
- **Services take the account ID, and every query includes it** (`where: { id, accountId }`). Controllers never load a resource by its ID alone.
- **Another account's resource answers 404,** exactly like one that doesn't exist, so an ID reveals nothing.
- **Roles:**

  | Role | Functions and invocations | Logs, metrics, usage | Keys, members, billing, account |
  |---|---|---|---|
  | `owner` | read and write | read | manage |
  | `developer` | read and write | read | none |
  | `viewer` | read | read | none |

  A route the role doesn't allow answers 403.
- **Error messages:** a function's own error goes back to the caller as it does today. A platform failure answers with a generic message and the request ID. The details, such as namespace names and Kubernetes errors, go only to the server log.

### 5. Plans, quotas and rate limits (D5)
- **A plan holds the account's limits:**
  - the number of functions, and each function's memory and timeout;
  - concurrent instances, and the tenant's pod, CPU and memory quota;
  - API and invoke request rates;
  - log and history retention;
  - the idle time before scale to zero;
  - whether functions may reach the internet.

  Prices and the free tier are not in the plan. They are in the price book (client-readiness plan, D8).
- **Plans are data,** edited in the admin dashboard. The first plan, `beta`, has today's limits.
- **The tenant's ResourceQuota comes from its plan.** The backend writes it into the namespace, and rewrites it when the plan changes.
- **Rate limits** are counted per account, and per IP address before login. They are kept in memory while the backend runs one replica, and move to Valkey before a second replica (parent R-06). Over the limit, the answer is `429 TooManyRequestsException` with `Retry-After`, Lambda's error name.
- **Internet egress is off by default.** An operator turns it on for one account, with a reason. The tenant's NetworkPolicy follows the account's flag.

### 6. Operators use a separate app and client (D12)
- **The admin dashboard** is a separate web app with its own hostname, reachable only from the operators' IP addresses or VPN.
- **Login:** the Keycloak client `ff-admin` and the realm role `ff-operator`. Keycloak requires a one-time-password second factor for that role.
- **The backend's `OperatorGuard`** protects every `/admin` route. It requires the `ff-operator` role **and** a token issued to `ff-admin` (the `azp` claim), so a console token can't call admin routes, even an operator's. API keys never reach admin routes.
- **Every admin write needs a reason** and is written to the audit log with the operator's identity. Viewing a customer's code, invocation data or logs needs a reason too, and is recorded in the customer's own audit log.
- **No impersonation.** Operators see accounts read-only, and act only through explicit admin actions.

## Alternatives considered

| Option | Outcome |
|---|---|
| The tenant is a user (today's model) | Rejected. The pilot customers are teams, and changing the tenancy key later means moving every namespace |
| Projects inside accounts | Deferred. The data model leaves room for them (parent §4.8) |
| A foreign identity service (Auth0, Cognito, Entra ID) | Rejected. It is paid in foreign currency and moves personal data abroad (parent §4.8, §9.2). Keycloak can federate with these later, if a customer requires it |
| FF's own login, with passwords in FF's database | Rejected. FF would have to build and secure password storage, resets, e-mail verification, second factors and lockouts |
| API keys as signed JWTs | Rejected. They can't be revoked without a deny list, and they are long. Opaque keys are revocable, short, and recognizable by their prefix |
| A slow password hash (bcrypt, Argon2) for API keys | Not needed. A secret of 256 random bits can't be guessed, and a slow hash would cost CPU on every request |
| PostgreSQL row-level security as the tenancy check | Deferred. It needs a per-request database setting (`SET LOCAL` inside a transaction around every query), which TypeORM doesn't provide. Scoped queries and the cross-account test suite (L5) come first; row-level security can be added later as a second layer |
| 403 for another account's resource | Rejected. It confirms that the ID exists. 404 is the same answer as for an unknown ID |
| The account in the URL (`/accounts/:id/functions`) | Rejected. Every route and client would change, while a header leaves the API's paths as they are, and API keys need neither |

## Consequences

**Positive:**
- **Isolation by default.** A new route without an explicit decision is closed, and every query names the account.
- **No passwords or sessions in FF.** E-mail verification, second factors and lockouts come from Keycloak.
- **One principal** for the console, the CLI and API keys, with scopes that narrow what a key can do.
- **Plans are data,** so limits change without a deploy.

**Negative:**
- **Keycloak is one more service** to run, upgrade and back up, with its own database. Mitigated by one realm kept as configuration in git, a pinned version, and the same backups as FF's database.
- **End-to-end tests need Keycloak** in docker-compose. Unit tests and everyday development use `FF_AUTH_MODE=dev`.
- **Development data is reset once** (§1).
- **Rate limits and caches live in one process** until Valkey arrives, so the backend stays at one replica (parent R-06).

**Follow-ups:**
- Projects, SSO federation, and the Admin and Billing roles (parent §4.8).
- SigV4 access keys for AWS tools (parent §4.8, §6.6).
- Row-level security as a second layer.
- Phone verification and abuse controls (parent B-10) replace manual approval at the public launch.

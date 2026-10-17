# FF console

The web console for FF. Users log in or sign up through Keycloak, create their account, and wait for its approval. Then they list, create, edit and invoke functions, change their instance limits, and view their metrics. Owners rename the account, set its tax ID, and manage its API keys. It is a React app built with Vite, and it uses Redux Toolkit, MUI, Tailwind, and `react-oidc-context`.

```bash
npm install
npm run dev        # http://localhost:5199, always: the login and the API's CORS_ORIGIN name this port
npm run build      # type-check, then a production build in dist/
npm test           # unit tests (Vitest)
npm run lint
```

Start the backend first: see [Getting started](../docs/getting-started.md).

## Settings

Vite reads them when it starts or builds, from the environment or from `.env.local` (not committed). `.env.example` lists them:

| Variable | Default | What it does |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | The API's address. |
| `VITE_OIDC_AUTHORITY` | empty | The realm to log in with, e.g. `http://localhost:8180/realms/ff`. Empty is development mode: no login, and the API must run with `FF_AUTH_MODE=dev`. |
| `VITE_OIDC_CLIENT_ID` | `ff-console` | The console's client in that realm. |

They are built into the bundle, so a production build needs its own values. The realm's `ff-console` client must allow the console's address as a redirect URI, a post-logout redirect URI and a web origin, and the API's `CORS_ORIGIN` must include it. `src/contract.test.ts` checks both for the development stack.

## How it works

- **Login** (`src/App.tsx`, `src/auth/oidc.ts`): the authorization code flow with PKCE, through `oidc-client-ts`. "Sign up" opens Keycloak's registration form (`prompt=create`). Tokens stay in the tab's session storage. The access token is renewed with the refresh token before it expires, and a request about to go out with an expiring token waits for one renewal. When the API answers 401, the session is over: the console forgets the user and shows the login page with the API's reason. "Log out" ends the Keycloak session too, and comes back through `/logged-out`.
- **The account it acts for** (`src/session/Console.tsx`, `src/lib/session.ts`): `GET /me` lists the user's accounts. The console acts for the one chosen last in this browser, else the first active one, and names it in `X-FF-Account` on every request. Switching accounts reloads the page, so nothing of the other account survives.
- **What it shows:** no account yet, the onboarding form; a pending account, the "waiting for approval" page, with "Check again"; a rejected one, why; a suspended or closed one, its functions with a banner saying what still works. Account settings and API keys are under "Account" and "API keys".
- **API keys** (`src/components/ApiKeys.tsx`): owners create a key with a name, scopes and an expiry, see it once, and revoke it. The list shows each key by its prefix, `ffk_<id>_…`.

`dependencies` lists exactly what ships in the bundle, so `npm audit --omit=dev` audits what users get; the build and test tools are `devDependencies`.

Known gaps, each with its task in the [client-readiness plan](../docs/client-readiness-plan.md):
- the metrics page reads an API that P-50 replaces, and has the two lint errors left;
- two UI kits (MUI and Tailwind) are used side by side;
- members and invitations come with P-16; until then each account has its owner only.

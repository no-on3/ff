# FF admin dashboard

The web app for FF's operators (client-readiness plan, D12): approvals, accounts, prices, payments and the operator audit log, as their tasks land (P-70 to P-76). It is a separate app from the customer console, so it never ships in the console's bundle, and in production it has its own hostname that only your addresses reach. It is a React app built with Vite and Tailwind, like the console, and logs in with `react-oidc-context`.

```bash
npm install
npm run dev        # http://localhost:5198, always: the realm's ff-admin client and the API's CORS_ORIGIN name this port
npm run build      # type-check, then a production build in dist/
npm test           # unit tests (Vitest)
npm run lint
```

It needs the backend in OIDC mode and Keycloak: see "The admin dashboard" in [Getting started](../docs/getting-started.md). There is no development mode: the admin routes refuse it.

## Settings

Vite reads them when it starts or builds, from the environment or from `.env.local` (not committed). `.env.example` lists them:

| Variable | Default | What it does |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | The API's address. |
| `VITE_OIDC_AUTHORITY` | none: required | The realm operators log in with, e.g. `http://localhost:8180/realms/ff`. |
| `VITE_OIDC_CLIENT_ID` | `ff-admin` | The dashboard's client in that realm. The backend's admin routes take only its tokens. |

## How it works

- **Login** (`src/App.tsx`, `src/auth/oidc.ts`): the authorization code flow with PKCE, through the client `ff-admin`. Keycloak asks users with the realm role `ff-operator` for a one-time password; an operator sets one up at their first login. Tokens stay in the tab's session storage, and the access token is renewed before it expires.
- **The backend** (`BE/src/admin/`): every route under `/admin` takes only an operator's token issued to `ff-admin`: a customer's token, an operator's console token, an API key or development mode is refused. Every change carries a `reason`, which the audit log keeps with the operator's name.
- **What it shows:**
  - **Settings** (P-70): billing and platform values, each change confirmed with a reason, from → to.
  - Accounts and approvals (P-71) and the operator audit log (P-76) come next.
- **Shared pieces** (`src/components/`): the reason dialog every change goes through, a table with filters, search and pages (`DataTable`, `src/lib/table.ts`), and the loading, error and empty states.

`src/contract.test.ts` checks what the app shares with the realm and the backend: the client and its addresses, the role and its one-time password, the port, the settings' names and the reason's length.

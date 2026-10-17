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
  - **Approvals** (P-71), where it opens: the accounts waiting for approval, newest first, with their owners and what they plan to build. The new-account e-mail links here (`/accounts?status=pending`).
  - **Accounts** (P-71): every account, searched by ID, name or a member's e-mail, and filtered by status and plan. An account's page has what sign-up collected, its owners and members, its functions with their last call, this month's usage (UTC), its balance (P-31: each wallet's, in its currency to the minor unit; below zero, usage the credit didn't cover), its last payments (P-35) and invoices (P-36), its status history and its whole audit log. Its buttons follow its status: approve or reject a pending account, suspend an active one, reactivate a suspended one, close any but a closed one. It also changes the plan and internet egress. Each change's dialog says what it does and what the owners learn: each gets an e-mail, and their audit log shows the change as FF's, with your reason.
  - **Payments** (P-35): the pro-formas owners asked for, newest first, filtered by the reference on the bank statement (in any case, with or without dashes), by status and by account. "Record the transfer" takes what arrived, what was withheld at source, the statement's date and the bank's reference; its dialog says what the wallet gets before you confirm, or why the API would refuse it (`src/lib/payments.ts`). "Add the certificate" uploads the withholding certificate, a PDF, a PNG or a JPEG of 5 MB at most, as the request's body, with the reason in the `X-FF-Reason` header; it credits the withheld share. "Certificate" downloads it again. An account's page lists its last payments.
  - **Invoices** (P-36): a month's drafts, last month's by default (or the month in the address, as the operator e-mails link to it): each account's payments not invoiced yet, with the VAT, the stamp duty and the total. Once the month is over in Tunisia, "Issue all" or "Issue", with a reason, numbers and writes them; the notice names the numbers, and any account not issued, and why (`src/lib/invoices.ts`). Below, every issued invoice and credit note, filtered by account, kind and month, with its PDF; "Credit note" corrects an invoice, its lines before tax at the invoice's VAT rate. An account's page lists its last invoices.
  - **Prices** (P-73): FF's price books, past, active and scheduled, each one's prices in TND, and in US$ where they come from AWS's. A new book starts from the active one, at AWS's US$ prices times a rate (each TND price their exact product, as the API checks) or at TND prices as set, with the free tier and D8's knobs. It starts at a whole hour, UTC, from the next one on. "Try it on last month" prices last month with it, per account, next to the books valid then and what the hourly rating charged (P-32; in shadow mode, rated and not debited; "–" before the month was rated); nothing is saved. A scheduled book can be removed; one that has started never changes.
  - **Plans** (P-73): every plan's limits (D5). Editing one lists each change, from → to, in the reason dialog; it applies at once, and a new quota goes to every account on the plan. "New plan from it" starts a plan from another's limits; accounts are moved to it from their page.
  - **Audit log** (P-76): what operators did, newest first: when (in UTC, like the filters and the CSV), who, the action, the account, what changed (a setting by its name, from → to, as the Settings page's dialog says it) and the reason. Filter by part of an operator's e-mail, account, action, and a range of UTC days (both included). "Download as CSV" saves the newest 10,000 entries that match, with the same filters; when more matched, the page says so, and narrower filters give the rest.
  - **Settings** (P-70): billing and platform values, each change confirmed with a reason, from → to. Turning shadow billing off starts the hourly debits from the next hour rated (P-32); `npm run billing:reconcile` in `BE/` says whether the charges agree with the usage first.
- **Shared pieces** (`src/components/`): the reason dialog every change goes through, a table with filters, search and pages (`DataTable`, `src/lib/table.ts`), and the loading, error and empty states.

`src/contract.test.ts` checks what the app shares with the realm and the backend: the client and its addresses, the role and its one-time password, the port, the settings' names, the reason's length, the account statuses and which change applies to which (`src/lib/accounts.ts`, from `BE/src/admin/account-status-changes.ts`), the plans' limits and the price books' SKUs, the first book's TND prices as its US$ prices times its rate, the payments' fields and statuses, the certificate's types and size and the reason's header (P-35), the invoices' fields and kinds (P-36), and the actions the audit log page names (`OPERATOR_ACTIONS` in `src/lib/audit.ts`: each task that adds an operator action adds it there too).

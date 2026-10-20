import { UserManager } from 'oidc-client-ts';
import { useEffect } from 'react';
import { AuthProvider, hasAuthParams, useAuth } from 'react-oidc-context';
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { setApiAuth } from './api';
import { LOGGED_OUT_PATH, oidcApiAuth, oidcSettings } from './auth/oidc';
import Layout from './components/Layout';
import LoginPage from './components/LoginPage';
import { ErrorState } from './components/States';
import { config } from './config';
import Account from './pages/Account';
import Accounts from './pages/Accounts';
import AuditLog from './pages/AuditLog';
import Invoices from './pages/Invoices';
import Overview from './pages/Overview';
import Payments from './pages/Payments';
import Plans from './pages/Plans';
import FunctionPage from './pages/FunctionPage';
import Prices from './pages/Prices';
import Search from './pages/Search';
import Settings from './pages/Settings';

// One login per page load, set up before the first request.
const userManager = 'oidc' in config ? new UserManager(oidcSettings(config.oidc, window.location.origin)) : null;
let refusal: string | null = null;
if (userManager) {
  setApiAuth(
    oidcApiAuth(userManager, (message) => {
      refusal = `The API refused your session (${message}): log in again.`;
      void userManager.removeUser(); // shows the login page
    }),
  );
}

/** The approvals queue, or every account: a new status in the address starts the list over. */
function AccountsRoute({ email }: { email: string | undefined }) {
  const [params] = useSearchParams();
  const status = params.get('status') ?? '';
  return <Accounts key={status} email={email} status={status} />;
}

/** The payments, filtered as the address says, as the account page links to them (P-35): new filters start the page over. */
function PaymentsRoute({ email }: { email: string | undefined }) {
  const [params] = useSearchParams();
  const initial = Object.fromEntries(['reference', 'status', 'accountId'].map((name) => [name, params.get(name) ?? '']));
  return <Payments key={params.toString()} email={email} initial={initial} />;
}

/** The invoices, for the month or account the address names, as the operator's e-mails and the account page link to them (P-36). */
function InvoicesRoute({ email }: { email: string | undefined }) {
  const [params] = useSearchParams();
  const initial = Object.fromEntries(['month', 'accountId', 'kind'].map((name) => [name, params.get(name) ?? '']));
  return <Invoices key={params.toString()} email={email} initial={initial} />;
}

/** The login page until the operator is logged in, then the dashboard, which opens on the approvals queue (P-71). */
function LoginGate() {
  const auth = useAuth();
  const failed = !auth.isLoading && !auth.isAuthenticated && auth.error !== undefined;

  useEffect(() => {
    // A code that was used already or refused: drop it, so a reload doesn't try it again.
    if (failed && hasAuthParams()) window.history.replaceState(null, '', '/');
  }, [failed]);

  if (auth.isLoading) return <div className="flex min-h-screen items-center justify-center text-gray-500">Loading…</div>;
  if (!auth.isAuthenticated) {
    const notice = refusal ?? (auth.error ? `The login didn't finish: ${auth.error.message}` : null);
    return (
      <LoginPage
        notice={notice}
        onLogIn={() => {
          refusal = null;
          void auth.signinRedirect();
        }}
      />
    );
  }
  const email = auth.user?.profile.email;
  return (
    <BrowserRouter>
      <Layout email={email} onLogOut={() => void auth.signoutRedirect()}>
        <Routes>
          <Route path="/overview" element={<Overview email={email} />} />
          <Route path="/accounts" element={<AccountsRoute email={email} />} />
          <Route path="/accounts/:id" element={<Account email={email} />} />
          <Route path="/payments" element={<PaymentsRoute email={email} />} />
          <Route path="/invoices" element={<InvoicesRoute email={email} />} />
          <Route path="/prices" element={<Prices email={email} />} />
          <Route path="/plans" element={<Plans email={email} />} />
          <Route path="/settings" element={<Settings email={email} />} />
          <Route path="/search" element={<Search email={email} />} />
          <Route path="/functions/:id" element={<FunctionPage email={email} />} />
          <Route path="/audit-log" element={<AuditLog email={email} />} />
          <Route path="*" element={<Navigate to="/accounts?status=pending" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

function App() {
  if (!userManager) return <div className="p-8">{'problem' in config && <ErrorState message={config.problem} />}</div>;
  return (
    <AuthProvider
      userManager={userManager}
      onSigninCallback={() => window.history.replaceState(null, '', '/')}
      matchSignoutCallback={() => window.location.pathname === LOGGED_OUT_PATH}
      onSignoutCallback={() => window.history.replaceState(null, '', '/')}
    >
      <LoginGate />
    </AuthProvider>
  );
}

export default App;

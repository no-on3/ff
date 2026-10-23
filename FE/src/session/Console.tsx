import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AccountRejected from '../components/AccountRejected';
import AccountSettings from '../components/AccountSettings';
import ApiKeys from '../components/ApiKeys';
import BalanceProvider from '../components/BalanceProvider';
import Billing from '../components/Billing';
import CreateFunction from '../components/CreateFunction';
import CreditBanner from '../components/CreditBanner';
import DatabaseDetail from '../components/DatabaseDetail';
import Databases from '../components/Databases';
import FunctionDetail from '../components/FunctionDetail';
import FunctionList from '../components/FunctionList';
import Members from '../components/Members';
import Notifications from '../components/Notifications';
import Alarms from '../components/Alarms';
import Onboarding from '../components/Onboarding';
import PendingApproval from '../components/PendingApproval';
import ProFormaPage from '../components/ProForma';
import Shell from '../components/Shell';
import Usage from '../components/Usage';
import { config } from '../config';
import { accountView, chooseAccount, loadErrorMessage, rememberAccount, rememberedAccount } from '../lib/session';
import { Me, MeAccount, accountsApi, setApiAccount } from '../services/api';
import { Login, Session, SessionContext } from './session';

type Loaded = { me: Me; account: MeAccount | null };

/** The account's own home and pages; until it is active, the page that says why it can't deploy. */
const AccountRoutes: React.FC<{ account: MeAccount | null }> = ({ account }) => {
  const { page, banner } = accountView(account);
  const home = page === 'onboarding' ? <Onboarding /> : page === 'pending' ? <PendingApproval /> : <AccountRejected />;
  return (
    <>
      {banner && (
        <div role="status" className="bg-amber-50 border-b border-amber-200 text-amber-900 print:hidden">
          <div className="px-6 py-2.5 lg:px-9">{banner}</div>
        </div>
      )}
      <CreditBanner />
      <main>
        <Routes>
          <Route path="/accounts/new" element={<Onboarding />} />
          <Route path="/account" element={account ? <AccountSettings /> : <Navigate to="/" replace />} />
          <Route path="/account/api-keys" element={account ? <ApiKeys /> : <Navigate to="/" replace />} />
          <Route path="/account/members" element={account ? <Members /> : <Navigate to="/" replace />} />
          <Route path="/account/notifications" element={account ? <Notifications /> : <Navigate to="/" replace />} />
          <Route path="/alarms" element={account ? <Alarms /> : <Navigate to="/" replace />} />
          {page === 'console' ? (
            <>
              <Route path="/" element={<FunctionList />} />
              <Route path="/functions" element={<FunctionList />} />
              <Route path="/functions/new" element={<CreateFunction />} />
              <Route path="/functions/:id" element={<FunctionDetail />} />
              <Route path="/databases" element={<Databases />} />
              <Route path="/databases/:id" element={<DatabaseDetail />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/billing/pro-formas/:id" element={<ProFormaPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          ) : (
            <Route path="*" element={home} />
          )}
        </Routes>
      </main>
    </>
  );
};

/**
 * The console once the user is known (or in development mode): it reads
 * GET /me, chooses the account to act for, and shows that account's pages.
 */
const Console: React.FC<{ login: Login | null }> = ({ login }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const me = (await accountsApi.me()).data;
    const account = chooseAccount(me.accounts, rememberedAccount());
    setApiAccount(account?.id);
    if (account) rememberAccount(account.id);
    setLoaded({ me, account });
  }, []);

  useEffect(() => {
    reload().catch((error) =>
      setFailure(loadErrorMessage(error, { loginConfigured: config.oidc !== null, apiUrl: config.apiUrl, origin: window.location.origin })),
    );
  }, [reload]);

  const session = useMemo<Session | null>(
    () =>
      loaded && {
        ...loaded,
        login,
        reload,
        switchAccount: (id: string) => {
          rememberAccount(id);
          // A fresh start for the other account: no page, list or request of the first one survives.
          window.location.assign('/');
        },
      },
    [loaded, login, reload],
  );

  if (failure) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div role="alert" className="card max-w-xl">
          <h1 className="text-xl font-bold mb-2">The console can't start</h1>
          <p className="mb-4">{failure}</p>
          <div className="flex gap-3">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Try again
            </button>
            {login && (
              <button type="button" className="btn btn-secondary" onClick={login.logOut}>
                Log out
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (!session) return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading…</div>;

  return (
    <SessionContext.Provider value={session}>
      <BrowserRouter>
        <BalanceProvider>
          <Shell>
            <AccountRoutes account={session.account} />
          </Shell>
        </BalanceProvider>
      </BrowserRouter>
    </SessionContext.Provider>
  );
};

export default Console;

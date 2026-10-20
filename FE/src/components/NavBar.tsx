import React from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { AccountStatus } from '../services/api';
import { useSession } from '../session/session';
import BalanceBadge from './BalanceBadge';

const STATUS_NOTE: Record<AccountStatus, string> = {
  pending: ' (waiting for approval)',
  active: '',
  rejected: ' (not approved)',
  suspended: ' (suspended)',
  closed: ' (closed)',
};

const NEW_ACCOUNT = 'new';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `py-1 border-b-2 ${isActive ? 'border-blue-600 text-gray-900' : 'border-transparent text-gray-600 hover:text-gray-900'}`;

/** The console's header: its pages, the account's balance (P-32), the account switcher, and who is logged in. */
const NavBar: React.FC = () => {
  const { me, account, login, switchAccount } = useSession();
  const navigate = useNavigate();

  const onAccountChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (event.target.value === NEW_ACCOUNT) navigate('/accounts/new');
    else switchAccount(event.target.value);
  };

  return (
    <nav className="bg-white shadow-sm print:hidden">
      <div className="container mx-auto px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-3">
        <Link to="/" className="text-xl font-bold text-gray-800">
          FF console
        </Link>
        {account && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <NavLink to="/functions" className={linkClass}>
              Functions
            </NavLink>
            <NavLink to="/alarms" className={linkClass}>
              Alarms
            </NavLink>
            <NavLink to="/usage" className={linkClass}>
              Usage
            </NavLink>
            <NavLink to="/billing" className={linkClass}>
              Billing
            </NavLink>
            <NavLink to="/account" end className={linkClass}>
              Account
            </NavLink>
            <NavLink to="/account/notifications" className={linkClass}>
              Notifications
            </NavLink>
            {account.role === 'owner' && (
              <>
                <NavLink to="/account/members" className={linkClass}>
                  Members
                </NavLink>
                <NavLink to="/account/api-keys" className={linkClass}>
                  API keys
                </NavLink>
              </>
            )}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
          {account && <BalanceBadge />}
          {me.accounts.length > 0 && (
            <label className="flex items-center gap-2">
              <span className="text-gray-500">Account</span>
              <select
                aria-label="Account"
                value={account?.id ?? ''}
                onChange={onAccountChange}
                className="rounded-md border border-gray-300 bg-white px-2 py-1"
              >
                {me.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {STATUS_NOTE[a.status]}
                  </option>
                ))}
                {login && <option value={NEW_ACCOUNT}>New account…</option>}
              </select>
            </label>
          )}
          {login ? (
            <>
              <span className="text-gray-600">{login.email}</span>
              <button type="button" className="btn btn-secondary" onClick={login.logOut}>
                Log out
              </button>
            </>
          ) : (
            <span
              className="rounded bg-amber-100 px-2 py-1 text-amber-900"
              title="The console has no login (VITE_OIDC_AUTHORITY is empty), and the API acts as its development account"
            >
              Development mode
            </span>
          )}
        </div>
      </div>
    </nav>
  );
};

export default NavBar;

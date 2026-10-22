import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { firingCount } from '../lib/alarms';
import { balanceLabel, trialNote } from '../lib/billing';
import { consoleNav, isOpen } from '../lib/navigation';
import { can } from '../lib/session';
import { alarmsApi, type AccountStatus, type Role } from '../services/api';
import { useBalance } from '../session/balance';
import { useSession } from '../session/session';
import Icon from './Icon';

const STATUS_NOTE: Record<AccountStatus, string> = {
  pending: ' (waiting for approval)',
  active: '',
  rejected: ' (not approved)',
  suspended: ' (suspended)',
  closed: ' (closed)',
};

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', developer: 'Developer', viewer: 'Viewer' };

const NEW_ACCOUNT = 'new';

/** FF's mark and name: the way home. */
const Brand: React.FC = () => (
  <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-[-0.01em] text-ink hover:text-ink">
    <span className="grid size-[26px] place-items-center rounded-md bg-ink text-[13px] leading-none font-bold tracking-[-0.04em] text-white" aria-hidden="true">
      ff
    </span>
    <span>
      FF <span className="font-medium text-gray-500">console</span>
    </span>
  </Link>
);

/** The account the console acts for, and the others the user may switch to or create. */
const AccountSwitcher: React.FC = () => {
  const { me, account, login, switchAccount } = useSession();
  const navigate = useNavigate();

  const onChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (event.target.value === NEW_ACCOUNT) navigate('/accounts/new');
    else switchAccount(event.target.value);
  };

  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 shadow-sm focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
      <div className="relative">
        <select
          aria-label="Account"
          value={account?.id ?? ''}
          onChange={onChange}
          className="w-full appearance-none truncate bg-transparent pr-6 text-[13px] font-semibold text-ink focus:outline-none"
        >
          {me.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {STATUS_NOTE[a.status]}
            </option>
          ))}
          {login && <option value={NEW_ACCOUNT}>New account…</option>}
        </select>
        <Icon name="chevron" className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-gray-500" />
      </div>
      {account && (
        <div className="mt-0.5 truncate text-xs text-gray-500">
          {ROLE_LABEL[account.role]} · <span className="font-mono">{account.id}</span>
        </div>
      )}
    </div>
  );
};

/** The account's balance (P-32), as the balance context reads it at each page; during the billing trial (D9), a tag says so. */
const BalanceCard: React.FC<{ role: Role }> = ({ role }) => {
  const { balance } = useBalance();
  if (!balance) return null;
  const note = trialNote(balance);
  const negative = balance.balance.startsWith('-');
  return (
    <section aria-label="Balance" className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between text-xs font-medium text-gray-500">
        <span>Balance</span>
        {note && (
          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-800" title={note}>
            Billing trial
          </span>
        )}
      </div>
      <div className={`mt-0.5 text-lg leading-[26px] font-semibold tracking-[-0.01em] tabular-nums ${negative ? 'text-red-700' : 'text-ink'}`}>
        {balanceLabel(balance)}
      </div>
      <Link to="/billing" className="text-xs">
        {can(role, 'manage the account') ? 'Add credit' : 'See billing'}
      </Link>
    </section>
  );
};

/** The sidebar's content: on wide screens beside the pages, on narrow ones in the menu. */
const Sidebar: React.FC<{ firing: number; onClose?: () => void }> = ({ firing, onClose }) => {
  const { me, account, login } = useSession();
  const { pathname } = useLocation();
  const closeButton = useRef<HTMLButtonElement>(null);

  // In the menu, the keyboard starts on its close button.
  useEffect(() => {
    if (onClose) closeButton.current?.focus();
  }, [onClose]);

  return (
    <div className="flex min-h-full flex-col gap-5 px-3.5 py-4">
      <div className="flex items-center justify-between px-1.5">
        <Brand />
        {onClose && (
          <button ref={closeButton} type="button" aria-label="Close the menu" onClick={onClose} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      {me.accounts.length > 0 && <AccountSwitcher />}
      {account && (
        <nav aria-label="Pages" className="flex flex-col gap-0.5">
          {consoleNav(account.role).map((group) => (
            <React.Fragment key={group.label ?? 'pages'}>
              {group.label && <div className="mt-4 mb-1 px-2.5 text-xs font-medium text-gray-500">{group.label}</div>}
              {group.items.map((item) => {
                const open = isOpen(item, pathname);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={open ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-[7px] font-medium ${
                      open ? 'bg-white text-ink shadow-sm hover:text-ink' : 'text-gray-800 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <Icon name={item.icon} className={open ? 'text-blue-600' : 'text-gray-500'} />
                    <span>{item.label}</span>
                    {item.icon === 'alarms' && firing > 0 && (
                      <span className="ml-auto min-w-[18px] rounded-full bg-attention px-1.5 text-center text-[11px] leading-[18px] font-semibold text-white">
                        {firing}
                        <span className="sr-only"> in alarm</span>
                      </span>
                    )}
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="mt-auto flex flex-col gap-2.5">
        {account && <BalanceCard role={account.role} />}
        {login ? (
          <div className="flex items-center justify-between gap-2 px-1.5 text-xs text-gray-500">
            <span className="truncate" title={login.email}>
              {login.email ?? 'Logged in'}
            </span>
            <button type="button" onClick={login.logOut} className="shrink-0 font-medium text-gray-600 hover:text-ink">
              Log out
            </button>
          </div>
        ) : (
          <span
            className="mx-1.5 self-start rounded bg-amber-100 px-2 py-1 text-xs text-amber-900"
            title="The console has no login (VITE_OIDC_AUTHORITY is empty), and the API acts as its development account"
          >
            Development mode
          </span>
        )}
      </div>
    </div>
  );
};

/** How many of the account's alarms are in alarm, read again at each page: none for an account that isn't active, or when it can't be read. */
function useFiringAlarms(active: boolean): number {
  const [firing, setFiring] = useState(0);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!active) return;
    let current = true;
    alarmsApi
      .list()
      .then(({ data }) => current && setFiring(firingCount(data)))
      .catch(() => current && setFiring(0));
    return () => {
      current = false;
    };
  }, [active, pathname]);
  return active ? firing : 0;
}

/**
 * The console's frame (W-02): the sidebar beside the pages from 1024 px, and below it a top bar whose menu opens the
 * same sidebar over the page. Neither prints.
 */
const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { account } = useSession();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const firing = useFiringAlarms(account?.status === 'active');

  // A page chosen in the menu closes it.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Closed by its button, a click beside it or Escape, the menu gives the keyboard back to the button that opened it.
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, closeMenu]);

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[248px_minmax(0,1fr)] print:block print:bg-white">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-white px-4 lg:hidden print:hidden">
        <Brand />
        <button
          ref={menuButton}
          type="button"
          aria-label="Open the menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
          className="rounded-md p-2 text-gray-700 hover:bg-gray-100"
        >
          <Icon name="menu" size={20} />
        </button>
      </header>
      <aside className="hidden lg:block print:hidden">
        <div className="sticky top-0 h-screen overflow-y-auto">
          <Sidebar firing={firing} />
        </div>
      </aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/30" onClick={closeMenu} />
          <div className="absolute inset-y-0 left-0 w-[272px] max-w-[85vw] overflow-y-auto bg-canvas shadow-raised">
            <Sidebar firing={firing} onClose={closeMenu} />
          </div>
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
};

export default Shell;

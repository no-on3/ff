import React from 'react';
import { NavLink } from 'react-router-dom';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `py-1 border-b-2 ${isActive ? 'border-white text-white' : 'border-transparent text-slate-300 hover:text-white'}`;

/** The dashboard's frame: its pages, and who is logged in. Dark, so it is never mistaken for the console. */
const Layout: React.FC<{ email: string | undefined; onLogOut: () => void; children: React.ReactNode }> = ({ email, onLogOut, children }) => (
  <>
    <nav className="bg-slate-800 text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
        <span className="text-xl font-bold">FF admin</span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <NavLink to="/audit-log" className={linkClass}>
            Audit log
          </NavLink>
          <NavLink to="/settings" className={linkClass}>
            Settings
          </NavLink>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-300">{email}</span>
          <button type="button" className="btn btn-secondary" onClick={onLogOut}>
            Log out
          </button>
        </div>
      </div>
    </nav>
    <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
  </>
);

export default Layout;

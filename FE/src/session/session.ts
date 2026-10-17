import { createContext, useContext } from 'react';
import type { Me, MeAccount } from '../services/api';

/** The logged-in user's side of the console; absent in development mode. */
export interface Login {
  email?: string;
  logOut(): void;
}

/** What every page knows about who is using the console, and for which account. */
export interface Session {
  me: Me;
  /** The account the console acts for (X-FF-Account); null until the user creates one. */
  account: MeAccount | null;
  login: Login | null;
  /** Reads GET /me again, e.g. to see whether an account was approved. */
  reload(): Promise<void>;
  /** Acts for another of the user's accounts, starting again from its home page. */
  switchAccount(id: string): void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession() needs a <SessionContext.Provider>');
  return session;
}

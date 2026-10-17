import { createContext, useContext } from 'react';
import type { Balance } from '../services/api';

export interface BalanceState {
  /** The account's balance, null until read, or when it can't be. */
  balance: Balance | null;
  /** Reads it again, as after a change on the Billing page. */
  refresh: () => void;
}

export const BalanceContext = createContext<BalanceState>({ balance: null, refresh: () => undefined });

/** The account's balance (P-32, P-33), for the header and the banner: BalanceProvider reads it at each page and account change. */
export const useBalance = (): BalanceState => useContext(BalanceContext);

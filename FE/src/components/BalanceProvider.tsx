import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Balance, billingApi } from '../services/api';
import { BalanceContext } from '../session/balance';
import { useSession } from '../session/session';

/** Reads the account's balance at each page and account change, for every page's header and banner (P-32, P-33). */
const BalanceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { account } = useSession();
  const { pathname } = useLocation();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [reads, setReads] = useState(0);
  const accountId = account?.id;

  useEffect(() => {
    if (!accountId) return;
    let current = true;
    billingApi
      .getBalance()
      .then((res) => current && setBalance(res.data))
      .catch(() => current && setBalance(null)); // the header stays quiet; a page says what failed
    return () => {
      current = false;
    };
  }, [accountId, pathname, reads]);

  const value = useMemo(() => ({ balance: accountId ? balance : null, refresh: () => setReads((count) => count + 1) }), [accountId, balance]);
  return <BalanceContext.Provider value={value}>{children}</BalanceContext.Provider>;
};

export default BalanceProvider;

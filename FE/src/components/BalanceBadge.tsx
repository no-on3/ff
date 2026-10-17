import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { balanceLabel, trialNote } from '../lib/billing';
import { Balance, billingApi } from '../services/api';
import { useSession } from '../session/session';

/**
 * The account's balance, on every page (P-32): read again at each page and
 * account change, as usage is charged every hour. During the billing trial
 * (D9) a badge says so; its title gives what was rated this month.
 */
const BalanceBadge: React.FC = () => {
  const { account } = useSession();
  const { pathname } = useLocation();
  const [balance, setBalance] = useState<Balance | null>(null);

  useEffect(() => {
    let current = true;
    billingApi
      .getBalance()
      .then((res) => current && setBalance(res.data))
      .catch(() => current && setBalance(null)); // the header stays quiet; the page says what failed
    return () => {
      current = false;
    };
  }, [account?.id, pathname]);

  if (!balance) return null;
  const note = trialNote(balance);
  const negative = balance.balance.startsWith('-');
  return (
    <span className="flex items-center gap-2" aria-label="Balance">
      <span className="text-gray-500">Balance</span>
      <span className={`font-semibold tabular-nums ${negative ? 'text-red-700' : 'text-gray-900'}`}>{balanceLabel(balance)}</span>
      {note && (
        <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-800" title={note}>
          Billing trial
        </span>
      )}
    </span>
  );
};

export default BalanceBadge;

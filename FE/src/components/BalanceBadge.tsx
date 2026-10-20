import React from 'react';
import { balanceLabel, trialNote } from '../lib/billing';
import { useBalance } from '../session/balance';

/**
 * The account's balance, on every page (P-32), as the balance context reads
 * it at each page. During the billing trial (D9) a badge says so; its title
 * gives what was rated this month.
 */
const BalanceBadge: React.FC = () => {
  const { balance } = useBalance();
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

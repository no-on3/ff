import React from 'react';
import { Link } from 'react-router-dom';
import { creditBanner } from '../lib/billing';
import { useBalance } from '../session/balance';

/** Above every page once the balance is below the buffer (P-33, D9): until when invokes go, or that they stopped. */
const CreditBanner: React.FC = () => {
  const { balance } = useBalance();
  const banner = balance && creditBanner(balance);
  if (!banner) return null;
  const colours = banner.tone === 'danger' ? 'bg-red-50 border-red-200 text-red-900' : 'bg-amber-50 border-amber-200 text-amber-900';
  return (
    <div role="alert" aria-label="Credit" className={`border-b print:hidden ${colours}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2.5 lg:px-9">
        <span>{banner.text}</span>
        <Link to="/billing" className="font-semibold underline">
          Add credit
        </Link>
      </div>
    </div>
  );
};

export default CreditBanner;

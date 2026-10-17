import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiErrorMessage } from '../lib/functions';
import { useSession } from '../session/session';

/**
 * The home page of an account waiting for approval: it can't deploy or invoke
 * yet (P-12). Its owners get an e-mail when an operator approves or rejects
 * it (P-71); "Check again" shows the functions once it is approved.
 */
const PendingApproval: React.FC = () => {
  const { me, account, reload } = useSession();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      await reload(); // once approved, the console shows the functions instead of this page
      setCheckedAt(new Date());
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <div className="card">
        <h1 className="text-2xl font-bold mb-4">Waiting for approval</h1>
        <p className="mb-3">
          Your account <strong>{account?.name}</strong> ({account?.id}) is waiting for approval. During the beta, we approve each
          new account by hand.{' '}
          {account?.role === 'owner' && me.user?.email ? (
            <>
              We'll e-mail you at <strong>{me.user.email}</strong> once it's approved, or if it isn't.
            </>
          ) : (
            "We'll e-mail its owners once it's approved, or if it isn't."
          )}
        </p>
        <p className="mb-6 text-gray-600">
          Until then, you can't deploy or invoke functions. You can already fill in the account's details and create API keys.
        </p>
        {error && (
          <div role="alert" className="mb-4 text-red-600">
            {error}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <Link to="/account" className="btn btn-secondary">
            Account settings
          </Link>
          <span className="text-sm text-gray-500">Last checked at {checkedAt.toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
};

export default PendingApproval;

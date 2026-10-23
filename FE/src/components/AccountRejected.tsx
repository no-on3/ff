import React from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session/session';

/** The home page of an account that was not approved. */
const AccountRejected: React.FC = () => {
  const { account } = useSession();
  return (
    <div className="page max-w-2xl">
      <div className="card">
        <h1 className="mb-4">Account not approved</h1>
        <p className="mb-6">
          Your account <strong>{account?.name}</strong> ({account?.id}) was not approved, so it can't deploy or invoke functions.
        </p>
        <Link to="/accounts/new" className="btn btn-secondary">
          Create another account
        </Link>
      </div>
    </div>
  );
};

export default AccountRejected;

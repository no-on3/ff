import React from 'react';

/** Before the operator logs in: Keycloak asks for the password, then a one-time password (D12). */
const LoginPage: React.FC<{ notice: string | null; onLogIn: () => void }> = ({ notice, onLogIn }) => (
  <div className="flex min-h-screen items-center justify-center bg-slate-800 p-4">
    <div className="card w-full max-w-md space-y-4 text-center">
      <h1 className="text-2xl font-bold">FF admin</h1>
      <p className="text-gray-600">For FF's operators. You log in with your password and a one-time password from your authenticator app.</p>
      {notice && (
        <p role="alert" className="rounded bg-amber-50 px-3 py-2 text-amber-900">
          {notice}
        </p>
      )}
      <button type="button" className="btn btn-primary w-full" onClick={onLogIn}>
        Log in
      </button>
    </div>
  </div>
);

export default LoginPage;

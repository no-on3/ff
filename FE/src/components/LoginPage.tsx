import React from 'react';

interface LoginPageProps {
  /** Why the user is here again: a failed login, or a session the API refused. */
  notice?: string | null;
  onLogIn(): void;
  onSignUp(): void;
}

/** What a visitor sees before logging in: log in, or sign up (Keycloak's registration form). */
const LoginPage: React.FC<LoginPageProps> = ({ notice, onLogIn, onSignUp }) => (
  <div className="min-h-screen flex items-center justify-center px-4">
    <div className="card w-full max-w-md">
      <h1 className="mb-2">FF console</h1>
      <p className="text-gray-600 mb-6">Log in to deploy, invoke and watch your functions.</p>
      {notice && (
        <div role="alert" className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
          {notice}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" onClick={onLogIn}>
          Log in
        </button>
        <button type="button" className="btn btn-secondary" onClick={onSignUp}>
          Sign up
        </button>
      </div>
      <p className="mt-6 text-sm text-gray-500">
        New here? Sign up with your e-mail address, then create your account. During the beta, we approve each account before
        it can deploy.
      </p>
    </div>
  </div>
);

export default LoginPage;

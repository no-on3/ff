import { UserManager } from 'oidc-client-ts';
import { useEffect, useMemo } from 'react';
import { AuthProvider, hasAuthParams, useAuth } from 'react-oidc-context';
import { Provider } from 'react-redux';
import { LOGGED_OUT_PATH, oidcApiAuth, oidcSettings } from './auth/oidc';
import LoginPage from './components/LoginPage';
import { config } from './config';
import { loginNotice, returnPath } from './lib/session';
import { setApiAuth } from './services/api';
import Console from './session/Console';
import type { Login } from './session/session';
import { store } from './store/store';

// One login per page load, set up before the first request (OIDC mode only).
const userManager = config.oidc ? new UserManager(oidcSettings(config.oidc, window.location.origin)) : null;
let refusal: string | null = null;
if (userManager) {
  setApiAuth(
    oidcApiAuth(userManager, (message) => {
      refusal = `The API refused your session (${message}): log in again.`;
      void userManager.removeUser(); // shows the login page
    }),
  );
}

/** Back to the page the user was on before logging in, without the code and state in the address. */
function afterLogin(user: { state?: unknown } | undefined): void {
  window.history.replaceState(null, '', returnPath(user?.state));
}

/** OIDC mode: the login page until the user is logged in, then the console. */
function LoginGate() {
  const auth = useAuth();
  const email = auth.user?.profile.email;
  const { signoutRedirect } = auth;
  const login = useMemo<Login>(() => ({ email, logOut: () => void signoutRedirect() }), [email, signoutRedirect]);
  const failed = !auth.isLoading && !auth.isAuthenticated && auth.error !== undefined;

  useEffect(() => {
    // A code that was used already or refused: drop it, so a reload doesn't try it again.
    if (failed && hasAuthParams()) window.history.replaceState(null, '', '/');
  }, [failed]);

  if (auth.isLoading) return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading…</div>;
  if (!auth.isAuthenticated) {
    const here = window.location.pathname === LOGGED_OUT_PATH || hasAuthParams() ? '/' : `${window.location.pathname}${window.location.search}`;
    return (
      <LoginPage
        notice={loginNotice(auth.error, refusal)}
        onLogIn={() => {
          refusal = null;
          void auth.signinRedirect({ state: { returnTo: here } });
        }}
        onSignUp={() => {
          refusal = null;
          void auth.signinRedirect({ prompt: 'create', state: { returnTo: '/' } });
        }}
      />
    );
  }
  return <Console login={login} />;
}

function App() {
  return (
    <Provider store={store}>
      {userManager ? (
        <AuthProvider
          userManager={userManager}
          onSigninCallback={afterLogin}
          matchSignoutCallback={() => window.location.pathname === LOGGED_OUT_PATH}
          onSignoutCallback={() => window.history.replaceState(null, '', '/')}
        >
          <LoginGate />
        </AuthProvider>
      ) : (
        <Console login={null} />
      )}
    </Provider>
  );
}

export default App;

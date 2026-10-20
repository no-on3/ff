/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's address; http://localhost:3000 by default. */
  readonly VITE_API_URL?: string;
  /** The OIDC issuer the console logs in with. Empty: development mode, without a login. */
  readonly VITE_OIDC_AUTHORITY?: string;
  /** The console's client in that realm; ff-console by default. */
  readonly VITE_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

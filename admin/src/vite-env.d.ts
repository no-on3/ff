/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's address; http://localhost:3000 by default. */
  readonly VITE_API_URL?: string;
  /** The OIDC issuer operators log in with: required. */
  readonly VITE_OIDC_AUTHORITY?: string;
  /** The dashboard's client in that realm; ff-admin by default. */
  readonly VITE_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

# Device flow spike

How `ff login` will log a developer in: OAuth's device flow (RFC 8628) against the development realm's `ff-cli` client, in Keycloak. The [developer tools plan](../../../docs/dev-tools-plan.md)'s D1, its task list's M-01, part 2, for M-02 to build on.

```bash
hack/spikes/device-flow/run.sh      # about 3 minutes, Keycloak's start among them
```

It needs Rust (the toolchain `cli/` pins), Docker with Compose, Python 3, curl and jq. It starts a Keycloak of its own from `docker-compose.yml` (the image it pins, the realm `deploy/keycloak/ff-realm.json` imported), as the compose project `ff-device-flow-spike` on port 28180 (`FF_DEVICE_FLOW_PORT`), removed with its volume at the end: the developer's own Keycloak is never touched. The build, the tokens (in files, never printed) and the results go to `hack/.spikes/device-flow/` (`results.md`).

## What it does

- **The prototype** (`src/lib.rs`), with `ureq`, `serde`, `serde_json` and `base64`, which `ff` has already:
  - the issuer's endpoints, read from its discovery document;
  - a device code asked for, with the code the user types and the address where;
  - the token endpoint polled until the user approves or denies, or the code expires: at the interval the issuer gives, five seconds more after each `slow_down`, as RFC 8628 says;
  - a refresh, and a refresh token revoked (RFC 7009), as `ff logout` would;
  - a token's claims, read without checking its signature, for the report alone.

  Its tests (5) run against a stand-in issuer on a local port: the waits 5, 5, 10 and 10 s around a `slow_down`, then approved; a denial and an expiry ending the wait; a refused refresh's message; the revocation's form; 5 s when the issuer gives no interval.
- **The command** (`src/main.rs`), `start`, `poll`, `wait`, `refresh` and `revoke`, each printing one line of JSON that says what the issuer answered and what the tokens hold, never the tokens themselves.
- **The user's part** (`browser.py`): Python's standard library, as a browser: the address `ff` prints opened, the code given when the page asks for it, the login form filled, the device approved or denied. Two things a browser does that Python's `urllib` doesn't, both needed:
  - Keycloak's cookies are `Secure`, even over http. Browsers send them to `localhost` all the same, holding it a secure context, as `curl` does; Python's jar sends them over https alone, and the login stopped at a page answered 400, its session unknown.
  - Keycloak's `/device` takes both the device's request for a code and the user's code typed into its page, as a form posted to the same address. It tells them apart by what the client accepts: HTML is the user's, anything else a device's, refused without a client ID (401 `invalid_client`). So the page's form must be posted asking for HTML, as a browser asks.
- **The steps** (`run.sh`): a customer made as the console's sign-up makes one (an e-mail, verified, and a password, nothing more to do), then each answer the flow can meet. 13 checks, the prototype's tests among them; a table of what each step answered and of the realm's settings.

## What it found

On 2026-11-08, with Keycloak 26.7.5 and the development realm as it is, up in 24 s:

| The realm's setting | Value | What it means for `ff login` |
|---|---|---|
| `oauth2DeviceCodeLifespan` | 600 | 10 minutes to sign in |
| `oauth2DevicePollingInterval` | 5 | a poll every 5 seconds |
| `accessTokenLifespan` | 300 | an access token lasts 5 minutes |
| `ssoSessionIdleTimeout` | 1800 | a refresh token lasts 30 minutes, renewed with each refresh |
| `ssoSessionMaxLifespan` | 36000 | a login lasts 10 hours at most |
| `offlineSessionIdleTimeout` | 2592000 | an offline token lasts 30 days unused, renewed with each refresh |
| `offlineSessionMaxLifespanEnabled` | false | and has no end while it's used |
| `revokeRefreshToken` | false | a refresh token still works once a refresh has replaced it |
| `ff-cli`'s optional scopes | address, phone, offline_access, organization, microprofile-jwt | `offline_access` may be asked |

| Step | What Keycloak answered |
|---|---|
| A device code | a code such as `OQQJ-XOPB`, the address `/realms/ff/device` and the complete one with the code in it, 600 s, interval 5 |
| Polled at once, then again at once | `authorization_pending`, then `slow_down` |
| The user denies | the pages: the login, then the device's approval, refused with its cancel button; "Consent denied for connecting the device". The poll: `access_denied` |
| The user approves while `ff` waits | the pages: the login, then the approval; "You may close this browser window and go back to your device". The polls: pending at 5 s, approved at 10 s |
| The tokens | the access token for `ff-api` (and `account`), from `ff-cli`, 300 s; the refresh token 1,800 s; one session ID in both; the scope `openid profile email` |
| A refresh | new tokens, the refresh token a new one, the session the same |
| The replaced refresh token, used again | new tokens too |
| A refresh after the session's end (the admin's logout of the user) | 400 `invalid_grant`, "Session not active" |
| A device code asked with `openid offline_access`, approved | an offline token: `typ` `Offline`, no end (`refresh_expires_in` 0) |
| Its refresh, after the session's end | new tokens: it outlives the session |
| Its refresh, after its revocation | 400 `invalid_grant`, "Offline user session not found" |
| A device code past its end (the lifespan set to 5 s for this step) | `expired_token` |

1. **The flow works against the development realm as it is.** Every answer RFC 8628 names came back as it says: pending, slow down, denied, expired, approved. The audience is the API's, as `ff`'s calls need. Nothing in the realm has to change for `ff login`.
2. **Keycloak asks the user to approve the device** on each device login, after the password, though `ff-cli` asks no consent otherwise: the user sees what is signing in. A code sent by someone else, as phishing would, needs that click too.
3. **Without offline access, a login doesn't last a working day.** The refresh token lasts 30 minutes unused and the session 10 hours: a developer who leaves `ff` alone over lunch logs in again. With `offline_access`, which `ff-cli` already allows, the token lasts while `ff` is used once a month, and survives the session's end.
4. **So `ff login` should ask `offline_access`,** as other command-line tools keep a login for weeks, and **`ff logout` must revoke the token at Keycloak** before removing it from `credentials.toml`. Removed alone, a copied offline token would go on working. The plan's D1 says the logout removes the tokens on this machine: M-02 adds the revocation, which the realm's discovery document gives (`revocation_endpoint`). A refused refresh still says to log in again, and tries nothing else.
5. **A refresh token keeps working once replaced,** because `revokeRefreshToken` is off. Turning it on would refuse a stolen token's reuse, but also the second of two `ff` commands that refresh at the same moment, which would then ask to log in again. `ff` would need a lock around its refresh first. Leave it off; M-02 refreshes once per command at most, within a minute of the end.
6. **One choice for the realm, not needed now:** an end to offline sessions (`offlineSessionMaxLifespanEnabled` and `offlineSessionMaxLifespan`, 90 days for instance), so that a forgotten laptop's login ends on its own. It is a line of `deploy/keycloak/ff-realm.json`, for ADR 0018 or M-02 to decide.
7. **For M-02's suite,** which does the user's part with `curl`: post the code with `Accept: text/html`, as above; `curl` already sends the `Secure` cookies to `localhost`.

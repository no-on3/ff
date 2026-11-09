//! Who calls the API (ADR 0002): a bearer token, an API key or a user's token, and the account
//! it acts for; in development, the account to act as.

use std::fmt;

use crate::config::Settings;
use crate::error::{Error, Kind};

/// A bearer token. Never printed whole, not even in debug output.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

/// The shape of an API key: `ffk_`, the key ID (12 lowercase hex characters), `_`, the secret
/// (43 base64url characters), as the API makes them.
fn is_api_key(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("ffk_") else { return false };
    let Some((id, secret)) = rest.split_once('_') else { return false };
    id.len() == 12
        && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && secret.len() == 43
        && secret.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

impl Token {
    /// Any token, as `FF_TOKEN` may hold a user's: trimmed, and none when empty.
    pub fn new(text: &str) -> Option<Token> {
        let text = text.trim();
        (!text.is_empty()).then(|| Token(text.to_owned()))
    }

    /// An API key, as `ff config set-token` takes it.
    pub fn api_key(text: &str) -> Result<Token, String> {
        let text = text.trim();
        if is_api_key(text) {
            Ok(Token(text.to_owned()))
        } else {
            Err("That isn't an API key: a key reads ffk_<key ID>_<secret>, as the console shows it once, when it makes it"
                .to_owned())
        }
    }

    pub fn secret(&self) -> &str {
        &self.0
    }

    pub fn is_api_key(&self) -> bool {
        is_api_key(&self.0)
    }

    /// An API key as the console lists it, `ffk_<key ID>_…`; another token's first characters.
    pub fn masked(&self) -> String {
        if self.is_api_key() {
            format!("{}…", &self.0[..17])
        } else {
            format!("{}…", self.0.chars().take(4).collect::<String>())
        }
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.masked())
    }
}

/// The headers that say who calls, with this token, and for which account.
pub fn identity_headers(settings: &Settings, token: Option<&Token>) -> Vec<(&'static str, String)> {
    let mut headers = Vec::new();
    if let Some(token) = token {
        headers.push(("authorization", format!("Bearer {}", token.secret())));
    }
    if let Some(account) = &settings.account {
        headers.push(("x-ff-account", account.value.clone()));
    }
    if let Some(account) = &settings.dev_account {
        headers.push(("x-ff-dev-account", account.value.clone()));
    }
    headers
}

/// Before any call: a token, or for a development stack, the account to act as.
pub fn require_identity(settings: &Settings) -> Result<(), Error> {
    if settings.token.is_some() || settings.dev_account.is_some() {
        return Ok(());
    }
    Err(Error::new(
        Kind::Failed,
        format!(
            "There is no token to call {} with: `ff login` logs you in with your browser. For a script or a CI, an \
             owner of the account makes an API key in the console's API keys page, with the scopes it needs; then \
             `ff config set-token` saves it without showing it, or FF_TOKEN holds it. For a development stack \
             (FF_AUTH_MODE=dev), name the account to act as instead: `ff config set dev_account <12 digits>`",
            settings.endpoint.value
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Setting, Source};

    const KEY: &str = "ffk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aBcDe";

    #[test]
    fn an_api_key_has_the_shape_the_api_gives_it_and_shows_only_its_id() {
        let key = Token::api_key(&format!(" {KEY}\n")).unwrap();

        assert_eq!(key.secret(), KEY);
        assert_eq!(key.masked(), "ffk_0123456789ab_…");
        assert_eq!(format!("{key:?}"), "ffk_0123456789ab_…");
        for wrong in [
            "",
            "ffk_0123456789AB_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aBcDe",
            "ffk_0123456789ab_short",
            "eyJhbGciOiJSUzI1NiJ9.x.y",
        ] {
            assert!(Token::api_key(wrong).is_err(), "{wrong}");
        }
        assert_eq!(Token::new("eyJhbGciOiJSUzI1NiJ9.x.y").unwrap().masked(), "eyJh…");
        assert_eq!(Token::new(" \n"), None);
    }

    #[test]
    fn the_headers_carry_the_token_and_the_accounts_set_and_nothing_else() {
        let mut settings = Settings::example();
        assert!(identity_headers(&settings, None).is_empty());

        settings.account = Some(Setting { value: "111111111111".into(), source: Source::Flag("--account") });
        settings.dev_account = Some(Setting { value: "222222222222".into(), source: Source::ConfigFile });

        assert_eq!(
            identity_headers(&settings, Some(&Token::new(KEY).unwrap())),
            [
                ("authorization", format!("Bearer {KEY}")),
                ("x-ff-account", "111111111111".into()),
                ("x-ff-dev-account", "222222222222".into())
            ]
        );
    }

    #[test]
    fn without_a_token_or_a_development_account_it_says_how_to_log_in_before_calling() {
        let mut settings = Settings::example();

        let refused = require_identity(&settings).unwrap_err();
        assert_eq!(refused.exit_code(), 3);
        assert!(
            refused.message.starts_with(
                "There is no token to call https://api.ff.example with: `ff login` logs you in with your browser."
            ),
            "{}",
            refused.message
        );
        assert!(refused.message.contains("`ff config set-token`") && refused.message.contains("dev_account"));

        settings.dev_account = Some(Setting { value: "222222222222".into(), source: Source::ConfigFile });
        assert!(require_identity(&settings).is_ok());
    }
}

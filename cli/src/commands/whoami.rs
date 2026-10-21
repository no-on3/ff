//! `ff whoami`: `GET /me`, which says who the token is (an API key, whatever its scopes, or a
//! user) and the account it acts for: the first check of a new key.

use super::Context;
use crate::api::types::{Me, MeAccount as Account};
use crate::api::{Call, Client};
use crate::config::Settings;
use crate::error::Error;

pub fn run(context: &Context) -> Result<(), Error> {
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    // The API's answer is printed as it came for scripts; read here for people.
    let answer: serde_json::Value = client.json(&Call::get("/me"))?;
    let me: Me = serde_json::from_value(answer.clone()).map_err(|error| {
        Error::new(crate::error::Kind::Failed, format!("The API's answer to GET /me isn't what ff expects: {error}"))
    })?;
    context.out.result(&answer, || text(&me, &settings))
}

fn account_line(account: &Account) -> String {
    format!("account {} \"{}\" ({}, plan {})", account.id, account.name, account.status, account.plan.name)
}

fn text(me: &Me, settings: &Settings) -> String {
    let api = format!("API: {}", settings.endpoint.value);
    if let Some(key) = &me.key {
        let account = me.accounts.first().map(account_line).unwrap_or_default();
        let role = me.accounts.first().map(|account| account.role.as_str()).unwrap_or("?");
        return format!(
            "API key \"{}\" (ffk_{}_…) on {account}\nscopes: {}, within its creator's role: {role}\n{api}",
            key.name,
            key.id,
            key.scopes.join(", ")
        );
    }
    let Some(user) = &me.user else {
        let account = me.accounts.first().map(account_line).unwrap_or_default();
        return format!("Development mode, as the owner of {account}\n{api}");
    };
    let who = match &user.name {
        Some(name) => format!("{name} <{}>", user.email),
        None => user.email.clone(),
    };
    let current = settings.account.as_ref().map(|account| account.value.as_str());
    let mut lines = vec![who];
    for account in &me.accounts {
        let chosen = current == Some(account.id.as_str()) || (current.is_none() && me.accounts.len() == 1);
        lines.push(format!("{} {}, as {}", if chosen { "*" } else { " " }, account_line(account), account.role));
    }
    if current.is_none() && me.accounts.len() > 1 {
        lines.push("Several accounts: name one with --account, FF_ACCOUNT or `ff config set account <ID>`".to_owned());
    }
    lines.push(api);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::config::{Endpoint, Files, Setting, Source};

    fn settings(account: Option<&str>) -> Settings {
        Settings {
            profile: Setting { value: "default".into(), source: Source::Default },
            endpoint: Setting { value: Endpoint::parse("https://api.ff.example").unwrap(), source: Source::ConfigFile },
            account: account.map(|account| Setting { value: account.into(), source: Source::Flag("--account") }),
            dev_account: None,
            token: None,
            allow_http: Setting { value: false, source: Source::Default },
            files: Files { dir: PathBuf::from("/tmp/ff") },
            warnings: Vec::new(),
        }
    }

    fn me(json: serde_json::Value) -> Me {
        serde_json::from_value(json).unwrap()
    }

    fn account(id: &str, name: &str, role: &str) -> serde_json::Value {
        serde_json::json!({ "id": id, "name": name, "status": "active", "role": role, "plan": { "id": "beta", "name": "Beta", "limits": {} } })
    }

    #[test]
    fn a_key_says_its_name_id_scopes_and_account() {
        let me = me(serde_json::json!({
            "user": null,
            "key": { "id": "0123456789ab", "name": "laptop", "scopes": ["functions:read", "functions:invoke"] },
            "accounts": [account("123456789012", "Acme Dev", "developer")]
        }));

        assert_eq!(
            text(&me, &settings(None)),
            "API key \"laptop\" (ffk_0123456789ab_…) on account 123456789012 \"Acme Dev\" (active, plan Beta)\n\
             scopes: functions:read, functions:invoke, within its creator's role: developer\nAPI: https://api.ff.example"
        );
    }

    #[test]
    fn a_user_lists_their_accounts_and_which_one_acts() {
        let me = me(serde_json::json!({
            "user": { "id": "u1", "email": "salma@ff.test", "name": "Salma", "locale": "en" },
            "accounts": [account("111111111111", "One", "owner"), account("222222222222", "Two", "viewer")]
        }));

        assert_eq!(
            text(&me, &settings(Some("222222222222"))),
            "Salma <salma@ff.test>\n  account 111111111111 \"One\" (active, plan Beta), as owner\n\
             * account 222222222222 \"Two\" (active, plan Beta), as viewer\nAPI: https://api.ff.example"
        );
        assert!(text(&me, &settings(None)).contains("\nSeveral accounts: name one with --account"));
    }

    #[test]
    fn development_mode_names_the_account_it_acts_as() {
        let me = me(
            serde_json::json!({ "user": null, "key": null, "accounts": [account("123456789012", "Development account 123456789012", "owner")] }),
        );

        assert_eq!(
            text(&me, &settings(None)),
            "Development mode, as the owner of account 123456789012 \"Development account 123456789012\" (active, plan Beta)\nAPI: https://api.ff.example"
        );
    }
}

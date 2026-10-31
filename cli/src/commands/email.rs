//! `ff email`: the account's mail, as AWS SES v2 sends it. The domains and addresses it sends
//! from, with the records a domain publishes; its sending, the sandbox and the plan's quotas; a
//! message sent to try one; the latest messages, with what became of each recipient; and the
//! suppression list, the addresses none of its mail goes to.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Context;
use super::url::encode;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::{table, time};

/// A record a domain publishes at its DNS.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    purpose: String,
    #[serde(rename = "type")]
    kind: String,
    name: String,
    value: String,
}

/// A domain or an address, as `GET /email/identities` and `GET /email/identities/:identity` answer it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Identity {
    pub(super) identity: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    sending_enabled: bool,
    dkim_selector: Option<String>,
    mail_from_domain: Option<String>,
    mail_from_verified: bool,
    records: Vec<Record>,
    verified_at: Option<String>,
    created_at: String,
}

/// The account's sending, as `GET /email/account` answers it, after SES's GetAccount.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    sandbox: bool,
    sending_enabled: bool,
    enforcement_status: String,
    #[serde(rename = "max24HourSend")]
    max_24_hour_send: u64,
    max_send_rate: u64,
    #[serde(rename = "sentLast24Hours")]
    sent_last_24_hours: u64,
}

/// What became of one recipient of a message.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recipient {
    address: String,
    status: String,
    diagnostic: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    message_id: String,
    from: String,
    identity: String,
    status: String,
    recipients: Vec<Recipient>,
    size_bytes: u64,
    created_at: String,
    sent_at: Option<String>,
}

#[derive(Deserialize)]
struct Messages {
    messages: Vec<Message>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Suppression {
    address: String,
    reason: String,
    message_id: Option<String>,
    feedback: Option<String>,
    updated_at: String,
}

#[derive(Deserialize)]
struct SuppressionPage {
    suppressions: Vec<Suppression>,
    next: Option<String>,
}

/// The name as the API keeps it: trimmed, lower case, a domain without a final dot.
fn identity_key(name: &str) -> String {
    let name = name.trim().to_lowercase();
    name.strip_suffix('.').map(str::to_owned).unwrap_or(name)
}

fn is_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Why a name is no domain mail can go from, as the API says it; none when it is one.
fn domain_problem(domain: &str) -> Option<String> {
    if domain.is_empty() || domain.len() > 253 {
        return Some("A domain has 1 to 253 characters".to_owned());
    }
    let bare = domain.trim_start_matches('[').trim_end_matches(']');
    if domain.parse::<IpAddr>().is_ok() || bare.parse::<IpAddr>().is_ok() {
        return Some("An IP address is no domain: give a name, such as example.tn".to_owned());
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return Some("A domain has two labels at least, such as example.tn".to_owned());
    }
    if let Some(bad) = labels.iter().find(|label| !is_label(label)) {
        return Some(format!(
            "\"{bad}\" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen"
        ));
    }
    if labels[labels.len() - 1].bytes().all(|byte| byte.is_ascii_digit()) {
        return Some("A domain ends with a name, not a number".to_owned());
    }
    None
}

/// An address's local part, as mailbox providers take it: letters, digits and the punctuation
/// RFC 5322 allows unquoted, a dot only between them.
fn is_local_part(local: &str) -> bool {
    local.len() <= 64
        && local.split('.').all(|atom| {
            !atom.is_empty()
                && atom.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"!#$%&'*+/=?^_`{|}~-".contains(&byte)
                })
        })
}

/// Why a name is no address mail can go to or from, as the API says it; none when it is one.
fn address_problem(address: &str) -> Option<String> {
    if address.len() > 320 {
        return Some("An address has 320 characters at most".to_owned());
    }
    let Some(at) = address.rfind('@').filter(|at| *at > 0 && *at < address.len() - 1) else {
        return Some("An address is a local part, @ and a domain, such as orders@example.tn".to_owned());
    };
    let local = &address[..at];
    if !is_local_part(local) {
        return Some(format!(
            "\"{local}\" is not an address's local part: 64 letters, digits, dots and !#$%&'*+/=?^_`{{|}}~- at most"
        ));
    }
    domain_problem(&address[at + 1..]).map(|problem| format!("The address's domain: {problem}"))
}

/// The identity as the API keeps it, or why it is neither a domain nor an address, before any call.
fn checked_identity(name: &str) -> Result<String, Error> {
    let identity = identity_key(name);
    let problem = if identity.contains('@') { address_problem(&identity) } else { domain_problem(&identity) };
    match problem {
        None => Ok(identity),
        Some(problem) => Err(Error::new(
            Kind::Usage,
            format!(
                "\"{name}\" is neither a domain, such as shop.example.tn, nor an address, such as orders@shop.example.tn: {problem}"
            ),
        )),
    }
}

fn checked_address(address: &str) -> Result<String, Error> {
    let key = identity_key(address);
    match address_problem(&key) {
        None => Ok(key),
        Some(problem) => Err(Error::new(Kind::Usage, format!("\"{address}\" is not an address: {problem}"))),
    }
}

/// An identity's status, as the console says it.
fn status(identity: &Identity) -> &'static str {
    match identity.status.as_str() {
        "SUCCESS" => "proved",
        "PENDING" => "waiting",
        "TEMPORARY_FAILURE" => "record gone",
        _ => "not proved",
    }
}

/// What its status means: what FF waits for, or what to do.
fn status_detail(identity: &Identity) -> String {
    let domain = identity.kind == "DOMAIN";
    match identity.status.as_str() {
        "SUCCESS" => "mail goes from it".to_owned(),
        "PENDING" if domain => "FF looks for its DKIM record every minute, for 72 hours".to_owned(),
        "PENDING" => "FF e-mailed it a link, whose following proves it".to_owned(),
        "TEMPORARY_FAILURE" => {
            "proved once, its DKIM record is gone since; no mail goes from it until it is back".to_owned()
        }
        _ if domain => {
            "its DKIM record was not found within 72 hours; publish it, then `ff email verify` it".to_owned()
        }
        _ => "its link was not followed; `ff email verify` e-mails it again".to_owned(),
    }
}

fn kind(identity: &Identity) -> &'static str {
    if identity.kind == "DOMAIN" { "domain" } else { "address" }
}

fn on_off(on: bool) -> &'static str {
    if on { "on" } else { "off" }
}

/// The records a domain publishes, each with what it is for.
fn records(identity: &Identity) -> String {
    let rows: Vec<Vec<String>> = identity
        .records
        .iter()
        .map(|record| {
            let purpose =
                if record.purpose == "DMARC" { "DMARC (advised)".to_owned() } else { record.purpose.replace('_', " ") };
            vec![purpose, record.kind.clone(), record.name.clone(), record.value.clone()]
        })
        .collect();
    table(&["FOR", "TYPE", "NAME", "VALUE"], &rows)
}

fn details(identity: &Identity) -> String {
    let mut rows = vec![
        ("type", kind(identity).to_owned()),
        ("status", format!("{}: {}", status(identity), status_detail(identity))),
        ("sending", on_off(identity.sending_enabled).to_owned()),
    ];
    if let Some(selector) = &identity.dkim_selector {
        rows.push(("dkim", format!("selector {selector}, FF's key signs its mail")));
    }
    if let Some(domain) = &identity.mail_from_domain {
        let state = if identity.mail_from_verified { "its MX record found" } else { "waiting for its MX record" };
        rows.push(("return path", format!("{domain}, {state}")));
    }
    rows.push((
        "proved",
        identity.verified_at.as_deref().map(|at| format!("{} UTC", time(at))).unwrap_or_else(|| "-".to_owned()),
    ));
    rows.push(("created", format!("{} UTC", time(&identity.created_at))));
    let mut text = rows.iter().map(|(label, value)| format!("{label:<11} {value}")).collect::<Vec<_>>().join("\n");
    if !identity.records.is_empty() {
        text.push_str(&format!("\n\nThe records to publish at its DNS:\n{}", records(identity)));
    }
    text
}

pub fn identities(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let identities: Vec<Identity> = client.json(&Call::get("/email/identities"))?;
    context.out.result(&identities, || {
        if identities.is_empty() {
            return "The account sends from no domain or address: `ff email add <domain or address>` adds one"
                .to_owned();
        }
        let rows: Vec<Vec<String>> = identities
            .iter()
            .map(|identity| {
                vec![
                    identity.identity.clone(),
                    kind(identity).to_owned(),
                    status(identity).to_owned(),
                    on_off(identity.sending_enabled).to_owned(),
                    time(&identity.created_at),
                ]
            })
            .collect();
        table(&["IDENTITY", "TYPE", "STATUS", "SENDING", "CREATED (UTC)"], &rows)
    })
}

pub fn add(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_identity(name)?;
    let client = Client::new(&context.settings()?)?;
    let identity: Identity = client.json(&Call::post("/email/identities", json!({ "identity": name })))?;
    context.out.result(&identity, || {
        if identity.kind == "DOMAIN" {
            format!(
                "{0} added: publish these records at its DNS. FF looks for them every minute, for 72 hours; `ff email verify {0}` looks now.\n{1}",
                identity.identity,
                records(&identity)
            )
        } else {
            format!(
                "{0} added: FF e-mailed it a link, whose following proves it; `ff email verify {0}` e-mails it again.",
                identity.identity
            )
        }
    })
}

pub fn get(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_identity(name)?;
    let client = Client::new(&context.settings()?)?;
    let identity: Identity = client.json(&Call::get(format!("/email/identities/{}", encode(&name))))?;
    context.out.result(&identity, || format!("{}\n{}", identity.identity, details(&identity)))
}

pub fn verify(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_identity(name)?;
    let client = Client::new(&context.settings()?)?;
    let identity: Identity =
        client.json(&Call::post(format!("/email/identities/{}/verify", encode(&name)), json!({})))?;
    context.out.result(&identity, || {
        let what = match (identity.kind.as_str(), identity.status.as_str()) {
            (_, "SUCCESS") => "proved: mail goes from it".to_owned(),
            ("DOMAIN", _) => format!("its records looked up now: {}", status_detail(&identity)),
            _ => "its link e-mailed again; the last one is no longer good".to_owned(),
        };
        format!("{}: {what}", identity.identity)
    })
}

pub fn delete(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let name = checked_identity(name)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff email delete",
        &format!("Delete {name}, with its DKIM key? No mail goes from it after"),
        yes,
    )? {
        return context.out.result(&json!({ "deleted": false, "identity": name }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/email/identities/{}", encode(&name))))?;
    context
        .out
        .result(&json!({ "deleted": true, "identity": name }), || format!("deleted {name}: no mail goes from it"))
}

/// Its sandbox, its switch and its standing, as one line; none when it sends as it should.
fn notice(account: &Account) -> Option<&'static str> {
    if !account.sending_enabled {
        Some("FF's operator paused its sending: its messages are refused. The e-mail to its owners says why.")
    } else if account.enforcement_status == "SHUTDOWN" {
        Some("Its sending is stopped: its bounces or complaints went past 10% or 0.5%. FF's operator reviews it.")
    } else if account.enforcement_status == "PROBATION" {
        Some(
            "Its sending is under review: its bounces or complaints went past 5% or 0.1%. Clean its lists: past 10% or 0.5%, it stops.",
        )
    } else if account.sandbox {
        Some(
            "In the sandbox, as every new account is: mail goes only to the addresses and domains it proved. FF's operator lets it out once it says what it sends.",
        )
    } else {
        None
    }
}

pub fn account(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let account: Account = client.json(&Call::get("/email/account"))?;
    context.out.result(&account, || {
        let standing = match account.enforcement_status.as_str() {
            "HEALTHY" => "healthy",
            "PROBATION" => "under review",
            "SHUTDOWN" => "stopped",
            other => other,
        };
        let rows = [
            ("sandbox", if account.sandbox { "yes" } else { "no" }.to_owned()),
            ("sending", on_off(account.sending_enabled).to_owned()),
            ("standing", standing.to_owned()),
            (
                "sent",
                format!(
                    "{} of {} messages in the last 24 hours, {} a second at most",
                    account.sent_last_24_hours, account.max_24_hour_send, account.max_send_rate
                ),
            ),
        ];
        let mut text = rows.iter().map(|(label, value)| format!("{label:<8} {value}")).collect::<Vec<_>>().join("\n");
        if let Some(notice) = notice(&account) {
            text.push_str(&format!("\n\n{notice}"));
        }
        text
    })
}

/// A message to send, as `POST /email/messages` takes it.
pub struct Send<'a> {
    pub from: &'a str,
    pub to: &'a [String],
    pub cc: &'a [String],
    pub bcc: &'a [String],
    pub subject: &'a str,
    pub text: Option<&'a str>,
    pub html: Option<&'a str>,
}

pub fn send(message: Send, context: &Context) -> Result<(), Error> {
    let mut body = json!({ "from": message.from, "to": message.to, "subject": message.subject });
    for (field, addresses) in [("cc", message.cc), ("bcc", message.bcc)] {
        if !addresses.is_empty() {
            body[field] = json!(addresses);
        }
    }
    for (field, content) in [("text", message.text), ("html", message.html)] {
        if let Some(content) = content {
            body[field] = json!(content);
        }
    }
    let client = Client::new(&context.settings()?)?;
    let sent: serde_json::Value = client.json(&Call::post("/email/messages", body))?;
    let id = sent["messageId"].as_str().unwrap_or_default().to_owned();
    context.out.result(&sent, || format!("queued as {id}: `ff email messages` shows what became of each recipient"))
}

/// A message's size: bytes, then KB of 1,024 bytes and MB, to a tenth.
fn message_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let kb = bytes as f64 / 1024.0;
    if kb >= 1024.0 {
        return format!("{:.1} MB", kb / 1024.0);
    }
    format!("{kb:.1} KB")
}

/// What became of a recipient, in a word or two, with the receiving server's words when it refused.
fn fate(recipient: &Recipient) -> String {
    let word = match recipient.status.as_str() {
        "QUEUED" => "queued",
        "SENT" => "sent",
        "SUPPRESSED" => "kept off: on the suppression list",
        "BOUNCED" => "bounced",
        "COMPLAINED" => "complained of",
        "FAILED" => "failed",
        other => other,
    };
    match &recipient.diagnostic {
        Some(diagnostic) if recipient.status != "SENT" => format!("{} {word} ({diagnostic})", recipient.address),
        _ => format!("{} {word}", recipient.address),
    }
}

pub fn messages(limit: u32, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let page: Messages = client.json(&Call::get("/email/messages").query("limit", limit))?;
    let messages = page.messages;
    context.out.result(&messages, || {
        if messages.is_empty() {
            return "The account sent no message in the last 30 days".to_owned();
        }
        let rows: Vec<Vec<String>> = messages
            .iter()
            .map(|message| {
                vec![
                    time(&message.created_at),
                    message.message_id.clone(),
                    message.from.clone(),
                    message_size(message.size_bytes),
                    message.recipients.iter().map(fate).collect::<Vec<_>>().join(", "),
                ]
            })
            .collect();
        table(&["CREATED (UTC)", "MESSAGE ID", "FROM", "SIZE", "RECIPIENTS"], &rows)
    })
}

pub fn suppressions(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    // Every page, as the AWS CLI pages ListSuppressedDestinations.
    let mut suppressions = Vec::new();
    let mut next: Option<String> = None;
    loop {
        let mut call = Call::get("/email/suppressions").query("limit", 1000);
        if let Some(next) = &next {
            call = call.query("next", next);
        }
        let page: SuppressionPage = client.json(&call)?;
        suppressions.extend(page.suppressions);
        match page.next {
            Some(token) => next = Some(token),
            None => break,
        }
    }
    context.out.result(&suppressions, || {
        if suppressions.is_empty() {
            return "The account's suppression list is empty: its mail goes to every address it is sent to".to_owned();
        }
        let rows: Vec<Vec<String>> = suppressions
            .iter()
            .map(|suppression| {
                vec![
                    suppression.address.clone(),
                    suppression.reason.to_lowercase(),
                    suppression.message_id.clone().unwrap_or_else(|| "-".to_owned()),
                    time(&suppression.updated_at),
                ]
            })
            .collect();
        table(&["ADDRESS", "REASON", "FROM MESSAGE", "PUT THERE (UTC)"], &rows)
    })
}

pub fn suppress(address: &str, reason: &str, context: &Context) -> Result<(), Error> {
    let address = checked_address(address)?;
    let client = Client::new(&context.settings()?)?;
    let suppression: Suppression =
        client.json(&Call::put(format!("/email/suppressions/{}", encode(&address)), json!({ "reason": reason })))?;
    context.out.result(&suppression, || {
        format!(
            "{} is on the suppression list ({}): no mail of the account goes to it",
            suppression.address,
            suppression.reason.to_lowercase()
        )
    })
}

pub fn unsuppress(address: &str, context: &Context) -> Result<(), Error> {
    let address = checked_address(address)?;
    let client = Client::new(&context.settings()?)?;
    client.done(&Call::delete(format!("/email/suppressions/{}", encode(&address))))?;
    context.out.result(&json!({ "removed": true, "address": address }), || {
        format!("{address} is off the suppression list: the account's mail goes to it again")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_follow_the_apis_rules_kept_in_lower_case() {
        assert_eq!(checked_identity(" Shop.Example.TN. ").unwrap(), "shop.example.tn");
        assert_eq!(checked_identity("Orders+test@Shop.example.tn").unwrap(), "orders+test@shop.example.tn");
        for (name, problem) in [
            ("localhost", "A domain has two labels at least, such as example.tn"),
            ("192.0.2.1", "An IP address is no domain: give a name, such as example.tn"),
            ("orders@[192.0.2.1]", "The address's domain: An IP address is no domain"),
            ("shop.-example.tn", "\"-example\" is not a label"),
            ("example.123", "A domain ends with a name, not a number"),
            ("@example.tn", "An address is a local part, @ and a domain"),
            ("or..ders@example.tn", "\"or..ders\" is not an address's local part"),
        ] {
            let error = checked_identity(name).unwrap_err();
            assert_eq!(error.exit_code(), 2, "{name}");
            assert!(error.to_string().contains(problem), "{name}: {error}");
        }
        assert!(checked_address("shop.example.tn").unwrap_err().to_string().contains("An address is a local part"));
    }

    #[test]
    fn a_recipient_reads_with_the_receiving_servers_words_when_it_refused() {
        let recipient = |status: &str, diagnostic: Option<&str>| Recipient {
            address: "ana@example.tn".to_owned(),
            status: status.to_owned(),
            diagnostic: diagnostic.map(str::to_owned),
        };
        assert_eq!(fate(&recipient("SENT", Some("250 2.0.0 Ok"))), "ana@example.tn sent");
        assert_eq!(
            fate(&recipient("BOUNCED", Some("550 5.1.1 no such user"))),
            "ana@example.tn bounced (550 5.1.1 no such user)"
        );
        assert_eq!(fate(&recipient("SUPPRESSED", None)), "ana@example.tn kept off: on the suppression list");
    }

    #[test]
    fn a_messages_size_reads_in_kb_as_mail_is() {
        assert_eq!([message_size(512), message_size(2_150), message_size(10_485_760)], ["512 B", "2.1 KB", "10.0 MB"]);
    }
}

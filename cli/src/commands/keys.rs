//! `ff keys list|create|revoke`, and `ff buckets keys`, another name for it: the account's access
//! keys, as an IAM user's, which AWS's SDKs and CLI sign their requests with at FF's endpoints. A
//! key names what it reaches: naming nothing, every bucket and queue of the account and its mail;
//! naming buckets, queues or functions, those alone, its functions at one level. Its secret is shown
//! once, when it is made, as the variables AWS's tools read; a key stays as it was made: another
//! reach is another key.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Context;
use crate::api::{Call, Client};
use crate::cli::{FunctionAccess, KeysCommand, NewKeyArgs};
use crate::config::is_function_name;
use crate::error::{Error, Kind};
use crate::table::{table, time};

/// What a key names, alone, to reach all the account's functions.
const ALL_FUNCTIONS: &str = "*";

/// An access key, as `GET /storage-keys` lists it: never its secret. Naming nothing, it reaches all the account's
/// buckets and queues, and no function; naming buckets, queues or functions, those alone.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageKey {
    pub id: String,
    /// Its name; an API from before keys had names gives none.
    #[serde(default)]
    pub name: Option<String>,
    pub buckets: Option<Vec<String>>,
    #[serde(default)]
    pub queues: Option<Vec<String>>,
    pub read_only: bool,
    /// The functions it names, or `*` for all; none for none.
    #[serde(default)]
    pub functions: Option<Vec<String>>,
    /// What it may do with them: read, invoke or write.
    #[serde(default)]
    pub function_access: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

impl StorageKey {
    /// Whether it names nothing, and so reaches every bucket and queue of the account.
    fn names_nothing(&self) -> bool {
        self.buckets.is_none() && self.queues.is_none() && self.functions.is_none()
    }

    /// Whether it reaches buckets or queues: all of them, or those it names.
    fn reaches_storage(&self) -> bool {
        self.names_nothing() || self.buckets.is_some() || self.queues.is_some()
    }

    /// Its name, when it has one of its own: a key named by its ID, or listed by an API from before names, has none.
    fn own_name(&self) -> Option<&str> {
        self.name.as_deref().filter(|name| *name != self.id)
    }

    /// How a message names it: its name and its ID, or its ID alone.
    fn label(&self) -> String {
        match self.own_name() {
            Some(name) => format!("{name} ({})", self.id),
            None => self.id.clone(),
        }
    }
}

/// The account's access keys, which owners list.
pub fn storage_keys(client: &Client) -> Result<Vec<StorageKey>, Error> {
    client.json(&Call::get("/storage-keys"))
}

/// A key just made: its secret this once, and where to use it.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedKey {
    #[serde(flatten)]
    key: StorageKey,
    secret_access_key: String,
    endpoint: String,
    /// The SQS endpoint, AWS_ENDPOINT_URL_SQS, for the account's queues.
    #[serde(default)]
    sqs_endpoint: Option<String>,
    /// The SES endpoint, AWS_ENDPOINT_URL_SESV2, for the account's mail.
    #[serde(default)]
    ses_endpoint: Option<String>,
    /// Lambda's endpoint, AWS_ENDPOINT_URL_LAMBDA, for the account's functions.
    #[serde(default)]
    lambda_endpoint: Option<String>,
    region: String,
}

impl CreatedKey {
    /// The variables AWS's SDKs and CLI read, as shell lines: the SQS, SES and Lambda endpoints when the API gives them.
    fn export_lines(&self) -> String {
        let mut variables = vec![
            ("AWS_ACCESS_KEY_ID", self.key.id.as_str()),
            ("AWS_SECRET_ACCESS_KEY", self.secret_access_key.as_str()),
            ("AWS_REGION", self.region.as_str()),
            ("AWS_ENDPOINT_URL_S3", self.endpoint.as_str()),
        ];
        let given = [
            ("AWS_ENDPOINT_URL_SQS", &self.sqs_endpoint),
            ("AWS_ENDPOINT_URL_SESV2", &self.ses_endpoint),
            ("AWS_ENDPOINT_URL_LAMBDA", &self.lambda_endpoint),
        ];
        variables.extend(given.iter().filter_map(|(name, endpoint)| {
            Some((*name, endpoint.as_deref().filter(|endpoint| !endpoint.is_empty())?))
        }));
        variables.iter().map(|(name, value)| format!("export {name}={value}")).collect::<Vec<_>>().join("\n")
    }
}

/// An access key ID as FF makes them: AKFF and 16 characters of base32.
pub fn is_key_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("AKFF")
        && id[4..].bytes().all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
}

/// An IAM user's rule for a name, which the API holds keys' names to: 1 to 64 letters, digits and `+=,.@_-`.
pub fn is_key_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"+=,.@_-".contains(&byte))
}

/// The buckets or the queues a key reaches, for a column: all, those it names, or none when it names others alone.
fn column(names: Option<&Vec<String>>, key: &StorageKey) -> String {
    match names {
        Some(names) => names.join(","),
        None if key.names_nothing() => "all".to_owned(),
        None => "-".to_owned(),
    }
}

/// The functions a key reaches, for a column, with its level: all of them, those it names, or none.
fn functions_column(key: &StorageKey) -> String {
    match &key.functions {
        None => "-".to_owned(),
        Some(names) => {
            let which = if names.iter().any(|name| name == ALL_FUNCTIONS) { "all".to_owned() } else { names.join(",") };
            format!("{which} ({})", key.function_access.as_deref().unwrap_or("read"))
        }
    }
}

/// What a key reaches, in words.
pub fn reaches(key: &StorageKey) -> String {
    let named = |kind: &str, names: &[String]| {
        format!("the {kind}{} {}", if names.len() == 1 { "" } else { "s" }, names.join(", "))
    };
    if key.names_nothing() {
        let reach = "every bucket and queue of the account";
        return if key.read_only { format!("{reach}, read-only") } else { reach.to_owned() };
    }
    let storage: Vec<String> = [("bucket", &key.buckets), ("queue", &key.queues)]
        .into_iter()
        .filter_map(|(kind, names)| names.as_ref().map(|names| named(kind, names)))
        .collect();
    let mut reach = storage.join(" and ");
    if key.read_only && !storage.is_empty() {
        reach.push_str(", read-only");
    }
    if let Some(functions) = &key.functions {
        let which = if functions.iter().any(|name| name == ALL_FUNCTIONS) {
            "every function of the account".to_owned()
        } else {
            named("function", functions)
        };
        let level = key.function_access.as_deref().unwrap_or("read");
        reach =
            if reach.is_empty() { format!("{which}, to {level}") } else { format!("{reach}, and {which}, to {level}") };
    }
    reach
}

pub fn run(command: KeysCommand, context: &Context) -> Result<(), Error> {
    match command {
        KeysCommand::List => list(context),
        KeysCommand::Create(args) => create(&args, context),
        KeysCommand::Revoke { key, yes } => revoke(&key, yes, context),
    }
}

fn list(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let keys = storage_keys(&client)?;
    context.out.result(&keys, || {
        if keys.is_empty() {
            return "The account has no access key: `ff keys create` makes one".to_owned();
        }
        let rows: Vec<Vec<String>> = keys
            .iter()
            .map(|key| {
                vec![
                    key.id.clone(),
                    key.own_name().unwrap_or("-").to_owned(),
                    column(key.buckets.as_ref(), key),
                    column(key.queues.as_ref(), key),
                    match (key.reaches_storage(), key.read_only) {
                        (false, _) => "-",
                        (true, true) => "read-only",
                        (true, false) => "read-write",
                    }
                    .to_owned(),
                    functions_column(key),
                    key.last_used_at.as_deref().map(time).unwrap_or_else(|| "never".to_owned()),
                    time(&key.created_at),
                ]
            })
            .collect();
        table(&["ID", "NAME", "BUCKETS", "QUEUES", "ACCESS", "FUNCTIONS", "LAST USED (UTC)", "CREATED (UTC)"], &rows)
    })
}

/// POST /storage-keys's body for the key asked for, what it names held to the API's rules before any call.
fn request(args: &NewKeyArgs) -> Result<Value, Error> {
    if let Some(name) = args.name.as_deref().filter(|name| !is_key_name(name)) {
        return Err(Error::usage(format!(
            "\"{name}\" can't be an access key's name: 1 to 64 letters, digits and +=,.@_-, as an IAM user's"
        )));
    }
    for bucket in &args.buckets {
        super::buckets::checked_name(bucket)?;
    }
    for queue in &args.queues {
        super::queues::checked_name(queue)?;
    }
    if let Some(function) = args.functions.iter().find(|name| *name != ALL_FUNCTIONS && !is_function_name(name)) {
        return Err(Error::usage(format!(
            "\"{function}\" can't be a function's name: 1 to 64 letters, digits, hyphens or underscores, or '*' for all the account's"
        )));
    }
    if args.functions.len() > 1 && args.functions.iter().any(|name| name == ALL_FUNCTIONS) {
        return Err(Error::usage("--function '*' names all the account's functions: it goes alone"));
    }
    let names_storage = !args.buckets.is_empty() || !args.queues.is_empty();
    if args.read_only && !args.functions.is_empty() && !names_storage {
        return Err(Error::usage(
            "--read-only is for a key's buckets and queues, and one that names functions alone reaches none: \
             --function-access says what it does with its functions",
        ));
    }
    let mut body = json!({ "readOnly": args.read_only });
    if let Some(name) = &args.name {
        body["name"] = json!(name);
    }
    if !args.buckets.is_empty() {
        body["buckets"] = json!(args.buckets);
    }
    if !args.queues.is_empty() {
        body["queues"] = json!(args.queues);
    }
    if !args.functions.is_empty() {
        body["functions"] = json!(args.functions);
        body["functionAccess"] = json!(args.function_access.unwrap_or(FunctionAccess::Invoke).as_str());
    }
    Ok(body)
}

fn create(args: &NewKeyArgs, context: &Context) -> Result<(), Error> {
    let body = request(args)?;
    let client = Client::new(&context.settings()?)?;
    let made: CreatedKey = client.json(&Call::post("/storage-keys", body))?;
    context.out.result(&made, || {
        format!(
            "{} made, reaching {}: its secret, shown this once (FF keeps it sealed; `ff keys revoke {}` stops it):\n{}",
            made.key.label(),
            reaches(&made.key),
            made.key.id,
            made.export_lines()
        )
    })
}

/// Revokes a key named by its ID, or by its name, which the account's list finds.
fn revoke(key: &str, yes: bool, context: &Context) -> Result<(), Error> {
    if !is_key_id(key) && !is_key_name(key) {
        return Err(Error::usage(format!(
            "\"{key}\" is neither an access key ID of FF's, AKFF and 16 letters and digits, nor an access key's name"
        )));
    }
    let client = Client::new(&context.settings()?)?;
    let (id, label) = if is_key_id(key) {
        (key.to_owned(), key.to_owned())
    } else {
        let found = storage_keys(&client)?.into_iter().find(|listed| listed.name.as_deref() == Some(key));
        let found = found.ok_or_else(|| {
            Error::new(Kind::Failed, format!("The account has no access key named {key}: `ff keys list` lists them"))
        })?;
        (found.id.clone(), found.label())
    };
    if !super::functions::confirmed(
        "ff keys revoke",
        &format!("Revoke the access key {label}? Whatever uses it is refused at once"),
        yes,
    )? {
        return context.out.result(&json!({ "revoked": false, "id": id }), || "Nothing revoked".to_owned());
    }
    client.done(&Call::delete(format!("/storage-keys/{id}")))?;
    context.out.result(&json!({ "revoked": true, "id": id }), || format!("revoked the access key {label}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_source::{class_fields, listed, sorted, sorted_keys};
    use clap::ValueEnum;

    const DTO: &str = include_str!("../../../BE/src/storage/dto/storage.dto.ts");
    const ENTITY: &str = include_str!("../../../BE/src/storage/storage-key.entity.ts");

    fn key(buckets: Option<&[&str]>, queues: Option<&[&str]>, read_only: bool) -> StorageKey {
        let names = |names: Option<&[&str]>| names.map(|names| names.iter().map(|name| name.to_string()).collect());
        StorageKey {
            id: "AKFF7Q2MLKX4RTZB3W5N".into(),
            name: None,
            buckets: names(buckets),
            queues: names(queues),
            read_only,
            functions: None,
            function_access: None,
            created_at: "2026-10-24T08:00:00.000Z".into(),
            last_used_at: None,
        }
    }

    #[test]
    fn a_key_reaches_every_bucket_and_queue_or_those_it_names_alone() {
        let all = key(None, None, false);
        let photos = key(Some(&["photos"]), None, true);
        let orders = key(None, Some(&["orders", "orders-dlq"]), false);
        let both = key(Some(&["photos"]), Some(&["orders"]), false);
        assert_eq!(
            [reaches(&all), reaches(&photos), reaches(&orders), reaches(&both)],
            [
                "every bucket and queue of the account",
                "the bucket photos, read-only",
                "the queues orders, orders-dlq",
                "the bucket photos and the queue orders"
            ]
        );
        let columns = |key: &StorageKey| (column(key.buckets.as_ref(), key), column(key.queues.as_ref(), key));
        assert_eq!(columns(&all), ("all".into(), "all".into()));
        assert_eq!(columns(&photos), ("photos".into(), "-".into()));
        assert_eq!(columns(&orders), ("-".into(), "orders,orders-dlq".into()));
        // A key that names functions alone reaches no bucket and no queue; its read-only says nothing of them.
        let functions = |names: &[&str], level: &str, of: StorageKey| StorageKey {
            functions: Some(names.iter().map(|name| name.to_string()).collect()),
            function_access: Some(level.into()),
            ..of
        };
        let invoker = functions(&["*"], "invoke", key(None, None, true));
        assert_eq!(columns(&invoker), ("-".into(), "-".into()));
        assert!(!invoker.reaches_storage());
        let writer = functions(&["orders", "thumbs"], "write", key(Some(&["photos"]), None, true));
        assert_eq!(
            [reaches(&invoker), reaches(&writer)],
            [
                "every function of the account, to invoke",
                "the bucket photos, read-only, and the functions orders, thumbs, to write"
            ]
        );
        assert_eq!(
            [functions_column(&invoker), functions_column(&writer), functions_column(&all)],
            ["all (invoke)", "orders,thumbs (write)", "-"]
        );
        // An API before queues says nothing of them: such a key reaches what its buckets say.
        let older: StorageKey = serde_json::from_value(json!({ "id": "AKFF7Q2MLKX4RTZB3W5N", "buckets": null, "readOnly": false, "createdAt": "x", "lastUsedAt": null })).unwrap();
        assert_eq!(reaches(&older), "every bucket and queue of the account");
    }

    #[test]
    fn a_key_is_named_by_its_own_name_and_its_id_or_its_id_alone() {
        let named = StorageKey { name: Some("ci-deploy".into()), ..key(None, None, false) };
        let by_id = StorageKey { name: Some("AKFF7Q2MLKX4RTZB3W5N".into()), ..key(None, None, false) };
        assert_eq!(
            [named.label(), by_id.label(), key(None, None, false).label()],
            ["ci-deploy (AKFF7Q2MLKX4RTZB3W5N)", "AKFF7Q2MLKX4RTZB3W5N", "AKFF7Q2MLKX4RTZB3W5N"]
        );
    }

    #[test]
    fn key_ids_are_ffs_and_names_an_iam_users() {
        assert!(is_key_id("AKFF7Q2MLKX4RTZB3W5N"));
        for id in ["AKIA7Q2MLKX4RTZB3W5N", "AKFF7Q2MLKX4RTZB3W5", "AKFF7Q2MLKX4RTZB3W51", "akff7q2mlkx4rtzb3w5n"] {
            assert!(!is_key_id(id), "{id}");
        }
        for name in ["ci+deploy@shop.tn", "a", "uploads_2026", "x=y,z.w-v", &"a".repeat(64)] {
            assert!(is_key_name(name), "{name}");
        }
        for name in ["", "my key", "clé", "a/b", "*", &"a".repeat(65)] {
            assert!(!is_key_name(name), "{name}");
        }
    }

    #[test]
    fn its_fields_rules_and_levels_are_the_apis() {
        let made = CreatedKey {
            key: key(None, None, false),
            secret_access_key: String::new(),
            endpoint: String::new(),
            sqs_endpoint: None,
            ses_endpoint: None,
            lambda_endpoint: None,
            region: String::new(),
        };
        let view = class_fields(DTO, "StorageKeyView");
        assert_eq!(sorted_keys(&made.key), sorted(view.clone()));
        assert_eq!(sorted_keys(&made), sorted([view, class_fields(DTO, "CreatedStorageKey")].concat()));
        assert_eq!(
            FunctionAccess::value_variants().iter().map(|level| level.as_str()).collect::<Vec<_>>(),
            listed(ENTITY, "FUNCTION_ACCESS")
        );
        assert!(ENTITY.contains(&format!("export const ALL_FUNCTIONS = '{ALL_FUNCTIONS}';")));
        // The API's rule for a name, which is_key_name follows: \w is ASCII's letters, digits and _.
        assert!(DTO.contains(r"KEY_NAME = /^[\w+=,.@-]{1,64}$/;"));
    }
}

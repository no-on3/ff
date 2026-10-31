//! `ff event-sources add|list|get|update|remove`: functions reading queues of their account, as AWS
//! Lambda's event source mappings for SQS: FF receives a queue's messages in batches and calls the
//! function with SQS's event, deleting what it handled. A queue and a function are named as people
//! name them; the API takes the queue's ARN, which it gives.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::Context;
use crate::api::types::{function_named, name_in_arn};
use crate::api::{Call, Client};
use crate::error::Error;
use crate::table::{table, time};

/// Lambda's ScalingConfig.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScalingConfig {
    pub(super) maximum_concurrency: u32,
}

/// A mapping, as the API answers it, in Lambda's names.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EventSource {
    uuid: String,
    pub(super) event_source_arn: String,
    function_arn: String,
    pub(super) batch_size: u32,
    pub(super) maximum_batching_window_in_seconds: u32,
    pub(super) function_response_types: Vec<String>,
    pub(super) scaling_config: Option<ScalingConfig>,
    pub(super) state: String,
    state_transition_reason: String,
    last_modified: String,
}

/// What `add` and `update` set, as their flags give them.
pub struct Settings<'a> {
    pub batch_size: Option<u32>,
    pub batching_window: Option<&'a str>,
    /// Some(true) for ReportBatchItemFailures, Some(false) for none, None to leave it.
    pub report_batch_item_failures: Option<bool>,
    /// Some(Some(n)) for a maximum, Some(None) for none, None to leave it.
    pub max_concurrency: Option<Option<u32>>,
    pub enabled: Option<bool>,
}

/// The body the flags give, checked before any call, by Lambda's names.
fn body_of(settings: &Settings) -> Result<Map<String, Value>, Error> {
    let mut body = Map::new();
    if let Some(size) = settings.batch_size {
        body.insert("batchSize".into(), json!(size));
    }
    if let Some(text) = settings.batching_window {
        body.insert(
            "maximumBatchingWindowInSeconds".into(),
            json!(super::queues::seconds("batching-window", text, 0, 300)?),
        );
    }
    if let Some(report) = settings.report_batch_item_failures {
        body.insert(
            "functionResponseTypes".into(),
            if report { json!(["ReportBatchItemFailures"]) } else { json!([]) },
        );
    }
    if let Some(maximum) = settings.max_concurrency {
        body.insert("scalingConfig".into(), maximum.map(|n| json!({ "maximumConcurrency": n })).unwrap_or(Value::Null));
    }
    if let Some(enabled) = settings.enabled {
        body.insert("enabled".into(), json!(enabled));
    }
    Ok(body)
}

/// A mapping in a sentence: who reads what, how, and whether it does.
fn text(mapping: &EventSource) -> String {
    let window = match mapping.maximum_batching_window_in_seconds {
        0 => "no window".to_owned(),
        1 => "a window of 1 second".to_owned(),
        seconds => format!("a window of {seconds} seconds"),
    };
    let failures = if mapping.function_response_types.iter().any(|kind| kind == "ReportBatchItemFailures") {
        "the answer naming the messages that failed"
    } else {
        "a call that fails keeping its whole batch"
    };
    let concurrency = match &mapping.scaling_config {
        Some(config) => format!("{} batches at once at most", config.maximum_concurrency),
        None => "as many batches at once as the function's instances".to_owned(),
    };
    let state = if mapping.state == "Enabled" { "reading" } else { "disabled: nothing read" };
    format!(
        "{} reads the queue {}: batches of {} at most, {window}, {failures}, {concurrency}; {state} ({})",
        name_in_arn(&mapping.function_arn),
        name_in_arn(&mapping.event_source_arn),
        mapping.batch_size,
        mapping.uuid
    )
}

fn rows(mappings: &[EventSource]) -> String {
    let rows: Vec<Vec<String>> = mappings
        .iter()
        .map(|mapping| {
            vec![
                mapping.uuid.clone(),
                name_in_arn(&mapping.event_source_arn).to_owned(),
                name_in_arn(&mapping.function_arn).to_owned(),
                mapping.batch_size.to_string(),
                format!("{}s", mapping.maximum_batching_window_in_seconds),
                if mapping.function_response_types.is_empty() { "batch" } else { "item" }.to_owned(),
                mapping
                    .scaling_config
                    .as_ref()
                    .map(|config| config.maximum_concurrency.to_string())
                    .unwrap_or_else(|| "-".to_owned()),
                mapping.state.clone(),
                time(&mapping.last_modified),
            ]
        })
        .collect();
    table(&["UUID", "QUEUE", "FUNCTION", "BATCH", "WINDOW", "FAILURES", "CONCURRENCY", "STATE", "CHANGED (UTC)"], &rows)
}

/// A mapping's ID as the API gives them: a UUID.
pub fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text
            .char_indices()
            .all(|(index, c)| if [8, 13, 18, 23].contains(&index) { c == '-' } else { c.is_ascii_hexdigit() })
}

fn checked_uuid(uuid: &str) -> Result<&str, Error> {
    if is_uuid(uuid) {
        Ok(uuid)
    } else {
        Err(Error::usage(format!(
            "\"{uuid}\" is no event source mapping's ID: a UUID, as `ff event-sources list` shows them"
        )))
    }
}

/// The ARN the API gives the account's queue of that name, which says so when the account has none.
fn queue_arn(client: &Client, queue: &str) -> Result<String, Error> {
    let found: Value = client.json(&Call::get(format!("/queues/{queue}")))?;
    Ok(found["arn"].as_str().unwrap_or_default().to_owned())
}

pub fn add(queue: &str, function: &str, settings: &Settings, context: &Context) -> Result<(), Error> {
    let queue = super::queues::checked_name(queue)?;
    let mut body = body_of(settings)?;
    let client = Client::new(&context.settings()?)?;
    let target = function_named(&client, function)?;
    body.insert("eventSourceArn".into(), json!(queue_arn(&client, queue)?));
    let made: EventSource =
        client.json(&Call::post(format!("/functions/{}/event-sources", target.id), Value::Object(body)))?;
    context.out.result(&made, || text(&made))
}

pub fn list(function: Option<&str>, queue: Option<&str>, context: &Context) -> Result<(), Error> {
    if let Some(queue) = queue {
        super::queues::checked_name(queue)?;
    }
    let client = Client::new(&context.settings()?)?;
    let mut mappings: Vec<EventSource> = match function {
        Some(name) => {
            client.json(&Call::get(format!("/functions/{}/event-sources", function_named(&client, name)?.id)))?
        }
        None => client.json(&Call::get("/event-sources"))?,
    };
    if let Some(queue) = queue {
        mappings.retain(|mapping| name_in_arn(&mapping.event_source_arn) == queue);
    }
    context.out.result(&mappings, || {
        if mappings.is_empty() {
            return "No function reads a queue here: `ff event-sources add <queue> <function>` has one read".to_owned();
        }
        rows(&mappings)
    })
}

pub fn get(uuid: &str, context: &Context) -> Result<(), Error> {
    let uuid = checked_uuid(uuid)?;
    let client = Client::new(&context.settings()?)?;
    let mapping: EventSource = client.json(&Call::get(format!("/event-sources/{uuid}")))?;
    context.out.result(&mapping, || format!("{}\nchanged  {} UTC", text(&mapping), time(&mapping.last_modified)))
}

pub fn update(uuid: &str, settings: &Settings, context: &Context) -> Result<(), Error> {
    let uuid = checked_uuid(uuid)?;
    let body = body_of(settings)?;
    if body.is_empty() {
        return Err(Error::usage(
            "Say what changes: --batch-size, --batching-window, --report-batch-item-failures or --no-report-batch-item-failures, \
             --max-concurrency or --no-max-concurrency, --enable or --disable",
        ));
    }
    let client = Client::new(&context.settings()?)?;
    let mapping: EventSource = client.json(&Call::patch(format!("/event-sources/{uuid}"), Value::Object(body)))?;
    context.out.result(&mapping, || text(&mapping))
}

pub fn remove(uuid: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let uuid = checked_uuid(uuid)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff event-sources remove",
        &format!("Stop the function reading the queue of mapping {uuid}? Its messages stay in the queue"),
        yes,
    )? {
        return context.out.result(&json!({ "removed": false, "uuid": uuid }), || "Nothing removed".to_owned());
    }
    client.done(&Call::delete(format!("/event-sources/{uuid}")))?;
    context.out.result(&json!({ "removed": true, "uuid": uuid }), || {
        format!("removed the mapping {uuid}: the queue's messages stay")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_source::{class_fields, sorted, sorted_keys};

    fn settings() -> Settings<'static> {
        Settings {
            batch_size: None,
            batching_window: None,
            report_batch_item_failures: None,
            max_concurrency: None,
            enabled: None,
        }
    }

    fn mapping() -> EventSource {
        serde_json::from_value(json!({
            "uuid": "6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70",
            "eventSourceArn": "arn:aws:sqs:tn-tunis-1:000000000001:orders",
            "functionArn": "arn:aws:lambda:tn-tunis-1:000000000001:function:orders-worker",
            "batchSize": 10,
            "maximumBatchingWindowInSeconds": 0,
            "functionResponseTypes": [],
            "scalingConfig": null,
            "state": "Enabled",
            "stateTransitionReason": "USER_INITIATED",
            "lastModified": "2026-10-24T08:00:00.000Z"
        }))
        .unwrap()
    }

    #[test]
    fn the_flags_give_lambdas_settings_and_a_window_is_held_to_its_range_first() {
        let given = Settings {
            batch_size: Some(100),
            batching_window: Some("5s"),
            report_batch_item_failures: Some(true),
            max_concurrency: Some(Some(2)),
            enabled: Some(false),
        };
        assert_eq!(
            Value::Object(body_of(&given).unwrap()),
            json!({ "batchSize": 100, "maximumBatchingWindowInSeconds": 5, "functionResponseTypes": ["ReportBatchItemFailures"], "scalingConfig": { "maximumConcurrency": 2 }, "enabled": false })
        );
        let removing = Settings { report_batch_item_failures: Some(false), max_concurrency: Some(None), ..settings() };
        assert_eq!(
            Value::Object(body_of(&removing).unwrap()),
            json!({ "functionResponseTypes": [], "scalingConfig": null })
        );
        let too_long = Settings { batching_window: Some("6m"), ..settings() };
        assert_eq!(
            body_of(&too_long).unwrap_err().message,
            "--batching-window takes whole seconds from 0s to 5m, such as 30s, 15m or 4d"
        );
        assert!(body_of(&settings()).unwrap().is_empty());
    }

    #[test]
    fn a_mapping_reads_as_a_sentence() {
        assert_eq!(
            text(&mapping()),
            "orders-worker reads the queue orders: batches of 10 at most, no window, a call that fails keeping its whole batch, \
             as many batches at once as the function's instances; reading (6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70)"
        );
        let mut tuned = mapping();
        tuned.batch_size = 100;
        tuned.maximum_batching_window_in_seconds = 5;
        tuned.function_response_types = vec!["ReportBatchItemFailures".into()];
        tuned.scaling_config = Some(ScalingConfig { maximum_concurrency: 2 });
        tuned.state = "Disabled".into();
        assert_eq!(
            text(&tuned),
            "orders-worker reads the queue orders: batches of 100 at most, a window of 5 seconds, the answer naming the messages that failed, \
             2 batches at once at most; disabled: nothing read (6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70)"
        );
    }

    #[test]
    fn mapping_ids_are_uuids() {
        assert!(is_uuid("6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70"));
        for refused in [
            "orders",
            "6c2a1e8b7d4c4a9e8f1a2b3c4d5e6f70",
            "6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f7z",
            "6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f7",
        ] {
            assert!(!is_uuid(refused), "{refused}");
        }
        assert_eq!(checked_uuid("orders").unwrap_err().exit_code(), 2);
    }

    #[test]
    fn what_ff_reads_has_the_apis_fields() {
        let source = include_str!("../../../BE/src/event-sources/dto/event-source.dto.ts");
        assert_eq!(sorted_keys(&mapping()), sorted(class_fields(source, "EventSourceView")));
    }
}

//! `ff buckets notify <bucket> <function>|--queue <queue>` and `ff buckets notifications <bucket>`: a
//! bucket's notifications, as S3's: the events of its objects that run a function of the account,
//! called without waiting with S3's event, or put a message in a queue of it. The API keeps S3's
//! configuration whole: ff reads it, changes it, and puts it back.

use serde_json::{Map, Value, json};

use super::Context;
use crate::api::types::name_in_arn;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::table;

/// S3's event types a bucket of FF's sends, as the API takes them.
pub const EVENT_TYPES: [&str; 8] = [
    "s3:ObjectCreated:*",
    "s3:ObjectCreated:Put",
    "s3:ObjectCreated:Post",
    "s3:ObjectCreated:Copy",
    "s3:ObjectCreated:CompleteMultipartUpload",
    "s3:ObjectRemoved:*",
    "s3:ObjectRemoved:Delete",
    "s3:ObjectRemoved:DeleteMarkerCreated",
];

/// Where a new configuration's events go.
pub enum Destination<'a> {
    Function(&'a str),
    Queue(&'a str),
}

/// What `ff buckets notify` adds.
pub struct NewConfiguration<'a> {
    pub destination: Destination<'a>,
    pub events: &'a [String],
    pub prefix: Option<&'a str>,
    pub suffix: Option<&'a str>,
    pub id: Option<&'a str>,
}

/// One configuration of the API's answer, as `(id, events, filter, destination)` in words.
fn row_of(configuration: &Value, queue: bool) -> Vec<String> {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let events: Vec<String> =
        configuration["events"].as_array().map(|events| events.iter().map(text).collect()).unwrap_or_default();
    let filter: Vec<String> = configuration
        .pointer("/filter/key/filterRules")
        .and_then(Value::as_array)
        .map(|rules| rules.iter().map(|rule| format!("{} {}", text(&rule["name"]), text(&rule["value"]))).collect())
        .unwrap_or_default();
    let arn = text(if queue { &configuration["queueArn"] } else { &configuration["lambdaFunctionArn"] });
    vec![
        text(&configuration["id"]),
        events.join(","),
        if filter.is_empty() { "every key".to_owned() } else { filter.join(", ") },
        format!("{} {}", if queue { "queue" } else { "function" }, name_in_arn(&arn)),
    ]
}

/// The configuration as rows, the functions' first, then the queues'.
fn rows(configuration: &Value) -> Vec<Vec<String>> {
    let list = |field: &str| configuration[field].as_array().cloned().unwrap_or_default();
    list("lambdaFunctionConfigurations")
        .iter()
        .map(|item| row_of(item, false))
        .chain(list("queueConfigurations").iter().map(|item| row_of(item, true)))
        .collect()
}

/// The new configuration as the API takes it: the destination by its name, which the API keeps as its ARN.
fn configuration_of(new: &NewConfiguration) -> Result<(String, Value), Error> {
    for event in new.events {
        if !EVENT_TYPES.contains(&event.as_str()) {
            return Err(Error::usage(format!("\"{event}\" is no event a bucket sends: {}", EVENT_TYPES.join(", "))));
        }
    }
    let events: Vec<&str> = if new.events.is_empty() {
        vec!["s3:ObjectCreated:*"]
    } else {
        new.events.iter().map(String::as_str).collect()
    };
    let mut configuration = Map::new();
    if let Some(id) = new.id {
        configuration.insert("id".into(), json!(id));
    }
    let field = match new.destination {
        Destination::Function(name) => {
            configuration.insert("lambdaFunctionArn".into(), json!(name));
            "lambdaFunctionConfigurations"
        }
        Destination::Queue(name) => {
            super::queues::checked_name(name)?;
            configuration.insert("queueArn".into(), json!(name));
            "queueConfigurations"
        }
    };
    configuration.insert("events".into(), json!(events));
    let rules: Vec<Value> = [("prefix", new.prefix), ("suffix", new.suffix)]
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| json!({ "name": name, "value": value })))
        .collect();
    if !rules.is_empty() {
        configuration.insert("filter".into(), json!({ "key": { "filterRules": rules } }));
    }
    Ok((field.to_owned(), Value::Object(configuration)))
}

fn path(bucket: &str) -> String {
    format!("/buckets/{bucket}/notifications")
}

pub fn notify(bucket: &str, new: &NewConfiguration, context: &Context) -> Result<(), Error> {
    let bucket = super::buckets::checked_name(bucket)?;
    let (field, configuration) = configuration_of(new)?;
    let client = Client::new(&context.settings()?)?;
    let mut current: Value = client.json(&Call::get(path(bucket)))?;
    match current[field.as_str()].as_array_mut() {
        Some(list) => list.push(configuration),
        None => current[field.as_str()] = json!([configuration]),
    }
    let saved: Value = client.json(&Call::put(path(bucket), current))?;
    context
        .out
        .result(&saved, || format!("{bucket} now sends:\n{}", table(&["ID", "EVENTS", "KEYS", "TO"], &rows(&saved))))
}

pub fn list(bucket: &str, context: &Context) -> Result<(), Error> {
    let bucket = super::buckets::checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    let configuration: Value = client.json(&Call::get(path(bucket)))?;
    context.out.result(&configuration, || {
        let rows = rows(&configuration);
        if rows.is_empty() {
            return format!("{bucket} sends no event: `ff buckets notify {bucket} <function>` has it run one");
        }
        table(&["ID", "EVENTS", "KEYS", "TO"], &rows)
    })
}

pub fn remove(bucket: &str, id: &str, context: &Context) -> Result<(), Error> {
    let bucket = super::buckets::checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    let mut configuration: Value = client.json(&Call::get(path(bucket)))?;
    let mut found = false;
    for field in ["lambdaFunctionConfigurations", "queueConfigurations"] {
        if let Some(list) = configuration[field].as_array_mut() {
            let before = list.len();
            list.retain(|item| item["id"].as_str() != Some(id));
            found |= list.len() != before;
        }
    }
    if !found {
        return Err(Error::new(
            Kind::Failed,
            format!("{bucket} has no notification configuration {id}: `ff buckets notifications {bucket}` lists them"),
        ));
    }
    let saved: Value = client.json(&Call::put(path(bucket), configuration))?;
    context.out.result(&saved, || format!("removed {id}: {bucket} sends its events no more"))
}

pub fn clear(bucket: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let bucket = super::buckets::checked_name(bucket)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff buckets notifications --clear",
        &format!("Stop every notification of {bucket}?"),
        yes,
    )? {
        return context.out.result(&json!({ "cleared": false, "bucket": bucket }), || "Nothing changed".to_owned());
    }
    let saved: Value = client.json(&Call::put(path(bucket), json!({})))?;
    context.out.result(&saved, || format!("{bucket} sends no event any more"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_source::listed;

    #[test]
    fn a_new_configuration_names_its_destination_and_s3s_events_a_filter_when_given() {
        let events = vec!["s3:ObjectRemoved:*".to_owned()];
        let new = NewConfiguration {
            destination: Destination::Queue("removals"),
            events: &events,
            prefix: Some("images/"),
            suffix: None,
            id: Some("r"),
        };
        assert_eq!(
            configuration_of(&new).unwrap(),
            (
                "queueConfigurations".to_owned(),
                json!({ "id": "r", "queueArn": "removals", "events": ["s3:ObjectRemoved:*"], "filter": { "key": { "filterRules": [{ "name": "prefix", "value": "images/" }] } } })
            )
        );
        let created = NewConfiguration {
            destination: Destination::Function("thumbnails"),
            events: &[],
            prefix: None,
            suffix: None,
            id: None,
        };
        assert_eq!(
            configuration_of(&created).unwrap(),
            (
                "lambdaFunctionConfigurations".to_owned(),
                json!({ "lambdaFunctionArn": "thumbnails", "events": ["s3:ObjectCreated:*"] })
            )
        );
        let wrong = vec!["s3:ObjectTagging:*".to_owned()];
        let refused = NewConfiguration {
            destination: Destination::Function("thumbnails"),
            events: &wrong,
            prefix: None,
            suffix: None,
            id: None,
        };
        assert_eq!(configuration_of(&refused).unwrap_err().exit_code(), 2);
    }

    #[test]
    fn a_configuration_reads_as_rows_its_destination_by_name() {
        let configuration = json!({
            "lambdaFunctionConfigurations": [{ "id": "thumbs", "lambdaFunctionArn": "arn:aws:lambda:tn-tunis-1:000000000001:function:thumbnails", "events": ["s3:ObjectCreated:*"],
                "filter": { "key": { "filterRules": [{ "name": "prefix", "value": "images/" }, { "name": "suffix", "value": ".jpg" }] } } }],
            "queueConfigurations": [{ "id": "removals", "queueArn": "arn:aws:sqs:tn-tunis-1:000000000001:removals", "events": ["s3:ObjectRemoved:*"] }]
        });
        assert_eq!(
            rows(&configuration),
            vec![
                vec![
                    "thumbs".to_owned(),
                    "s3:ObjectCreated:*".to_owned(),
                    "prefix images/, suffix .jpg".to_owned(),
                    "function thumbnails".to_owned()
                ],
                vec![
                    "removals".to_owned(),
                    "s3:ObjectRemoved:*".to_owned(),
                    "every key".to_owned(),
                    "queue removals".to_owned()
                ],
            ]
        );
    }

    #[test]
    fn the_events_are_the_apis() {
        let source = include_str!("../../../BE/src/storage/bucket-notifications.ts");
        assert_eq!(listed(source, "EVENT_TYPES"), EVENT_TYPES);
    }
}

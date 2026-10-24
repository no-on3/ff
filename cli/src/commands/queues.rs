//! `ff queues create|list|get|set|send|receive|delete-message|purge|delete`: the account's queues, as
//! Amazon SQS's standard queues, through FF's API, which runs SQS's own operations: AWS's SDKs and CLI
//! see the same queues at FF's SQS endpoint, with a key of `ff buckets keys create`. Sending,
//! receiving and deleting a message are there to debug a queue, or for a script.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::Context;
use crate::api::{Call, Client};
use crate::cli::QueueAttributeArgs;
use crate::error::{Error, Kind};
use crate::table::{table, time};

/// A queue's messages, as SQS counts them: roughly, at the moment it was asked.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Messages {
    available: u64,
    in_flight: u64,
    delayed: u64,
}

/// Where a queue's messages go after too many receives.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RedrivePolicy {
    dead_letter_target_arn: String,
    max_receive_count: u32,
}

/// A queue, as `GET /queues` and `GET /queues/:name` answer it: SQS's attributes by their names, in seconds and bytes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Queue {
    name: String,
    url: String,
    arn: String,
    visibility_timeout: u64,
    message_retention_period: u64,
    delay_seconds: u64,
    maximum_message_size: u64,
    receive_message_wait_time_seconds: u64,
    redrive_policy: Option<RedrivePolicy>,
    messages: Messages,
    size_bytes: u64,
    created_at: String,
    updated_at: String,
}

/// A message attribute: a string or a number as text, or bytes in base64.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageAttribute {
    data_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    string_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binary_value: Option<String>,
}

/// A message received, as `POST /queues/:name/receive` answers it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Received {
    message_id: String,
    receipt_handle: String,
    body: String,
    #[serde(default)]
    attributes: BTreeMap<String, MessageAttribute>,
    receive_count: u64,
    sender_id: String,
    sent_at: String,
    /// Whether `--delete` deleted it: then it isn't received again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted: Option<bool>,
}

fn usage(message: impl Into<String>) -> Error {
    Error::new(Kind::Usage, message)
}

/// SQS's rule for a standard queue's name, as the API's: 1 to 80 letters, digits, hyphens and underscores.
pub fn is_queue_name(name: &str) -> bool {
    (1..=80).contains(&name.len())
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn checked_name(name: &str) -> Result<&str, Error> {
    if name.ends_with(".fifo") {
        return Err(usage(format!(
            "\"{name}\" is a FIFO queue's name: FF's queues are standard queues, and FIFO queues come later"
        )));
    }
    if is_queue_name(name) {
        Ok(name)
    } else {
        Err(usage(format!(
            "\"{name}\" can't be a queue's name: 1 to 80 letters, digits, hyphens and underscores, as SQS names queues"
        )))
    }
}

/// A number of seconds in its largest whole unit, as a flag takes it: 0s, 30s, 15m, 12h, 4d.
fn short(seconds: u64) -> String {
    match seconds {
        0 => "0s".to_owned(),
        s if s % 86_400 == 0 => format!("{}d", s / 86_400),
        s if s % 3600 == 0 => format!("{}h", s / 3600),
        s if s % 60 == 0 => format!("{}m", s / 60),
        s => format!("{s}s"),
    }
}

/// A number of seconds as people read it: days, hours or minutes when it is whole ones, else seconds.
fn words(seconds: u64) -> String {
    let plural = |n: u64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    match seconds {
        0 => "0 seconds".to_owned(),
        s if s % 86_400 == 0 => plural(s / 86_400, "day"),
        s if s % 3600 == 0 => plural(s / 3600, "hour"),
        s if s % 60 == 0 => plural(s / 60, "minute"),
        s => plural(s, "second"),
    }
}

/// A duration flag, in whole seconds from `min` to `max`: a number of seconds, or a duration such as 30s, 15m or 4d.
pub fn seconds(flag: &str, text: &str, min: u64, max: u64) -> Result<u64, Error> {
    let refused =
        || usage(format!("--{flag} takes whole seconds from {} to {}, such as 30s, 15m or 4d", short(min), short(max)));
    let duration = match text.parse::<u64>() {
        Ok(seconds) => Duration::from_secs(seconds),
        Err(_) => humantime::parse_duration(text).map_err(|_| refused())?,
    };
    if duration.subsec_nanos() != 0 || !(min..=max).contains(&duration.as_secs()) {
        return Err(refused());
    }
    Ok(duration.as_secs())
}

/// What a queue's messages hold, as people read it: bytes, KB under a megabyte, then MB as `ff db` says sizes.
fn bytes(size: u64) -> String {
    match size {
        1 => "1 byte".to_owned(),
        s if s < 1024 => format!("{s} bytes"),
        s if s < 1_048_576 => {
            let kb = (s as f64 / 1024.0 * 10.0).round() / 10.0;
            if kb.fract() == 0.0 { format!("{kb:.0} KB") } else { format!("{kb:.1} KB") }
        }
        s => super::db::size(Some(s)),
    }
}

/// The name an ARN ends with: arn:aws:sqs:<region>:<account>:<name>.
fn name_of(arn: &str) -> &str {
    arn.rsplit(':').next().unwrap_or(arn)
}

/// The SQS endpoint a queue's URL is under, which AWS_ENDPOINT_URL_SQS names: its scheme and host.
fn endpoint_of(url: &str) -> String {
    url.splitn(4, '/').take(3).collect::<Vec<_>>().join("/")
}

/// A queue's messages, in a few words: those in flight and delayed when there are some.
fn messages_text(messages: &Messages) -> String {
    let mut parts = vec![format!("{} waiting", messages.available)];
    if messages.in_flight > 0 {
        parts.push(format!("{} in flight", messages.in_flight));
    }
    if messages.delayed > 0 {
        parts.push(format!("{} delayed", messages.delayed));
    }
    parts.join(", ")
}

/// Where the queue is reached: its URL, its ARN for a function's destination, and the endpoint AWS's tools take.
fn reach(queue: &Queue) -> String {
    format!(
        "url                 {}\narn                 {}\nendpoint            {} (AWS_ENDPOINT_URL_SQS)",
        queue.url,
        queue.arn,
        endpoint_of(&queue.url)
    )
}

/// SQS's attributes of the queue, in words.
fn attributes_text(queue: &Queue) -> String {
    let dead_letters = match &queue.redrive_policy {
        Some(policy) => format!(
            "to {} after {} receive{}",
            name_of(&policy.dead_letter_target_arn),
            policy.max_receive_count,
            if policy.max_receive_count == 1 { "" } else { "s" }
        ),
        None => "none: a message is received until it is deleted or its retention ends".to_owned(),
    };
    format!(
        "visibility timeout  {}\nretention           {}\ndelivery delay      {}\nreceive wait        {}\nlargest message     {} bytes\ndead letters        {dead_letters}",
        words(queue.visibility_timeout),
        words(queue.message_retention_period),
        words(queue.delay_seconds),
        words(queue.receive_message_wait_time_seconds),
        queue.maximum_message_size
    )
}

/// The attributes the flags give, as the API names them, checked before any call: the dead-letter queue comes from
/// `redrive_policy`, which looks it up.
fn attributes_body(name: &str, args: &QueueAttributeArgs) -> Result<Map<String, Value>, Error> {
    let mut body = Map::new();
    let durations = [
        ("visibilityTimeout", "visibility-timeout", &args.visibility_timeout, 0, 43_200),
        ("messageRetentionPeriod", "retention", &args.retention, 60, 1_209_600),
        ("delaySeconds", "delay", &args.delay, 0, 900),
        ("receiveMessageWaitTimeSeconds", "receive-wait", &args.receive_wait, 0, 20),
    ];
    for (field, flag, text, min, max) in durations {
        if let Some(text) = text {
            body.insert(field.to_owned(), json!(seconds(flag, text, min, max)?));
        }
    }
    if let Some(size) = args.max_message_size {
        body.insert("maximumMessageSize".to_owned(), json!(size));
    }
    if let Some(dead_letter_queue) = &args.dead_letter_queue
        && checked_name(dead_letter_queue)? == name
    {
        return Err(usage("A queue can't be its own dead-letter queue"));
    }
    Ok(body)
}

/// The redrive policy `--dead-letter-queue` names: that queue of the account's by the ARN the API answers for it, which
/// says so when the account has none of that name.
fn redrive_policy(client: &Client, args: &QueueAttributeArgs) -> Result<Option<Value>, Error> {
    let Some(dead_letter_queue) = &args.dead_letter_queue else { return Ok(None) };
    let target: Queue = client.json(&Call::get(format!("/queues/{dead_letter_queue}")))?;
    Ok(Some(json!({ "deadLetterTargetArn": target.arn, "maxReceiveCount": args.max_receive_count.unwrap_or(5) })))
}

pub fn create(name: &str, args: &QueueAttributeArgs, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let mut body = attributes_body(name, args)?;
    let client = Client::new(&context.settings()?)?;
    if let Some(policy) = redrive_policy(&client, args)? {
        body.insert("redrivePolicy".to_owned(), policy);
    }
    body.insert("name".to_owned(), json!(name));
    let queue: Queue = client.json(&Call::post("/queues", Value::Object(body)))?;
    context.out.result(&queue, || {
        format!(
            "{} made\n{}\n`ff buckets keys create --queue {}` makes an access key for AWS's SDKs and CLI",
            queue.name,
            reach(&queue),
            queue.name
        )
    })
}

pub fn list(context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let queues: Vec<Queue> = client.json(&Call::get("/queues"))?;
    context.out.result(&queues, || {
        if queues.is_empty() {
            return "The account has no queue: `ff queues create <name>` makes one".to_owned();
        }
        let rows: Vec<Vec<String>> = queues
            .iter()
            .map(|queue| {
                vec![
                    queue.name.clone(),
                    queue.messages.available.to_string(),
                    queue.messages.in_flight.to_string(),
                    queue.messages.delayed.to_string(),
                    bytes(queue.size_bytes),
                    queue
                        .redrive_policy
                        .as_ref()
                        .map(|policy| name_of(&policy.dead_letter_target_arn))
                        .unwrap_or("-")
                        .to_owned(),
                    time(&queue.created_at),
                ]
            })
            .collect();
        table(&["NAME", "WAITING", "IN FLIGHT", "DELAYED", "HOLDING", "DEAD LETTERS TO", "CREATED (UTC)"], &rows)
    })
}

pub fn get(name: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    let queue: Queue = client.json(&Call::get(format!("/queues/{name}")))?;
    context.out.result(&queue, || {
        format!(
            "{}\nmessages            {}\nholding             {}\n{}\n{}\ncreated             {} UTC",
            queue.name,
            messages_text(&queue.messages),
            bytes(queue.size_bytes),
            reach(&queue),
            attributes_text(&queue),
            time(&queue.created_at)
        )
    })
}

pub fn set(name: &str, args: &QueueAttributeArgs, no_dead_letter_queue: bool, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let mut body = attributes_body(name, args)?;
    if body.is_empty() && args.dead_letter_queue.is_none() && !no_dead_letter_queue {
        return Err(usage(
            "Say what changes: --visibility-timeout, --retention, --delay, --receive-wait, --max-message-size, \
             --dead-letter-queue or --no-dead-letter-queue",
        ));
    }
    let client = Client::new(&context.settings()?)?;
    if let Some(policy) = redrive_policy(&client, args)? {
        body.insert("redrivePolicy".to_owned(), policy);
    }
    if no_dead_letter_queue {
        body.insert("redrivePolicy".to_owned(), Value::Null);
    }
    let queue: Queue = client.json(&Call::patch(format!("/queues/{name}"), Value::Object(body)))?;
    context.out.result(&queue, || format!("{} changed\n{}", queue.name, attributes_text(&queue)))
}

/// `--attribute NAME=VALUE`, as SQS's String message attributes.
fn message_attributes(attributes: &[String]) -> Result<Map<String, Value>, Error> {
    let mut map = Map::new();
    for attribute in attributes {
        let Some((key, value)) = attribute.split_once('=').filter(|(key, _)| !key.is_empty()) else {
            return Err(usage(format!("--attribute takes NAME=VALUE: \"{attribute}\" has no name, or no =")));
        };
        map.insert(key.to_owned(), json!({ "dataType": "String", "stringValue": value }));
    }
    Ok(map)
}

pub fn send(
    name: &str,
    body: &str,
    delay: Option<&str>,
    attributes: &[String],
    context: &Context,
) -> Result<(), Error> {
    let name = checked_name(name)?;
    let delay = delay.map(|text| seconds("delay", text, 0, 900)).transpose()?;
    let attributes = message_attributes(attributes)?;
    let text = String::from_utf8(super::invoke::raw_data(body)?)
        .map_err(|_| usage("A message's body is text, and this one isn't UTF-8: base64 it first"))?;
    let client = Client::new(&context.settings()?)?;
    let mut request = json!({ "body": text });
    if let Some(delay) = delay {
        request["delaySeconds"] = json!(delay);
    }
    if !attributes.is_empty() {
        request["attributes"] = Value::Object(attributes);
    }
    let sent: Value = client.json(&Call::post(format!("/queues/{name}/messages"), request))?;
    context.out.result(&sent, || format!("sent {} to {name}", sent["messageId"].as_str().unwrap_or_default()))
}

/// A message attribute as people read it: NAME=value, or the size of its bytes.
fn attribute_text(name: &str, attribute: &MessageAttribute) -> String {
    match (&attribute.string_value, &attribute.binary_value) {
        (Some(value), _) => format!("{name}={value} ({})", attribute.data_type),
        (None, Some(base64)) => format!("{name}=<{} characters of base64> ({})", base64.len(), attribute.data_type),
        (None, None) => format!("{name} ({})", attribute.data_type),
    }
}

/// The messages received, each with what SQS says of it, then its body.
fn received_text(name: &str, messages: &[Received]) -> String {
    if messages.is_empty() {
        return format!("No message: {name} had none to give within the wait");
    }
    let each: Vec<String> = messages
        .iter()
        .map(|message| {
            let mut lines = vec![format!(
                "message {}, received {} time{}, sent {} UTC by {}",
                message.message_id,
                message.receive_count,
                if message.receive_count == 1 { "" } else { "s" },
                time(&message.sent_at),
                message.sender_id
            )];
            lines.extend(
                message
                    .attributes
                    .iter()
                    .map(|(attribute, value)| format!("attribute {}", attribute_text(attribute, value))),
            );
            lines.push(if message.deleted == Some(true) {
                "deleted".to_owned()
            } else {
                format!("handle {}", message.receipt_handle)
            });
            lines.push(message.body.clone());
            lines.join("\n")
        })
        .collect();
    each.join("\n\n")
}

pub fn receive(
    name: &str,
    max: u8,
    wait: Option<&str>,
    visibility_timeout: Option<&str>,
    delete: bool,
    context: &Context,
) -> Result<(), Error> {
    let name = checked_name(name)?;
    let wait = wait.map(|text| seconds("wait", text, 0, 20)).transpose()?;
    let visibility_timeout =
        visibility_timeout.map(|text| seconds("visibility-timeout", text, 0, 43_200)).transpose()?;
    let client = Client::new(&context.settings()?)?;
    let mut request = json!({ "maxMessages": max });
    if let Some(wait) = wait {
        request["waitTimeSeconds"] = json!(wait);
    }
    if let Some(visibility_timeout) = visibility_timeout {
        request["visibilityTimeout"] = json!(visibility_timeout);
    }
    // A long poll waits 20 s at most, the queue's own receive wait among them.
    let call = Call::post(format!("/queues/{name}/receive"), request).timeout(Duration::from_secs(60));
    let mut messages: Vec<Received> = client.json(&call)?;
    if delete {
        for message in &mut messages {
            client.done(&Call::delete(format!("/queues/{name}/messages/{}", message.receipt_handle)))?;
            message.deleted = Some(true);
        }
    }
    context.out.result(&messages, || received_text(name, &messages))
}

/// A receipt handle as FF gives them: base64url.
pub fn is_receipt_handle(handle: &str) -> bool {
    !handle.is_empty() && handle.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn delete_message(name: &str, receipt_handle: &str, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    if !is_receipt_handle(receipt_handle) {
        return Err(usage(format!(
            "\"{receipt_handle}\" is no receipt handle of FF's: copy one from `ff queues receive`"
        )));
    }
    let client = Client::new(&context.settings()?)?;
    client.done(&Call::delete(format!("/queues/{name}/messages/{receipt_handle}")))?;
    context.out.result(&json!({ "deleted": true, "name": name, "receiptHandle": receipt_handle }), || {
        format!("deleted from {name} the message that handle received, if that was its last receive")
    })
}

pub fn purge(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff queues purge",
        &format!("Delete every message of the queue {name}? Nothing can bring them back"),
        yes,
    )? {
        return context.out.result(&json!({ "purged": false, "name": name }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::post(format!("/queues/{name}/purge"), json!({})))?;
    context.out.result(&json!({ "purged": true, "name": name }), || format!("deleted every message of {name}"))
}

pub fn delete(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let name = checked_name(name)?;
    let client = Client::new(&context.settings()?)?;
    if !super::functions::confirmed(
        "ff queues delete",
        &format!("Delete the queue {name}, with its messages? Nothing can bring them back"),
        yes,
    )? {
        return context.out.result(&json!({ "deleted": false, "name": name }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/queues/{name}")))?;
    context.out.result(&json!({ "deleted": true, "name": name }), || format!("deleted the queue {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attributes() -> QueueAttributeArgs {
        QueueAttributeArgs {
            visibility_timeout: None,
            retention: None,
            delay: None,
            receive_wait: None,
            max_message_size: None,
            dead_letter_queue: None,
            max_receive_count: None,
        }
    }

    fn queue() -> Queue {
        serde_json::from_value(json!({
            "name": "orders",
            "url": "https://sqs.ffunc.tn/000000000001/orders",
            "arn": "arn:aws:sqs:tn-tunis-1:000000000001:orders",
            "visibilityTimeout": 30,
            "messageRetentionPeriod": 345_600,
            "delaySeconds": 0,
            "maximumMessageSize": 1_048_576,
            "receiveMessageWaitTimeSeconds": 20,
            "redrivePolicy": { "deadLetterTargetArn": "arn:aws:sqs:tn-tunis-1:000000000001:orders-dlq", "maxReceiveCount": 3 },
            "messages": { "available": 3, "inFlight": 1, "delayed": 0 },
            "sizeBytes": 2048,
            "createdAt": "2026-10-24T08:00:00.000Z",
            "updatedAt": "2026-10-24T08:00:00.000Z"
        }))
        .unwrap()
    }

    /// The fields a class of the API's queue DTOs declares, in its order.
    fn api_fields(class: &str) -> Vec<String> {
        let source = include_str!("../../../BE/src/queues/dto/queue.dto.ts");
        let start = source.find(&format!("export class {class} ")).unwrap_or_else(|| panic!("no class {class}"));
        let body = &source[start..];
        body[..body.find("\n}").unwrap()]
            .lines()
            .skip(1)
            .filter_map(|line| line.strip_prefix("  "))
            .filter(|line| !line.starts_with(['@', ' ', '}', '/', '*', ')']))
            .filter_map(|line| line.split([':', '?']).next())
            .map(str::to_owned)
            .collect()
    }

    /// The fields a value of ff's own serializes with, sorted.
    fn sorted_keys(value: &impl Serialize) -> Vec<String> {
        let mut keys: Vec<String> = serde_json::to_value(value).unwrap().as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    fn sorted(mut fields: Vec<String>) -> Vec<String> {
        fields.sort();
        fields
    }

    #[test]
    fn what_ff_reads_and_sends_has_the_apis_fields() {
        let queue = queue();
        assert_eq!(sorted_keys(&queue), sorted(api_fields("QueueView")));
        assert_eq!(sorted_keys(&queue.messages), sorted(api_fields("QueueMessagesView")));
        assert_eq!(sorted_keys(queue.redrive_policy.as_ref().unwrap()), sorted(api_fields("RedrivePolicyDto")));
        let attribute = MessageAttribute {
            data_type: "String".into(),
            string_value: Some("a".into()),
            binary_value: Some("AA==".into()),
        };
        assert_eq!(sorted_keys(&attribute), sorted(api_fields("MessageAttributeDto")));
        let received = Received {
            message_id: "m".into(),
            receipt_handle: "h".into(),
            body: "b".into(),
            attributes: BTreeMap::new(),
            receive_count: 1,
            sender_id: "s".into(),
            sent_at: "t".into(),
            deleted: None,
        };
        assert_eq!(sorted_keys(&received), sorted(api_fields("ReceivedMessageView")));

        // The bodies: every attribute's flag, a dead-letter queue's policy, and a message's and a receive's fields.
        let mut args = attributes();
        args.receive_wait = Some("10s".into());
        for flag in [&mut args.visibility_timeout, &mut args.retention, &mut args.delay] {
            *flag = Some("10m".into());
        }
        args.max_message_size = Some(2048);
        let mut body = attributes_body("orders", &args).unwrap();
        body.insert("redrivePolicy".into(), Value::Null);
        assert_eq!(sorted_keys(&body), sorted(api_fields("QueueAttributesDto")));
        assert_eq!(api_fields("CreateQueueDto"), ["name"]);
        assert_eq!(
            sorted(vec!["body".into(), "attributes".into(), "delaySeconds".into()]),
            sorted(api_fields("SendMessageDto"))
        );
        assert_eq!(
            sorted(vec!["maxMessages".into(), "waitTimeSeconds".into(), "visibilityTimeout".into()]),
            sorted(api_fields("ReceiveMessagesDto"))
        );
    }

    #[test]
    fn names_follow_sqs_for_standard_queues_as_the_api_does() {
        for name in ["orders", "A", "orders_2-eu", &"q".repeat(80)] {
            assert!(checked_name(name).is_ok(), "{name}");
        }
        for name in ["", "with space", "orders.v2", "é", &"q".repeat(81)] {
            assert!(checked_name(name).unwrap_err().message.contains("can't be a queue's name"), "{name}");
        }
        let fifo = checked_name("orders.fifo").unwrap_err();
        assert_eq!((fifo.exit_code(), fifo.message.contains("FIFO queues come later")), (2, true));
    }

    #[test]
    fn durations_are_whole_seconds_within_sqss_bounds_as_numbers_or_with_units() {
        assert_eq!(seconds("visibility-timeout", "30", 0, 43_200).unwrap(), 30);
        assert_eq!(seconds("visibility-timeout", "12h", 0, 43_200).unwrap(), 43_200);
        assert_eq!(seconds("retention", "14d", 60, 1_209_600).unwrap(), 1_209_600);
        assert_eq!(seconds("delay", "15m", 0, 900).unwrap(), 900);
        for refused in ["43201", "13h", "1.5s", "soon", "-1"] {
            let error = seconds("visibility-timeout", refused, 0, 43_200).unwrap_err();
            assert_eq!(
                (error.exit_code(), error.message.as_str()),
                (2, "--visibility-timeout takes whole seconds from 0s to 12h, such as 30s, 15m or 4d"),
                "{refused}"
            );
        }
        assert_eq!(
            seconds("retention", "59s", 60, 1_209_600).unwrap_err().message,
            "--retention takes whole seconds from 1m to 14d, such as 30s, 15m or 4d"
        );
    }

    #[test]
    fn the_flags_give_the_apis_attributes_and_a_queue_is_not_its_own_dead_letter_queue() {
        let mut args = attributes();
        args.visibility_timeout = Some("1m".into());
        args.retention = Some("1d".into());
        args.receive_wait = Some("20s".into());
        args.max_message_size = Some(262_144);
        args.dead_letter_queue = Some("orders-dlq".into());
        assert_eq!(
            Value::Object(attributes_body("orders", &args).unwrap()),
            json!({ "visibilityTimeout": 60, "messageRetentionPeriod": 86_400, "receiveMessageWaitTimeSeconds": 20, "maximumMessageSize": 262_144 })
        );
        args.dead_letter_queue = Some("orders".into());
        assert_eq!(attributes_body("orders", &args).unwrap_err().message, "A queue can't be its own dead-letter queue");
        args.dead_letter_queue = Some("dead.letters".into());
        assert_eq!(attributes_body("orders", &args).unwrap_err().exit_code(), 2);
        assert!(attributes_body("orders", &attributes()).unwrap().is_empty());
    }

    #[test]
    fn a_queue_reads_with_its_attributes_in_words_and_its_endpoint() {
        let queue = queue();
        assert_eq!(endpoint_of(&queue.url), "https://sqs.ffunc.tn");
        assert_eq!(endpoint_of("http://localhost:3003/000000000001/orders"), "http://localhost:3003");
        assert_eq!(messages_text(&queue.messages), "3 waiting, 1 in flight");
        assert_eq!(
            attributes_text(&queue),
            "visibility timeout  30 seconds\nretention           4 days\ndelivery delay      0 seconds\nreceive wait        20 seconds\nlargest message     1048576 bytes\ndead letters        to orders-dlq after 3 receives"
        );
        assert_eq!(
            [bytes(0), bytes(1), bytes(46), bytes(1536), bytes(2048), bytes(5 * 1_048_576)],
            ["0 bytes", "1 byte", "46 bytes", "1.5 KB", "2 KB", "5 MB"]
        );
        assert_eq!([words(1), words(60), words(90), words(43_200)], ["1 second", "1 minute", "90 seconds", "12 hours"]);
    }

    #[test]
    fn messages_received_read_with_their_attributes_and_handle_or_deleted() {
        let mut received: Vec<Received> = serde_json::from_value(json!([{
            "messageId": "7e4d1c2a-0000-4000-8000-000000000001",
            "receiptHandle": "MTo6MTo3ZTRk",
            "body": "{\"order\": 42}",
            "attributes": { "item": { "dataType": "String", "stringValue": "harissa" }, "picture": { "dataType": "Binary", "binaryValue": "AAEC" } },
            "receiveCount": 1,
            "senderId": "AKFF7Q2MLKX4RTZB3W5N",
            "sentAt": "2026-10-24T08:00:00.000Z"
        }]))
        .unwrap();
        assert_eq!(
            received_text("orders", &received),
            "message 7e4d1c2a-0000-4000-8000-000000000001, received 1 time, sent 2026-10-24 08:00:00 UTC by AKFF7Q2MLKX4RTZB3W5N\n\
             attribute item=harissa (String)\nattribute picture=<4 characters of base64> (Binary)\nhandle MTo6MTo3ZTRk\n{\"order\": 42}"
        );
        received[0].deleted = Some(true);
        assert!(received_text("orders", &received).contains("\ndeleted\n"));
        assert_eq!(received_text("orders", &[]), "No message: orders had none to give within the wait");
    }

    #[test]
    fn attributes_are_name_equals_value_strings_and_handles_are_ffs() {
        assert_eq!(
            Value::Object(message_attributes(&["item=harissa".into(), "note=a=b".into(), "empty=".into()]).unwrap()),
            json!({
                "item": { "dataType": "String", "stringValue": "harissa" },
                "note": { "dataType": "String", "stringValue": "a=b" },
                "empty": { "dataType": "String", "stringValue": "" }
            })
        );
        for refused in ["item", "=harissa"] {
            assert_eq!(message_attributes(&[refused.into()]).unwrap_err().exit_code(), 2, "{refused}");
        }
        assert!(is_receipt_handle("MTo6MTo3ZTRk_-"));
        for refused in ["", "a/b", "a b", "a+b=="] {
            assert!(!is_receipt_handle(refused), "{refused}");
        }
    }
}

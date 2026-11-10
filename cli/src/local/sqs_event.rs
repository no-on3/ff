//! SQS's event, as AWS Lambda gives it to a function that reads a queue, built as the backend builds it
//! (`BE/src/event-sources/sqs-event.ts`): each message's record and what it adds to the event, and a call's answer read
//! as Lambda reads a partial batch response. Its cases are `BE/src/event-sources/sqs-event-examples.json`'s, which the
//! backend's tests read too. A record's keys reach a function in their names' order, as every event's keys do here,
//! where Lambda has an order of its own: a reader of JSON takes either.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use super::sqs::{Attribute, Message, attributes_md5, receipt_handle};
use crate::md5;

/// The message received, as Lambda's record: SQS's system attributes as strings, its trace header among them, and its
/// message attributes in Lambda's shape, with the lists SQS keeps empty.
pub(super) fn record(message: &Message, queue_arn: &str, region: &str) -> Value {
    let mut attributes = json!({
        "ApproximateReceiveCount": message.receive_count.to_string(),
        "SentTimestamp": message.sent_at.to_string(),
        "SenderId": message.sender_id,
        "ApproximateFirstReceiveTimestamp": message.first_received_at.unwrap_or_default().to_string(),
    });
    if let Some(trace) = message.trace_header.as_deref().filter(|trace| !trace.is_empty()) {
        attributes["AWSTraceHeader"] = trace.into();
    }
    let lambdas = |(name, attribute): (&String, &Attribute)| {
        let mut value = Map::new();
        if let Some(string) = &attribute.string {
            value.insert("stringValue".into(), string.clone().into());
        }
        if let Some(binary) = &attribute.binary {
            value.insert("binaryValue".into(), binary.clone().into());
        }
        value.insert("stringListValues".into(), json!([]));
        value.insert("binaryListValues".into(), json!([]));
        value.insert("dataType".into(), attribute.data_type.clone().into());
        (name.clone(), Value::Object(value))
    };
    let mut record = json!({
        "messageId": message.message_id,
        "receiptHandle": receipt_handle(message.row, message.receive_count, &message.message_id),
        "body": message.body,
        "attributes": attributes,
        "messageAttributes": message.attributes.iter().map(lambdas).collect::<Map<String, Value>>(),
        "md5OfBody": md5::hex(message.body.as_bytes()),
        "eventSource": "aws:sqs",
        "eventSourceARN": queue_arn,
        "awsRegion": region,
    });
    if let Some(sum) = attributes_md5(&message.attributes) {
        record["md5OfMessageAttributes"] = sum.into();
    }
    record
}

/// What `{"Records":[]}` takes as JSON.
pub const EVENT_ENVELOPE_BYTES: usize = r#"{"Records":[]}"#.len();

/// What a record adds to the event as JSON, its comma with it.
pub fn record_bytes(record: &Value) -> usize {
    record.to_string().len() + 1
}

/// The messages a call's answer names as failed: some, by their IDs, or the whole batch.
#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    These(BTreeSet<String>),
    All,
}

/// The messages a call's answer names as failed, as Lambda reads a partial batch response (ReportBatchItemFailures):
/// none for no answer, an empty one, or an empty or null `batchItemFailures`; all for an answer that isn't one, or a
/// failure that names no message of the batch, as Lambda takes the whole batch as failed then.
pub fn failed_messages(output: &Value, message_ids: &BTreeSet<&str>) -> Failed {
    let failures = match output {
        Value::Null => return Failed::These(BTreeSet::new()),
        Value::Object(answer) => answer.get("batchItemFailures"),
        _ => return Failed::All,
    };
    let failures = match failures {
        None | Some(Value::Null) => return Failed::These(BTreeSet::new()),
        Some(Value::Array(failures)) => failures,
        Some(_) => return Failed::All,
    };
    let mut failed = BTreeSet::new();
    for failure in failures {
        match failure.get("itemIdentifier").and_then(Value::as_str) {
            Some(id) if message_ids.contains(id) => failed.insert(id.to_owned()),
            _ => return Failed::All,
        };
    }
    Failed::These(failed)
}

#[cfg(test)]
mod tests {
    use super::super::sqs::tests::held_message;
    use super::*;

    /// The backend's table of SQS's event, which its L1 reads too.
    fn table() -> Value {
        serde_json::from_str(include_str!("../../../BE/src/event-sources/sqs-event-examples.json")).unwrap()
    }

    /// The table's message, as a queue keeps it.
    fn message(table: &Value, case: &str) -> Message {
        held_message(&table["records"][case]["message"], 345_600)
    }

    #[test]
    fn each_message_is_the_backends_record_whole() {
        let table = table();
        let (arn, region) = (table["queueArn"].as_str().unwrap(), table["region"].as_str().unwrap());
        let cases = table["records"].as_object().unwrap();
        for (case, example) in cases {
            assert_eq!(record(&message(&table, case), arn, region), example["record"], "{case}: {}", example["title"]);
        }
        assert_eq!(cases.len(), 2);
    }

    #[test]
    fn counts_what_each_record_adds_to_the_event_as_json_its_comma_with_it() {
        let table = table();
        let one = message(&table, "withAttributes");
        let two = Message { row: 43, message_id: "7e4d1c2a-0000-4000-8000-000000000002".into(), ..one.clone() };
        let (arn, region) = (table["queueArn"].as_str().unwrap(), table["region"].as_str().unwrap());
        let (one, two) = (record(&one, arn, region), record(&two, arn, region));
        let event = json!({ "Records": [one, two] }).to_string();
        assert_eq!(EVENT_ENVELOPE_BYTES + record_bytes(&one) + record_bytes(&two) - 1, event.len());
    }

    #[test]
    fn reads_a_calls_answer_as_lambda_reads_a_partial_batch_response() {
        let table = table();
        let answers = &table["batchResponses"];
        let ids: BTreeSet<&str> = answers["batch"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        let none = answers["none"].as_array().unwrap();
        for output in none {
            assert_eq!(failed_messages(output, &ids), Failed::These(BTreeSet::new()), "{output}");
        }
        for case in answers["named"].as_array().unwrap() {
            let failed = case["failed"].as_array().unwrap().iter().filter_map(Value::as_str).map(str::to_owned);
            assert_eq!(failed_messages(&case["output"], &ids), Failed::These(failed.collect()), "{case}");
        }
        let all = answers["all"].as_array().unwrap();
        for output in all {
            assert_eq!(failed_messages(output, &ids), Failed::All, "{output}");
        }
        assert_eq!((none.len(), all.len()), (5, 9));
    }
}

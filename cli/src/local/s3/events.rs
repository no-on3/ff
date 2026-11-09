//! A bucket's notifications at `ff local start`'s front door, as FF's buckets send them
//! (`BE/src/storage/bucket-notifications.ts`): the template's configurations, which event of a write goes by which, S3's
//! record of it, version 2.1, its key form-encoded, and S3's test event to a queue a configuration names. The front
//! door delivers them as FF does: to a function, an asynchronous call; to a queue, a message from the bucket. Their
//! cases are `BE/src/storage/bucket-event-examples.json`'s, which the backend's tests read too.

use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Value, json};

use super::xml::{escape_xml, text_element};
use crate::local::schedule_expression::Millis;

/// Where a configuration's events go: a function, called without waiting, as S3 calls Lambda; or a queue, a message
/// each.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Function,
    Queue,
}

/// One of a bucket's notification configurations, as FF keeps them: its ID, its destination, its events, and its key's
/// filter.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Rule {
    pub id: String,
    pub target: Target,
    /// The destination's ARN: a function's, with its alias when it names one, or a queue's.
    pub arn: String,
    /// S3's event types: `s3:ObjectCreated:*` or one of its kinds, `s3:ObjectRemoved:*` or one of its.
    pub events: Vec<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
}

/// Whether two event types name an event in common: equal, or one the other's wildcard.
fn types_overlap(a: &str, b: &str) -> bool {
    let covers = |wild: &str, other: &str| wild.ends_with(":*") && other.starts_with(&wild[..wild.len() - 1]);
    a == b || covers(a, b) || covers(b, a)
}

/// The rule an event of that name, without its `s3:`, for that key, goes by: a template's configurations can't name it
/// twice, which S3 refuses as ambiguous.
pub fn rule_for<'a>(rules: &'a [Rule], event_name: &str, key: &str) -> Option<&'a Rule> {
    let event = format!("s3:{event_name}");
    rules.iter().find(|rule| {
        rule.events.iter().any(|kind| types_overlap(kind, &event))
            && rule.prefix.as_deref().is_none_or(|prefix| key.starts_with(prefix))
            && rule.suffix.as_deref().is_none_or(|suffix| key.ends_with(suffix))
    })
}

/// GetBucketNotificationConfiguration's answer: the queues' configurations, then the functions', in S3's XML.
pub fn rules_xml(rules: &[Rule]) -> String {
    let element = |rule: &Rule| {
        let (name, arn) = match rule.target {
            Target::Queue => ("QueueConfiguration", "Queue"),
            Target::Function => ("CloudFunctionConfiguration", "CloudFunction"),
        };
        let events: String = rule.events.iter().map(|event| text_element("Event", event)).collect();
        let filters: String = [("prefix", &rule.prefix), ("suffix", &rule.suffix)]
            .into_iter()
            .filter_map(|(filter, value)| {
                let value = escape_xml(value.as_deref()?);
                Some(format!("<FilterRule><Name>{filter}</Name><Value>{value}</Value></FilterRule>"))
            })
            .collect();
        let filter =
            if filters.is_empty() { String::new() } else { format!("<Filter><S3Key>{filters}</S3Key></Filter>") };
        format!("<{name}>{}{}{events}{filter}</{name}>", text_element("Id", &rule.id), text_element(arn, &rule.arn))
    };
    let queues = rules.iter().filter(|rule| rule.target == Target::Queue);
    let functions = rules.iter().filter(|rule| rule.target == Target::Function);
    super::xml::document("NotificationConfiguration", &queues.chain(functions).map(element).collect::<String>())
}

/// An object's key in S3's events: form-encoded, as S3 writes it, a space a `+`, a slash `%2F`, and every byte but a
/// letter, a digit and `-_.*` escaped.
pub fn event_key(key: &str) -> String {
    let mut encoded = String::with_capacity(key.len());
    for byte in key.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => encoded.push(char::from(byte)),
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// The sequencers S3 gives events: hexadecimal, increasing, so that two events of one key are put in order by them.
#[derive(Default)]
pub struct Sequencer(Mutex<u64>);

impl Sequencer {
    /// The next, from the time: its milliseconds times 65,536, or one past the last when that isn't past it.
    pub fn next(&self, now: Millis) -> String {
        let mut last = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let candidate = u64::try_from(now).unwrap_or_default().saturating_mul(65_536);
        *last = if candidate > *last { candidate } else { *last + 1 };
        format!("{:018X}", *last)
    }
}

/// What an event says, from the request that made it.
#[derive(Debug)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct Facts {
    pub region: String,
    /// `ObjectCreated:Put`, `ObjectRemoved:Delete`…: S3's name, without its `s3:`.
    pub event_name: String,
    /// When, in ISO 8601 with its milliseconds.
    pub time: String,
    /// The access key that made the request.
    pub principal_id: String,
    pub source_ip: String,
    pub request_id: String,
    pub bucket: BucketFacts,
    pub object: ObjectFacts,
    pub configuration_id: String,
    pub sequencer: String,
}

#[derive(Debug)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct BucketFacts {
    pub name: String,
    pub account_id: String,
}

/// The key as stored, not encoded; a created object's size and ETag, without its quotes.
#[derive(Debug)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct ObjectFacts {
    pub key: String,
    pub size: Option<u64>,
    pub e_tag: Option<String>,
}

/// One record of S3's event, as S3 sends it to Lambda and SQS, its version 2.1.
pub fn s3_event_record(facts: &Facts) -> Value {
    let mut object = json!({ "key": event_key(&facts.object.key) });
    if let Some(size) = facts.object.size {
        object["size"] = size.into();
    }
    if let Some(etag) = &facts.object.e_tag {
        object["eTag"] = etag.as_str().into();
    }
    object["sequencer"] = facts.sequencer.as_str().into();
    let bucket = &facts.bucket.name;
    json!({
        "eventVersion": "2.1",
        "eventSource": "aws:s3",
        "awsRegion": facts.region,
        "eventTime": facts.time,
        "eventName": facts.event_name,
        "userIdentity": { "principalId": format!("AWS:{}", facts.principal_id) },
        "requestParameters": { "sourceIPAddress": facts.source_ip },
        "responseElements": { "x-amz-request-id": facts.request_id, "x-amz-id-2": facts.request_id },
        "s3": {
            "s3SchemaVersion": "1.0",
            "configurationId": facts.configuration_id,
            "bucket": {
                "name": bucket,
                "ownerIdentity": { "principalId": facts.bucket.account_id },
                "arn": format!("arn:aws:s3:::{bucket}"),
            },
            "object": object,
        },
    })
}

/// The message S3 sends a queue a configuration names, so that its readers may see it works; `time` in ISO 8601.
pub fn test_event(bucket: &str, request_id: &str, time: &str) -> Value {
    json!({
        "Service": "Amazon S3",
        "Event": "s3:TestEvent",
        "Time": time,
        "Bucket": bucket,
        "RequestId": request_id,
        "HostId": request_id,
    })
}

/// What a bucket's notifications send: S3's event, a record, to the destination of the rule it goes by; or S3's test
/// event to a queue a configuration names.
#[derive(Debug, PartialEq)]
pub enum BucketEvent {
    Record { bucket: String, rule: Rule, record: Value },
    Test { bucket: String, queue_arn: String, body: Value },
}

impl BucketEvent {
    pub fn bucket(&self) -> &str {
        match self {
            Self::Record { bucket, .. } | Self::Test { bucket, .. } => bucket,
        }
    }

    /// The ARN it goes to.
    pub fn destination(&self) -> &str {
        match self {
            Self::Record { rule, .. } => &rule.arn,
            Self::Test { queue_arn, .. } => queue_arn,
        }
    }

    /// Whether it goes to a queue, as a test event always does.
    pub fn to_queue(&self) -> bool {
        match self {
            Self::Record { rule, .. } => rule.target == Target::Queue,
            Self::Test { .. } => true,
        }
    }

    /// What its destination gets: a record in S3's `Records`, or the test event itself.
    pub fn body(&self) -> Value {
        match self {
            Self::Record { record, .. } => json!({ "Records": [record] }),
            Self::Test { body, .. } => body.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Table {
        records: Vec<RecordCase>,
        keys: Vec<KeyCase>,
        rules: Vec<Rule>,
        matches: Vec<MatchCase>,
        test_event: TestEventCase,
        documents: Vec<DocumentCase>,
    }

    #[derive(Deserialize)]
    struct RecordCase {
        name: String,
        facts: Facts,
        record: Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct KeyCase {
        key: String,
        in_event: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MatchCase {
        event_name: String,
        key: String,
        rule: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TestEventCase {
        bucket: String,
        request_id: String,
        time: String,
        event: Value,
    }

    #[derive(Deserialize)]
    struct DocumentCase {
        name: String,
        rules: Vec<Rule>,
        xml: String,
    }

    fn table() -> Table {
        serde_json::from_str(include_str!("../../../../BE/src/storage/bucket-event-examples.json")).unwrap()
    }

    #[test]
    fn writes_s3s_record_version_2_1_and_its_test_event_as_the_backend_does() {
        let table = table();

        for case in &table.records {
            assert_eq!(s3_event_record(&case.facts), case.record, "{}", case.name);
        }
        assert_eq!(table.records.len(), 2);
        let test = &table.test_event;
        assert_eq!(test_event(&test.bucket, &test.request_id, &test.time), test.event);
    }

    #[test]
    fn names_a_key_form_encoded_as_s3s_events_do() {
        let table = table();

        let encoded: Vec<(&str, String)> =
            table.keys.iter().map(|case| (case.key.as_str(), event_key(&case.key))).collect();
        let expected: Vec<(&str, String)> =
            table.keys.iter().map(|case| (case.key.as_str(), case.in_event.clone())).collect();
        assert_eq!(encoded, expected);
        assert_eq!(table.keys.len(), 3);
    }

    #[test]
    fn an_event_goes_by_the_rule_whose_events_and_filter_name_it() {
        let table = table();

        for case in &table.matches {
            let found = rule_for(&table.rules, &case.event_name, &case.key).map(|rule| rule.id.clone());
            assert_eq!(found, case.rule, "{} {}", case.event_name, case.key);
        }
        assert_eq!(table.matches.len(), 5);
    }

    #[test]
    fn answers_get_bucket_notification_configuration_in_s3s_xml_the_queues_first() {
        let table = table();

        for case in &table.documents {
            assert_eq!(rules_xml(&case.rules), case.xml, "{}", case.name);
        }
        assert_eq!(table.documents.len(), 2);
    }

    #[test]
    fn a_sequencer_follows_the_clock_and_never_goes_back() {
        let sequencer = Sequencer::default();

        let first = sequencer.next(1_792_735_200_000);
        assert_eq!(first, format!("{:018X}", 1_792_735_200_000u64 * 65_536));
        assert_eq!(sequencer.next(1_792_735_200_000), format!("{:018X}", 1_792_735_200_000u64 * 65_536 + 1));
        assert_eq!(sequencer.next(1_792_735_199_000), format!("{:018X}", 1_792_735_200_000u64 * 65_536 + 2));
        assert!(sequencer.next(1_792_735_200_001) > first);
    }
}

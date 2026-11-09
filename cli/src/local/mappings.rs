//! A template's event source mappings run on this machine, as FF's poller runs them
//! (`BE/src/event-sources/event-source-poller.ts`): each enabled one has a reader of its own, which long-polls its
//! queue, woken as a message is kept; fills a batch of up to the mapping's batch size, waiting up to its batching window
//! for more, and never past an event of 6 MB, a message that doesn't fit beginning the next batch; and calls the
//! function with SQS's event ([`super::sqs_event`]), waiting for it. A call that succeeds deletes its batch, or, with
//! ReportBatchItemFailures, the messages its answer doesn't name; one that fails deletes nothing, and its messages come
//! back after the queue's visibility timeout, each receive counted towards its dead-letter queue. A mapping's batches
//! are called one at a time, as a function here has one instance, where FF calls as many at once as the mapping's
//! maximum concurrency and the function's instances allow.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::events::Outcome;
use super::front_door::FrontDoor;
use super::http::{PAYLOAD_LIMIT, request_id};
use super::instances::Runner;
use super::sqs_event::{EVENT_ENVELOPE_BYTES, Failed, failed_messages, record_bytes};

/// SQS's most messages one receive gives.
const RECEIVE_MAX: usize = 10;
/// How long a reader waits for a batch's first message, as Lambda's poller long-polls SQS, before it looks again.
const LONG_POLL: Duration = Duration::from_secs(20);
/// The longest a receive waits at once, for a reader stopped to see it soon.
const STEP: Duration = Duration::from_secs(1);

/// A function's SQS event, as it reads a queue of the template here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalMapping {
    /// The event's key in the template.
    pub event: String,
    /// The queue's name.
    pub queue: String,
    pub batch_size: usize,
    pub batching_window: Duration,
    pub report_batch_item_failures: bool,
    pub enabled: bool,
}

/// A batch as it is gathered: its records, what they take as SQS's event, and whether one didn't fit.
struct Batch<'a> {
    records: Vec<Value>,
    bytes: usize,
    full: bool,
    /// The records received that didn't fit: they begin the next batch.
    pending: &'a mut Vec<Value>,
}

impl Batch<'_> {
    /// Each record in the batch while the event stays within 6 MB; from the first that doesn't fit, the next batch's.
    fn take(&mut self, records: Vec<Value>) {
        for record in records {
            let size = record_bytes(&record);
            if self.full || (!self.records.is_empty() && self.bytes + size > PAYLOAD_LIMIT) {
                self.full = true;
                self.pending.push(record);
            } else {
                self.bytes += size;
                self.records.push(record);
            }
        }
    }
}

impl<R: Runner> FrontDoor<R> {
    /// A reader for each enabled mapping of each function, a thread each, until `stop` is set.
    pub fn read_queues(&self, stop: &Arc<AtomicBool>) {
        for (function, settings) in self.settings.iter() {
            for mapping in settings.mappings.iter().filter(|mapping| mapping.enabled) {
                let (door, function, mapping, stop) =
                    (self.clone(), function.clone(), mapping.clone(), Arc::clone(stop));
                std::thread::spawn(move || door.read(&function, &mapping, &stop));
            }
        }
    }

    /// A mapping's reader: a batch, then its call, until it is stopped.
    fn read(&self, function: &str, mapping: &LocalMapping, stop: &AtomicBool) {
        let mut pending = Vec::new();
        while !stop.load(Ordering::SeqCst) {
            let batch = self.gather(mapping, &mut pending, stop);
            if !batch.is_empty() && !stop.load(Ordering::SeqCst) {
                self.handle(function, mapping, batch);
            }
        }
    }

    /// A batch: the records that didn't fit in the last one first, else a long poll for its first message; then, in
    /// the batching window, receives until it is full. Empty when the long poll ends with none.
    fn gather(&self, mapping: &LocalMapping, pending: &mut Vec<Value>, stop: &AtomicBool) -> Vec<Value> {
        let earlier = std::mem::take(pending);
        let mut batch = Batch { records: Vec::new(), bytes: EVENT_ENVELOPE_BYTES, full: false, pending };
        batch.take(earlier);
        let receive = |batch: &mut Batch, wait: Duration| {
            let room = RECEIVE_MAX.min(mapping.batch_size.saturating_sub(batch.records.len()));
            batch.take(self.queues.receive_records(&mapping.queue, room, wait));
        };
        let stopped = || stop.load(Ordering::SeqCst);
        let poll_ends = Instant::now() + LONG_POLL;
        while batch.records.is_empty() && !stopped() {
            let left = poll_ends.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            receive(&mut batch, left.min(STEP));
        }
        let window_ends = Instant::now() + mapping.batching_window;
        while !batch.records.is_empty() && batch.records.len() < mapping.batch_size && !batch.full && !stopped() {
            let left = window_ends.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            receive(&mut batch, left.min(STEP));
        }
        batch.records
    }

    /// The batch's call, waited for, and the messages it handled deleted; the others come back after the queue's
    /// visibility timeout, said in the backend's words.
    fn handle(&self, function: &str, mapping: &LocalMapping, records: Vec<Value>) {
        let count = records.len();
        let some =
            format!("{count} {} of the queue {}", if count == 1 { "message" } else { "messages" }, mapping.queue);
        let event = json!({ "Records": records });
        let Some((outcome, response)) = self.attempt(function, &event, &request_id()) else { return };
        let records = event["Records"].as_array().map(Vec::as_slice).unwrap_or_default();
        let id = |record: &Value| record["messageId"].as_str().unwrap_or_default().to_owned();
        let handled: Vec<&Value> = if outcome != Outcome::Success {
            let error = &response.payload;
            (self.say)(&format!(
                "The call of function {function} with {some} failed, which come back after the queue's visibility timeout: {}: {}",
                error["errorType"].as_str().unwrap_or_default(),
                error["errorMessage"].as_str().unwrap_or_default()
            ));
            Vec::new()
        } else if mapping.report_batch_item_failures {
            let ids: Vec<String> = records.iter().map(id).collect();
            match failed_messages(&response.payload, &ids.iter().map(String::as_str).collect::<BTreeSet<&str>>()) {
                Failed::All => {
                    (self.say)(&format!(
                        "Function {function} answered {some} with no batch response Lambda takes: they all come back after the queue's visibility timeout"
                    ));
                    Vec::new()
                }
                Failed::These(failed) => records.iter().filter(|record| !failed.contains(&id(record))).collect(),
            }
        } else {
            records.iter().collect()
        };
        self.queues
            .delete_received(&mapping.queue, handled.iter().filter_map(|record| record["receiptHandle"].as_str()));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::super::Answer;
    use super::super::front_door::Settings;
    use super::super::instances::stand::{Stand, function, instances_of};
    use super::super::key::Key;
    use super::super::s3::Buckets;
    use super::super::schedules;
    use super::super::sqs::{Caller, QueueSettings, Queues};
    use super::*;

    const KEY_ID: &str = "AKFFLOCALKEY0000TEST";
    const QUEUE_URL: &str = "http://127.0.0.1:3700/000000000000/orders";

    /// `Orders` reading the queue `orders` as a mapping says, on the stand-in, until it is dropped.
    struct Reading {
        door: FrontDoor<Stand>,
        stand: Stand,
        said: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
    }

    impl Drop for Reading {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    /// The mapping's settings as Lambda's defaults have them: batches of 10, no window.
    fn mapping() -> LocalMapping {
        LocalMapping {
            event: "Jobs".into(),
            queue: "orders".into(),
            batch_size: 10,
            batching_window: Duration::ZERO,
            report_batch_item_failures: false,
            enabled: true,
        }
    }

    /// `Orders` with `mapping`, the queue `orders` hiding a message received for `visibility` seconds; read once
    /// [`Reading::start`] is called.
    fn reading(mapping: LocalMapping, visibility: i64) -> Reading {
        let said = Arc::new(Mutex::new(Vec::new()));
        let (instances, stand) = instances_of(vec![function("Orders", "app.handler")], &said);
        let settings = Settings { mappings: vec![mapping], ..Settings::default() };
        let say_to = Arc::clone(&said);
        let queue = QueueSettings { visibility_timeout: visibility, ..QueueSettings::default() };
        let door = FrontDoor {
            instances: Arc::new(instances),
            region: "tn-tunis-1".into(),
            account: "000000000000".into(),
            key: Key { id: KEY_ID.into(), secret: "a-secret".into() },
            settings: Arc::new([("Orders".to_owned(), settings)].into()),
            started: UNIX_EPOCH,
            second: Duration::from_millis(1),
            say: Arc::new(move |line| say_to.lock().unwrap().push(line.to_owned())),
            clock_offset: 0,
            queues: Arc::new(Queues::new(
                "tn-tunis-1",
                "000000000000",
                [("orders".to_owned(), queue)],
                Arc::new(|| schedules::now_ms(0)),
            )),
            buckets: Arc::new(Buckets::none()),
        };
        Reading { door, stand, said, stop: Arc::new(AtomicBool::new(false)) }
    }

    /// The stand-in's answer of a call that returned `body`, or threw.
    fn answer(function_error: bool, body: Value) -> Answer {
        Answer {
            status: if function_error { 500 } else { 200 },
            request_id: None,
            duration_ms: None,
            memory_mb: None,
            function_error,
            body: body.to_string(),
            log_result: None,
        }
    }

    impl Reading {
        fn sqs(&self, operation: &str, input: Value) -> Value {
            let caller = Caller { key_id: KEY_ID, endpoint: "http://127.0.0.1:3700" };
            self.door.queues.run(operation, &input, &caller).unwrap()
        }

        /// A message sent to the queue, with what `more` adds to SendMessage's input; its ID.
        fn send(&self, body: &str, more: Value) -> String {
            let mut input = json!({ "QueueUrl": QUEUE_URL, "MessageBody": body });
            input.as_object_mut().unwrap().extend(more.as_object().cloned().unwrap_or_default());
            self.sqs("SendMessage", input)["MessageId"].as_str().unwrap().to_owned()
        }

        fn start(&self) {
            self.door.read_queues(&self.stop);
        }

        /// The calls' events, in turn.
        fn calls(&self) -> Vec<Value> {
            self.stand.received.lock().unwrap().iter().map(|(event, _)| event.clone()).collect()
        }

        /// Each call's bodies.
        fn batches(&self) -> Vec<Vec<String>> {
            let bodies = |event: &Value| {
                let records = event["Records"].as_array().cloned().unwrap_or_default();
                records.iter().map(|record| record["body"].as_str().unwrap_or_default().to_owned()).collect()
            };
            self.calls().iter().map(bodies).collect()
        }

        /// The queue's messages visible and in flight.
        fn counts(&self) -> (String, String) {
            let names = ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"];
            let attributes = self.sqs("GetQueueAttributes", json!({ "QueueUrl": QUEUE_URL, "AttributeNames": names }));
            let count = |name: &str| attributes["Attributes"][name].as_str().unwrap_or_default().to_owned();
            (count(names[0]), count(names[1]))
        }

        /// What was said of the queue.
        fn said_of_the_queue(&self) -> Vec<String> {
            self.said.lock().unwrap().iter().filter(|line| line.contains("of the queue orders")).cloned().collect()
        }

        /// Waits up to `seconds` for what happens apart.
        fn until(&self, seconds: u64, done: impl Fn(&Reading) -> bool) -> bool {
            let started = Instant::now();
            while !done(self) && started.elapsed() < Duration::from_secs(seconds) {
                std::thread::sleep(Duration::from_millis(10));
            }
            done(self)
        }
    }

    fn emptied(reading: &Reading) -> bool {
        reading.counts() == ("0".into(), "0".into())
    }

    #[test]
    fn a_batch_is_sqss_event_of_the_queues_messages_deleted_once_its_call_succeeds() {
        let reading = reading(mapping(), 30);
        let item = json!({ "item": { "DataType": "String", "StringValue": "harissa" } });
        let trace = json!({ "AWSTraceHeader": { "DataType": "String", "StringValue": "Root=1-5759e988-bd862e3fe1be46a994272793" } });
        let ids = [
            reading.send("one", json!({ "MessageAttributes": item })),
            reading.send("two", json!({ "MessageSystemAttributes": trace })),
            reading.send("three", json!({})),
        ];
        let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        reading.start();

        assert!(reading.until(3, |reading| reading.calls().len() == 1 && emptied(reading)));
        assert_eq!(reading.batches(), [["one", "two", "three"]]);
        let records = reading.calls()[0]["Records"].as_array().unwrap().clone();
        let same = |key: &str| records.iter().map(|record| record[key].clone()).collect::<Vec<Value>>();
        assert_eq!(same("messageId"), ids.map(Value::from));
        assert_eq!(same("eventSource"), ["aws:sqs"; 3]);
        assert_eq!(same("eventSourceARN"), ["arn:aws:sqs:tn-tunis-1:000000000000:orders"; 3]);
        assert_eq!(same("awsRegion"), ["tn-tunis-1"; 3]);
        let attributes = &records[1]["attributes"];
        assert_eq!(
            (&attributes["ApproximateReceiveCount"], &attributes["SenderId"], &attributes["AWSTraceHeader"]),
            (&json!("1"), &json!(KEY_ID), &json!("Root=1-5759e988-bd862e3fe1be46a994272793"))
        );
        let first_received: u128 = attributes["ApproximateFirstReceiveTimestamp"].as_str().unwrap().parse().unwrap();
        assert!(first_received >= before, "{attributes}");
        assert_eq!(
            records[0]["messageAttributes"],
            json!({ "item": { "stringValue": "harissa", "stringListValues": [], "binaryListValues": [], "dataType": "String" } })
        );
        assert!(records[0]["md5OfMessageAttributes"].is_string() && records[1].get("md5OfMessageAttributes").is_none());
        assert_eq!(reading.said_of_the_queue(), Vec::<String>::new());
    }

    #[test]
    fn a_batch_holds_its_batch_size_at_most() {
        let reading = reading(LocalMapping { batch_size: 2, ..mapping() }, 30);
        for body in ["one", "two", "three"] {
            reading.send(body, json!({}));
        }
        reading.start();

        assert!(reading.until(3, |reading| reading.calls().len() == 2 && emptied(reading)));
        assert_eq!(reading.batches(), [vec!["one", "two"], vec!["three"]]);
    }

    #[test]
    fn a_batch_waits_its_window_for_more_messages() {
        let reading = reading(LocalMapping { batching_window: Duration::from_secs(2), ..mapping() }, 30);
        reading.send("one", json!({}));
        reading.start();
        std::thread::sleep(Duration::from_millis(300));
        reading.send("two", json!({}));

        assert!(reading.until(5, |reading| reading.calls().len() == 1 && emptied(reading)));
        assert_eq!(reading.batches(), [["one", "two"]]);
    }

    #[test]
    fn a_message_that_would_take_the_event_past_6_mb_begins_the_next_batch() {
        let reading = reading(mapping(), 30);
        let body = "x".repeat(1_000_000);
        for _ in 0..7 {
            reading.send(&body, json!({}));
        }
        reading.start();

        assert!(reading.until(5, |reading| reading.calls().len() == 2 && emptied(reading)));
        let sizes: Vec<usize> = reading.batches().iter().map(Vec::len).collect();
        assert_eq!(sizes, [6, 1]);
        let first = reading.calls()[0].to_string().len();
        assert!(first <= PAYLOAD_LIMIT && first + 1_000_000 > PAYLOAD_LIMIT, "{first}");
    }

    #[test]
    fn with_report_batch_item_failures_the_messages_an_answer_names_come_back_after_the_visibility_timeout() {
        let reading = reading(LocalMapping { report_batch_item_failures: true, ..mapping() }, 1);
        let ids: Vec<String> = ["a", "b", "c"].iter().map(|body| reading.send(body, json!({}))).collect();
        let failures = json!({ "batchItemFailures": [{ "itemIdentifier": ids[1] }] });
        reading.stand.script.lock().unwrap().push_back(Ok(answer(false, failures)));
        reading.start();

        assert!(reading.until(2, |reading| reading.calls().len() == 1));
        assert!(reading.until(1, |reading| reading.counts() == ("0".into(), "1".into())));
        assert!(reading.until(4, |reading| reading.calls().len() == 2 && emptied(reading)));
        assert_eq!(reading.batches(), [vec!["a", "b", "c"], vec!["b"]]);
        assert_eq!(reading.calls()[1]["Records"][0]["attributes"]["ApproximateReceiveCount"], "2");
        assert_eq!(reading.said_of_the_queue(), Vec::<String>::new());
    }

    #[test]
    fn an_answer_lambda_cant_read_and_a_call_that_fails_delete_nothing_said_in_the_backends_words() {
        let reading = reading(LocalMapping { report_batch_item_failures: true, ..mapping() }, 1);
        reading.send("a", json!({}));
        let thrown = json!({ "errorType": "Error", "errorMessage": "thrown" });
        reading.stand.script.lock().unwrap().extend([Ok(answer(false, json!("done"))), Ok(answer(true, thrown))]);
        reading.start();

        assert!(reading.until(6, |reading| reading.calls().len() == 3 && emptied(reading)));
        assert_eq!(reading.batches(), [["a"], ["a"], ["a"]]);
        assert_eq!(reading.calls()[2]["Records"][0]["attributes"]["ApproximateReceiveCount"], "3");
        assert_eq!(
            reading.said_of_the_queue(),
            [
                "Function Orders answered 1 message of the queue orders with no batch response Lambda takes: they all come back after the queue's visibility timeout",
                "The call of function Orders with 1 message of the queue orders failed, which come back after the queue's visibility timeout: Error: thrown",
            ]
        );
    }

    #[test]
    fn without_report_batch_item_failures_a_call_that_succeeds_deletes_its_batch_whatever_it_answers() {
        let reading = reading(mapping(), 1);
        let id = reading.send("a", json!({}));
        let failures = json!({ "batchItemFailures": [{ "itemIdentifier": id }] });
        reading.stand.script.lock().unwrap().push_back(Ok(answer(false, failures)));
        reading.start();

        assert!(reading.until(2, |reading| reading.calls().len() == 1 && emptied(reading)));
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(reading.calls().len(), 1);
    }

    #[test]
    fn a_disabled_mapping_reads_nothing() {
        let reading = reading(LocalMapping { enabled: false, ..mapping() }, 30);
        reading.send("a", json!({}));
        reading.start();
        std::thread::sleep(Duration::from_millis(300));

        assert_eq!((reading.calls().len(), reading.counts()), (0, ("1".into(), "0".into())));
    }
}

//! Asynchronous calls, as FF makes them (`BE/src/functions/async-invoke.ts`): after each attempt, the event's end or
//! its next attempt, a function's failure retried after a minute, then two, a throttle or a call that couldn't be made
//! after 1, 2, 4… seconds up to five minutes, none past the event's age; the record its destination is sent, and the
//! attributes beside a failed event in a dead-letter queue, as Lambda sends them. Its tests are the backend's, their
//! numbers the same.

use std::time::SystemTime;

use serde_json::{Value, json};

use super::sqs::{Attribute, Attributes};

/// The most of an error's message that Lambda puts beside an event in its dead-letter queue: a kilobyte.
const DEAD_LETTER_ERROR_BYTES: usize = 1024;

/// Lambda's waits before an event's retries, after its function failed: a minute, then two.
const RETRY_DELAYS_SECONDS: [u64; 2] = [60, 120];
/// The backoff after a throttle or a call that couldn't be made: from a second, doubling each time, to five minutes.
const BACKOFF_FIRST_SECONDS: u64 = 1;
const BACKOFF_MAX_SECONDS: u64 = 300;

/// How many times an event is retried after its function failed, and how long it is kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub maximum_retry_attempts: u32,
    pub maximum_event_age_seconds: u64,
}

/// Lambda's defaults: two retries, six hours.
pub const LAMBDA_RETRY_POLICY: RetryPolicy =
    RetryPolicy { maximum_retry_attempts: 2, maximum_event_age_seconds: 21_600 };

impl Default for RetryPolicy {
    fn default() -> Self {
        LAMBDA_RETRY_POLICY
    }
}

/// What is kept of an event's attempts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Attempts {
    /// Attempts its function failed: past the retries, the event is dropped.
    pub failures: u32,
    /// Attempts throttled, or that couldn't be made: each waits longer than the last, until the event's age is up.
    pub throttles: u32,
    /// Attempts whose outcome was kept.
    pub settled: u32,
}

/// How an attempt ended, as its retries see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    /// The function failed: it threw, timed out, or couldn't load.
    FunctionError,
    /// No instance could take it.
    Throttled,
    /// The call couldn't be made.
    SystemError,
}

/// Why an event has no attempt left, as a destination's record says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Succeeded,
    RetriesExhausted,
    TooOld,
}

impl End {
    /// Lambda's condition.
    fn condition(self) -> &'static str {
        match self {
            End::Succeeded => "Success",
            End::RetriesExhausted => "RetriesExhausted",
            End::TooOld => "EventAgeExceeded",
        }
    }
}

/// What comes after an attempt: the event's end, or its next attempt, after a wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settlement {
    End(End, Attempts),
    Retry { wait_seconds: u64, attempts: Attempts },
}

/// After an attempt that ended when the event was `age_seconds` old: success ends the event; a failure of the
/// function retries it after a minute, then two, as many times as the policy allows; a throttle or a call that
/// couldn't be made retries it with a backoff from a second to five minutes. A retry that would come past the event's
/// age doesn't: the event ends there.
pub fn after_attempt(attempts: Attempts, outcome: Outcome, age_seconds: f64, policy: RetryPolicy) -> Settlement {
    let mut settled = Attempts { settled: attempts.settled + 1, ..attempts };
    let wait_seconds = match outcome {
        Outcome::Success => return Settlement::End(End::Succeeded, settled),
        Outcome::FunctionError => {
            settled.failures += 1;
            if settled.failures > policy.maximum_retry_attempts {
                return Settlement::End(End::RetriesExhausted, settled);
            }
            let index = (settled.failures as usize).min(RETRY_DELAYS_SECONDS.len()) - 1;
            RETRY_DELAYS_SECONDS[index]
        }
        Outcome::Throttled | Outcome::SystemError => {
            settled.throttles += 1;
            let doublings = settled.throttles.saturating_sub(1).min(16);
            (BACKOFF_FIRST_SECONDS << doublings).min(BACKOFF_MAX_SECONDS)
        }
    };
    if age_seconds + wait_seconds as f64 > policy.maximum_event_age_seconds as f64 {
        return Settlement::End(End::TooOld, settled);
    }
    Settlement::Retry { wait_seconds, attempts: settled }
}

/// How an attempt answered, as a destination's record gives it: Lambda's status, and the function's output or the
/// error.
#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    /// Whether the function failed, which Lambda says as "Unhandled".
    pub function_error: bool,
    pub payload: Value,
}

/// A call, as its record names it.
pub struct Call<'a> {
    pub request_id: &'a str,
    pub function_arn: &'a str,
    /// The version or the alias the call named; `$LATEST` when none.
    pub qualifier: Option<&'a str>,
    pub approximate_invoke_count: u32,
    pub request_payload: &'a Value,
}

/// A call's record, as AWS Lambda sends a destination one: the request, with the function's ARN qualified by what the
/// call named, $LATEST by default; why it is sent; the event; and the last attempt's answer, when one ran, with the
/// version that ran it, which is $LATEST here.
pub fn invocation_record(call: &Call, end: End, response: Option<&Response>, timestamp: SystemTime) -> Value {
    let mut record = json!({
        "version": "1.0",
        "timestamp": humantime::format_rfc3339_millis(timestamp).to_string(),
        "requestContext": {
            "requestId": call.request_id,
            "functionArn": format!("{}:{}", call.function_arn, call.qualifier.unwrap_or("$LATEST")),
            "condition": end.condition(),
            "approximateInvokeCount": call.approximate_invoke_count,
        },
        "requestPayload": call.request_payload,
    });
    if let Some(response) = response {
        let mut context = json!({ "statusCode": response.status, "executedVersion": "$LATEST" });
        if response.function_error {
            context["functionError"] = json!("Unhandled");
        }
        record["responseContext"] = context;
        record["responsePayload"] = response.payload.clone();
    }
    record
}

/// What Lambda puts beside an event it sends to a dead-letter queue, as SQS's message attributes: its request ID, and
/// the last attempt's status (ErrorCode) and the start of its error (ErrorMessage), the error's type when its message
/// is empty, as SQS takes no empty value.
pub fn dead_letter_attributes(request_id: &str, response: &Response) -> Attributes {
    let text = |name: &str| response.payload[name].as_str().filter(|text| !text.is_empty());
    let message = text("errorMessage").or_else(|| text("errorType")).unwrap_or("Error");
    let mut end = 0;
    for (at, character) in message.char_indices() {
        if at + character.len_utf8() > DEAD_LETTER_ERROR_BYTES {
            break;
        }
        end = at + character.len_utf8();
    }
    Attributes::from([
        ("RequestID".to_owned(), Attribute::string("String", request_id)),
        ("ErrorCode".to_owned(), Attribute::string("Number", &response.status.to_string())),
        ("ErrorMessage".to_owned(), Attribute::string("String", &message[..end])),
    ])
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const NONE: Attempts = Attempts { failures: 0, throttles: 0, settled: 0 };

    fn retry(settlement: Settlement) -> (u64, Attempts) {
        match settlement {
            Settlement::Retry { wait_seconds, attempts } => (wait_seconds, attempts),
            other => panic!("no retry: {other:?}"),
        }
    }

    #[test]
    fn an_event_its_function_ran_ends() {
        assert_eq!(
            after_attempt(NONE, Outcome::Success, 1.0, LAMBDA_RETRY_POLICY),
            Settlement::End(End::Succeeded, Attempts { settled: 1, ..NONE })
        );
    }

    #[test]
    fn a_functions_failure_is_retried_a_minute_later_then_two_then_the_event_dropped() {
        let (wait, first) = retry(after_attempt(NONE, Outcome::FunctionError, 1.0, LAMBDA_RETRY_POLICY));
        assert_eq!((wait, first), (60, Attempts { failures: 1, throttles: 0, settled: 1 }));
        let (wait, second) = retry(after_attempt(first, Outcome::FunctionError, 62.0, LAMBDA_RETRY_POLICY));
        assert_eq!((wait, second), (120, Attempts { failures: 2, throttles: 0, settled: 2 }));
        assert_eq!(
            after_attempt(second, Outcome::FunctionError, 183.0, LAMBDA_RETRY_POLICY),
            Settlement::End(End::RetriesExhausted, Attempts { failures: 3, throttles: 0, settled: 3 })
        );
    }

    #[test]
    fn a_throttle_or_a_call_not_made_is_retried_after_1_2_4_seconds_up_to_five_minutes_none_counted_as_a_retry() {
        let (mut attempts, mut waits) = (NONE, Vec::new());
        for n in 0..11 {
            let outcome = if n % 2 == 1 { Outcome::SystemError } else { Outcome::Throttled };
            let (wait, next) = retry(after_attempt(attempts, outcome, 10.0, LAMBDA_RETRY_POLICY));
            waits.push(wait);
            attempts = next;
        }
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
        assert_eq!(attempts, Attempts { failures: 0, throttles: 11, settled: 11 });
    }

    #[test]
    fn an_event_whose_next_attempt_would_come_past_its_age_is_dropped_six_hours_by_default() {
        let late = 6.0 * 3600.0 - 30.0;
        assert!(matches!(
            after_attempt(NONE, Outcome::FunctionError, late, LAMBDA_RETRY_POLICY),
            Settlement::End(End::TooOld, _)
        ));
        assert_eq!(retry(after_attempt(NONE, Outcome::Throttled, late, LAMBDA_RETRY_POLICY)).0, 1);
    }

    #[test]
    fn the_functions_own_policy_is_followed_no_retries_a_shorter_age() {
        let policy = RetryPolicy { maximum_retry_attempts: 0, maximum_event_age_seconds: 60 };
        assert!(matches!(
            after_attempt(NONE, Outcome::FunctionError, 1.0, policy),
            Settlement::End(End::RetriesExhausted, _)
        ));
        assert!(matches!(after_attempt(NONE, Outcome::Throttled, 59.5, policy), Settlement::End(End::TooOld, _)));
    }

    fn call(payload: &Value) -> Call<'_> {
        Call {
            request_id: "req-1",
            function_arn: "arn:aws:lambda:tn-tunis-1:000000000001:function:orders",
            qualifier: None,
            approximate_invoke_count: 3,
            request_payload: payload,
        }
    }

    /// 2026-10-23T10:00:00Z, the backend's tests' time.
    fn sent() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_749_600)
    }

    #[test]
    fn a_record_names_the_request_why_it_ends_the_event_and_the_last_attempts_answer() {
        let payload = json!({ "order": 42 });
        let response = Response {
            status: 200,
            function_error: true,
            payload: json!({ "errorType": "Error", "errorMessage": "boom" }),
        };
        assert_eq!(
            invocation_record(&call(&payload), End::RetriesExhausted, Some(&response), sent()),
            json!({
                "version": "1.0",
                "timestamp": "2026-10-23T10:00:00.000Z",
                "requestContext": {
                    "requestId": "req-1",
                    "functionArn": "arn:aws:lambda:tn-tunis-1:000000000001:function:orders:$LATEST",
                    "condition": "RetriesExhausted",
                    "approximateInvokeCount": 3
                },
                "requestPayload": { "order": 42 },
                "responseContext": { "statusCode": 200, "executedVersion": "$LATEST", "functionError": "Unhandled" },
                "responsePayload": { "errorType": "Error", "errorMessage": "boom" }
            })
        );
    }

    #[test]
    fn a_record_says_success_and_event_age_exceeded_as_lambda_does_without_the_answer_of_an_attempt_never_run() {
        let payload = json!({ "order": 42 });
        let done = Response { status: 200, function_error: false, payload: json!("done") };
        let succeeded = invocation_record(&call(&payload), End::Succeeded, Some(&done), sent());
        assert_eq!(succeeded["requestContext"]["condition"], "Success");
        assert_eq!(succeeded["responseContext"], json!({ "statusCode": 200, "executedVersion": "$LATEST" }));
        assert_eq!(succeeded["responsePayload"], "done");
        let aged = invocation_record(&call(&payload), End::TooOld, None, sent());
        assert_eq!(aged["requestContext"]["condition"], "EventAgeExceeded");
        assert!(aged.get("responseContext").is_none() && aged.get("responsePayload").is_none());
    }

    #[test]
    fn a_record_names_what_the_call_named_in_its_arn() {
        let payload = json!({});
        let named = Call { qualifier: Some("live"), ..call(&payload) };
        let record = invocation_record(&named, End::Succeeded, None, sent());
        assert_eq!(
            record["requestContext"]["functionArn"],
            "arn:aws:lambda:tn-tunis-1:000000000001:function:orders:live"
        );
    }

    #[test]
    fn a_dead_letter_carries_the_request_id_the_status_and_the_errors_first_kilobyte_cut_between_characters() {
        let answered =
            |status, payload| dead_letter_attributes("req-1", &Response { status, function_error: true, payload });
        let message = |status, payload| answered(status, payload)["ErrorMessage"].string.clone().unwrap();
        let long = format!("{}é", "x".repeat(1023));

        let attributes = answered(200, json!({ "errorType": "Error", "errorMessage": long }));

        assert_eq!(attributes["RequestID"], Attribute::string("String", "req-1"));
        assert_eq!(attributes["ErrorCode"], Attribute::string("Number", "200"));
        assert_eq!(attributes["ErrorMessage"], Attribute::string("String", &"x".repeat(1023)));
        let throttled = json!({ "errorType": "TooManyRequestsException", "errorMessage": "Rate exceeded" });
        assert_eq!(message(429, throttled), "Rate exceeded");
        assert_eq!(message(200, json!({ "errorType": "TypeError", "errorMessage": "" })), "TypeError");
        assert_eq!(message(500, Value::Null), "Error");
    }
}

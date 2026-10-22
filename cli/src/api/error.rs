//! The API's refusals as ff's errors: the API's own message, its request ID, and the exit code a
//! script reads (ADR 0002).

use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Kind};

/// NestJS's error body, `{statusCode, message, error}`, with FF's `requestId`. A validation
/// error's `message` is a list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    message: Option<Message>,
    error: Option<String>,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Message {
    One(String),
    Many(Vec<String>),
}

/// The error for an answer outside 2xx: 402, 403 and 429 are the account's (6), anything else a
/// failure (3). A 401's message says why the token was refused, and what to do.
pub fn api_error(status: u16, body: &str, request_id: Option<String>, api_key: bool) -> Error {
    let details = serde_json::from_str::<serde_json::Value>(body).ok().filter(serde_json::Value::is_object);
    let parsed = serde_json::from_str::<ErrorBody>(body).ok();
    let (message, error, body_request_id) = match parsed {
        Some(body) => (body.message, body.error, body.request_id),
        None => (None, None, None),
    };
    let message = match message {
        Some(Message::One(message)) => message,
        Some(Message::Many(messages)) => messages.join("; "),
        None => {
            let reason = error.unwrap_or_else(|| {
                ureq::http::StatusCode::from_u16(status)
                    .ok()
                    .and_then(|code| code.canonical_reason())
                    .unwrap_or("")
                    .to_owned()
            });
            let text = body.trim();
            if text.is_empty() || text.starts_with('{') || text.starts_with('<') {
                format!("The API answered {status} {reason}")
            } else {
                format!("The API answered {status} {reason}: {}", text.chars().take(200).collect::<String>())
            }
        }
    };
    let message = match status {
        401 if api_key => format!("{message}: save another key with `ff config set-token`"),
        401 => format!("{message}: log in again, or use an API key"),
        _ => message,
    };
    let kind = match status {
        402 | 403 | 429 => Kind::RefusedByAccount,
        _ => Kind::Failed,
    };
    let mut error = Error::new(kind, message);
    error.status = Some(status);
    error.request_id = body_request_id.or(request_id);
    error.details = details;
    error
}

/// How long a 429's `Retry-After` asks to wait: whole seconds, as the API sends it.
pub fn retry_after(header: Option<&str>) -> Option<Duration> {
    header?.trim().parse::<u64>().ok().map(Duration::from_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apis_message_is_kept_as_it_wrote_it_with_its_request_id() {
        let error = api_error(
            400,
            r#"{"statusCode":400,"message":"The beta plan allows 5 functions","error":"Bad Request","requestId":"7d1e"}"#,
            None,
            true,
        );

        assert_eq!(
            (error.message.as_str(), error.exit_code(), error.status),
            ("The beta plan allows 5 functions", 3, Some(400))
        );
        assert_eq!(error.request_id.as_deref(), Some("7d1e"));
    }

    #[test]
    fn a_validation_errors_messages_are_joined() {
        let error = api_error(
            400,
            r#"{"message":["name must be shorter","memory must be a number"],"error":"Bad Request"}"#,
            None,
            true,
        );

        assert_eq!(error.message, "name must be shorter; memory must be a number");
    }

    #[test]
    fn credit_roles_scopes_and_rates_are_the_accounts_refusals() {
        let codes: Vec<(u16, u8)> = [400, 401, 402, 403, 404, 409, 413, 429, 500, 503]
            .into_iter()
            .map(|status| (status, api_error(status, "{}", None, true).exit_code()))
            .collect();

        assert_eq!(
            codes,
            [(400, 3), (401, 3), (402, 6), (403, 6), (404, 3), (409, 3), (413, 3), (429, 6), (500, 3), (503, 3)]
        );
        let scope = api_error(
            403,
            r#"{"statusCode":403,"message":"This API key lacks the scope functions:write"}"#,
            None,
            true,
        );
        assert_eq!(scope.message, "This API key lacks the scope functions:write");
    }

    #[test]
    fn a_refused_token_says_what_to_do() {
        let body = r#"{"statusCode":401,"message":"The API key was revoked"}"#;

        assert_eq!(
            api_error(401, body, None, true).message,
            "The API key was revoked: save another key with `ff config set-token`"
        );
        assert_eq!(
            api_error(401, body, None, false).message,
            "The API key was revoked: log in again, or use an API key"
        );
    }

    #[test]
    fn an_answer_without_the_apis_body_says_its_status_and_the_header_gives_the_request_id() {
        let proxy = api_error(502, "<html>Bad Gateway</html>", Some("9f0a".into()), true);
        let text = api_error(503, "upstream connect error", None, true);

        assert_eq!(
            (proxy.message.as_str(), proxy.request_id.as_deref()),
            ("The API answered 502 Bad Gateway", Some("9f0a"))
        );
        assert_eq!(text.message, "The API answered 503 Service Unavailable: upstream connect error");
    }

    #[test]
    fn retry_after_is_whole_seconds() {
        assert_eq!(retry_after(Some("3")), Some(Duration::from_secs(3)));
        assert_eq!(retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(retry_after(None), None);
    }
}

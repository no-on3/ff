//! What a command prints: its result on stdout, as text for people or as one JSON document for
//! scripts; and its error on stderr, in the same format.

use std::io::{self, IsTerminal, Write};

use serde::Serialize;
use serde_json::json;

use crate::cli::{Format, GlobalArgs};
use crate::error::Error;

pub struct Output {
    pub format: Format,
    pub verbose: bool,
    pub quiet: bool,
    /// Colors on stderr: a terminal, and neither `--no-color` nor `NO_COLOR`.
    color: bool,
}

impl Output {
    pub fn new(global: &GlobalArgs) -> Self {
        let no_color = global.no_color || std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
        Output {
            format: global.output,
            verbose: global.verbose,
            quiet: global.quiet,
            color: !no_color && io::stderr().is_terminal(),
        }
    }

    /// The command's result: the text, or the value as one JSON document.
    pub fn result<T: Serialize>(&self, value: &T, text: impl FnOnce() -> String) -> Result<(), Error> {
        let mut stdout = io::stdout().lock();
        match self.format {
            Format::Text => writeln!(stdout, "{}", text())?,
            Format::Json => writeln!(stdout, "{}", serde_json::to_string_pretty(value).expect("a result serializes"))?,
        }
        Ok(())
    }

    /// Something to fix that doesn't stop the command, on stderr.
    pub fn warn(&self, text: &str) {
        let label = if self.color { "\x1b[1;33mwarning:\x1b[0m" } else { "warning:" };
        let _ = writeln!(io::stderr().lock(), "{label} {text}");
    }

    /// The error, on stderr. Nothing more can be done if stderr itself fails.
    pub fn error(&self, error: &Error) {
        let text = match self.format {
            Format::Text => error_text(error, self.color),
            Format::Json => serde_json::to_string_pretty(&error_document(error)).expect("an error serializes"),
        };
        let _ = writeln!(io::stderr().lock(), "{text}");
    }
}

/// `error: <message>`, and the request ID on a line of its own when there is one.
fn error_text(error: &Error, color: bool) -> String {
    let label = if color { "\x1b[1;31merror:\x1b[0m" } else { "error:" };
    match &error.request_id {
        Some(request_id) => format!("{label} {}\nrequest ID: {request_id}", error.message),
        None => format!("{label} {}", error.message),
    }
}

/// The error for a script: always the same keys, the API's status and request ID null when the
/// API gave none.
fn error_document(error: &Error) -> serde_json::Value {
    json!({ "error": { "message": error.message, "exitCode": error.exit_code(), "status": error.status, "requestId": error.request_id } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Kind;

    fn refused() -> Error {
        let mut error = Error::new(Kind::Failed, "The function failed to load");
        error.status = Some(400);
        error.request_id = Some("7d1e5c1a".into());
        error
    }

    #[test]
    fn an_error_reads_as_text_with_its_request_id_and_color_only_when_asked() {
        assert_eq!(error_text(&refused(), false), "error: The function failed to load\nrequest ID: 7d1e5c1a");
        assert_eq!(error_text(&Error::new(Kind::Usage, "Bad JSON"), false), "error: Bad JSON");
        assert!(error_text(&refused(), true).starts_with("\x1b[1;31merror:\x1b[0m The function"));
    }

    #[test]
    fn an_error_as_json_has_its_message_exit_code_and_request_id() {
        assert_eq!(
            error_document(&refused()),
            json!({ "error": { "message": "The function failed to load", "exitCode": 3, "status": 400, "requestId": "7d1e5c1a" } })
        );
        assert_eq!(error_document(&Error::new(Kind::Usage, "Bad JSON"))["error"]["requestId"], serde_json::Value::Null);
    }
}

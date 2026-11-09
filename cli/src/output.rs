//! What a command prints: its result, as text for people or as one JSON document for scripts, on
//! stdout or into a buffer that `ff mcp` and the tests read; and its error on stderr, in the same
//! format.

use std::io::{self, IsTerminal, Write};
#[cfg(test)]
use std::sync::Arc;
use std::sync::{Mutex, PoisonError};

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
    /// Where the results go: stdout for a command, a buffer for whoever reads them instead.
    results: Mutex<Box<dyn Write + Send>>,
}

impl Output {
    pub fn new(global: &GlobalArgs) -> Self {
        let no_color = global.no_color || std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
        Output {
            format: global.output,
            verbose: global.verbose,
            quiet: global.quiet,
            color: !no_color && io::stderr().is_terminal(),
            results: Mutex::new(Box::new(io::stdout())),
        }
    }

    /// An output whose results go into a buffer, read back from the buffer: JSON, nothing on
    /// stderr but warnings, no color.
    #[cfg(test)]
    pub fn buffered() -> (Self, Buffer) {
        let buffer = Buffer::default();
        let results: Box<dyn Write + Send> = Box::new(buffer.clone());
        (
            Output { format: Format::Json, verbose: false, quiet: true, color: false, results: Mutex::new(results) },
            buffer,
        )
    }

    /// An output for tests whose results no one reads.
    #[cfg(test)]
    pub fn quiet() -> Self {
        Output::buffered().0
    }

    /// The command's result: the text, or the value as one JSON document.
    pub fn result<T: Serialize>(&self, value: &T, text: impl FnOnce() -> String) -> Result<(), Error> {
        match self.format {
            Format::Text => self.line(&text()),
            Format::Json => self.line(&serde_json::to_string_pretty(value).expect("a result serializes")),
        }
    }

    /// A line of a result written as it comes, as a log's lines are.
    pub fn line(&self, text: &str) -> Result<(), Error> {
        self.raw(format!("{text}\n").as_bytes())
    }

    /// A result as it is, neither ff's text nor its JSON: a CSV, a shell's script.
    pub fn raw(&self, bytes: &[u8]) -> Result<(), Error> {
        let mut results = self.results.lock().unwrap_or_else(PoisonError::into_inner);
        results.write_all(bytes)?;
        results.flush()?;
        Ok(())
    }

    /// Something to fix that doesn't stop the command, on stderr.
    pub fn warn(&self, text: &str) {
        let label = if self.color { "\x1b[1;33mwarning:\x1b[0m" } else { "warning:" };
        let _ = writeln!(io::stderr().lock(), "{label} {text}");
    }

    /// Something worth knowing that isn't the command's result, on stderr: a newer version out.
    pub fn notice(&self, text: &str) {
        let label = if self.color { "\x1b[1;36mnotice:\x1b[0m" } else { "notice:" };
        let _ = writeln!(io::stderr().lock(), "{label} {text}");
    }

    /// What `--verbose` adds on stderr: what went wrong where nothing fails for it.
    pub fn detail(&self, text: &str) {
        if self.verbose {
            let _ = writeln!(io::stderr().lock(), "{text}");
        }
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

/// What an output wrote into its buffer, for its reader.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct Buffer(Arc<Mutex<Vec<u8>>>);

#[cfg(test)]
impl Buffer {
    /// What was written so far, as text.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap_or_else(PoisonError::into_inner)).into_owned()
    }
}

#[cfg(test)]
impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
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
        assert_eq!(error_text(&Error::usage("Bad JSON"), false), "error: Bad JSON");
        assert!(error_text(&refused(), true).starts_with("\x1b[1;31merror:\x1b[0m The function"));
    }

    #[test]
    fn the_results_go_where_the_output_was_made_to_write_them_a_document_then_lines_then_bytes_as_they_are() {
        let (out, buffer) = Output::buffered();
        out.result(&json!({ "name": "orders" }), || unreachable!("JSON asked")).unwrap();
        out.line("{\"message\":\"started\"}").unwrap();
        out.raw(b"function,calls\norders,3\n").unwrap();
        assert_eq!(
            buffer.text(),
            "{\n  \"name\": \"orders\"\n}\n{\"message\":\"started\"}\nfunction,calls\norders,3\n"
        );
    }

    #[test]
    fn an_error_as_json_has_its_message_exit_code_and_request_id() {
        assert_eq!(
            error_document(&refused()),
            json!({ "error": { "message": "The function failed to load", "exitCode": 3, "status": 400, "requestId": "7d1e5c1a" } })
        );
        assert_eq!(error_document(&Error::usage("Bad JSON"))["error"]["requestId"], serde_json::Value::Null);
    }
}

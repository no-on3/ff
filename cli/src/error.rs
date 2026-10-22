//! What can go wrong, and the exit code each kind gives a script (ADR 0002).

use std::fmt;
use std::io;

/// Why a command failed, as a script sees it: one exit code per kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// A bad argument that clap couldn't see, such as JSON that doesn't parse.
    Usage,
    /// Configuration, the connection, or an API error that isn't one of the kinds below.
    Failed,
    /// A deploy whose function never became ready.
    DeployFailed,
    /// An invocation whose function raised an error or timed out.
    InvocationFailed,
    /// Refused because of the account, not the request: no credit, a role or a key's scopes, the plan's rate.
    RefusedByAccount,
}

impl Kind {
    /// 2 is clap's own code for usage errors, so a bad argument gives 2 whoever finds it.
    pub fn exit_code(self) -> u8 {
        match self {
            Kind::Usage => 2,
            Kind::Failed => 3,
            Kind::DeployFailed => 4,
            Kind::InvocationFailed => 5,
            Kind::RefusedByAccount => 6,
        }
    }
}

/// A failed command: its kind, its message, and for the API's refusals, its status and the
/// request ID that finds the call in FF's logs.
#[derive(Debug)]
pub struct Error {
    pub kind: Kind,
    pub message: String,
    pub status: Option<u16>,
    pub request_id: Option<String>,
    /// The API's refusal as it wrote it, for a command that reads more in it, such as the
    /// invocation that failed.
    pub details: Option<serde_json::Value>,
    broken_pipe: bool,
}

impl Error {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        Error { kind, message: message.into(), status: None, request_id: None, details: None, broken_pipe: false }
    }

    pub fn exit_code(&self) -> u8 {
        self.kind.exit_code()
    }

    /// Whether the output's reader went away, which isn't the command's failure.
    pub fn is_broken_pipe(&self) -> bool {
        self.broken_pipe
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error {
            broken_pipe: error.kind() == io::ErrorKind::BrokenPipe,
            ..Error::new(Kind::Failed, format!("Couldn't write the output: {error}"))
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_has_the_exit_code_scripts_rely_on() {
        let codes: Vec<(Kind, u8)> =
            [Kind::Usage, Kind::Failed, Kind::DeployFailed, Kind::InvocationFailed, Kind::RefusedByAccount]
                .into_iter()
                .map(|kind| (kind, Error::new(kind, "x").exit_code()))
                .collect();

        assert_eq!(
            codes,
            [
                (Kind::Usage, 2),
                (Kind::Failed, 3),
                (Kind::DeployFailed, 4),
                (Kind::InvocationFailed, 5),
                (Kind::RefusedByAccount, 6)
            ]
        );
    }

    #[test]
    fn an_output_that_fails_is_a_failure_unless_its_reader_went_away() {
        let closed = Error::from(io::Error::from(io::ErrorKind::BrokenPipe));
        let full = Error::from(io::Error::from(io::ErrorKind::StorageFull));

        assert!(closed.is_broken_pipe());
        assert!(!full.is_broken_pipe());
        assert_eq!(full.exit_code(), 3);
        assert!(full.message.starts_with("Couldn't write the output: "), "{}", full.message);
    }
}

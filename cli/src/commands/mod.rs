//! One file per command.

mod completion;
mod version;

use crate::cli::Command;
use crate::error::Error;
use crate::output::Output;

pub fn run(command: Command, out: &Output) -> Result<(), Error> {
    match command {
        Command::Version => version::run(out),
        Command::Completion { shell } => completion::run(shell),
    }
}

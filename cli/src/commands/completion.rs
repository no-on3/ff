//! `ff completion <shell>`: the shell's completion script for every command and flag.

use std::io::{self, Write};

use clap::CommandFactory;
use clap_complete::Shell;

use crate::cli::Cli;
use crate::error::Error;

pub fn run(shell: Shell) -> Result<(), Error> {
    // Written in one piece, so that a reader that goes away is an error, not a panic.
    let mut script = Vec::new();
    clap_complete::generate(shell, &mut Cli::command(), "ff", &mut script);
    io::stdout().lock().write_all(&script)?;
    Ok(())
}

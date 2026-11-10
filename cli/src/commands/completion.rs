//! `ff completion <shell>`: the shell's completion script for every command and flag.

use clap::CommandFactory;
use clap_complete::Shell;

use crate::cli::Cli;
use crate::error::Error;
use crate::output::Output;

pub fn run(shell: Shell, out: &Output) -> Result<(), Error> {
    // Written in one piece, so that a reader that goes away is an error, not a panic.
    let mut script = Vec::new();
    clap_complete::generate(shell, &mut Cli::command(), "ff", &mut script);
    out.raw(&script)
}

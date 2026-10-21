//! `ff`, FF's command-line tool: one binary that works only through FF's API (ADR 0002).

mod cli;
mod commands;
mod error;
mod output;

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    let cli = cli::Cli::parse();
    let out = output::Output::new(&cli.global);
    match commands::run(cli.command, &out) {
        Ok(()) => ExitCode::SUCCESS,
        // A reader that stopped reading, as `ff … | head` does, isn't a failure.
        Err(error) if error.is_broken_pipe() => ExitCode::SUCCESS,
        Err(error) => {
            out.error(&error);
            ExitCode::from(error.exit_code())
        }
    }
}

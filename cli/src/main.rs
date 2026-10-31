//! `ff`, FF's command-line tool: one binary that works only through FF's API (ADR 0002).

mod api;
mod auth;
#[cfg(test)]
mod backend_source;
mod cli;
mod commands;
mod config;
mod error;
mod local;
mod local_url;
mod md5;
mod output;
mod package;
mod progress;
mod s3;
mod table;

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    let cli = cli::Cli::parse();
    let out = output::Output::new(&cli.global);
    let context = commands::Context { connection: &cli.global.connection, out: &out };
    match commands::run(cli.command, &context) {
        Ok(()) => ExitCode::SUCCESS,
        // A reader that stopped reading, as `ff … | head` does, isn't a failure.
        Err(error) if error.is_broken_pipe() => ExitCode::SUCCESS,
        Err(error) => {
            out.error(&error);
            ExitCode::from(error.exit_code())
        }
    }
}

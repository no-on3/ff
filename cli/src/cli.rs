//! The commands and flags, as clap reads them.

use clap::{Args, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;

/// `ff 0.1.0 (commit 1a2b3c4d5e6f)`, as `ff --version` and `ff version` print it.
pub const VERSION_TEXT: &str = concat!(env!("CARGO_PKG_VERSION"), " (commit ", env!("FF_COMMIT"), ")");

/// Deploy, invoke and read FF's functions, through FF's API.
#[derive(Parser)]
#[command(name = "ff", version = VERSION_TEXT, propagate_version = true)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalArgs,

    #[command(subcommand)]
    pub command: Command,
}

/// The flags every command takes.
#[derive(Args)]
pub struct GlobalArgs {
    /// Text for people, or one JSON document per command for scripts
    #[arg(long, global = true, value_enum, default_value_t = Format::Text)]
    pub output: Format,

    /// More detail
    #[arg(long, short, global = true)]
    pub verbose: bool,

    /// No colors (NO_COLOR in the environment says the same)
    #[arg(long, global = true)]
    pub no_color: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub enum Format {
    Text,
    Json,
}

#[derive(Subcommand)]
pub enum Command {
    /// Print ff's version, the commit it was built from, and the platform it was built for
    Version,

    /// Print a completion script for a shell, such as: ff completion bash > ~/.local/share/bash-completion/completions/ff
    Completion {
        /// The shell
        shell: Shell,
    },
}

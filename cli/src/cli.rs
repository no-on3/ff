//! The commands and flags, as clap reads them.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};
use clap_complete::Shell;

use crate::config::{is_account_id, is_profile_name};

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
    #[command(flatten)]
    pub connection: ConnectionArgs,

    /// Text for people, or one JSON document per command for scripts
    #[arg(long, global = true, value_enum, default_value_t = Format::Text)]
    pub output: Format,

    /// More detail
    #[arg(long, short, global = true, conflicts_with = "quiet")]
    pub verbose: bool,

    /// The result only: no progress or notes on stderr
    #[arg(long, short, global = true)]
    pub quiet: bool,

    /// No colors (NO_COLOR in the environment says the same)
    #[arg(long, global = true)]
    pub no_color: bool,
}

/// Which API, as whom: each overrides its environment variable and the profile.
#[derive(Args, Default, Debug)]
pub struct ConnectionArgs {
    /// The profile of ff's settings to use [env: FF_PROFILE] [default: default]
    #[arg(long, global = true, value_parser = profile_name)]
    pub profile: Option<String>,

    /// The API's address [env: FF_ENDPOINT] [default: http://localhost:3000]
    #[arg(long, global = true)]
    pub endpoint: Option<String>,

    /// The account to act for, when your login has several: 12 digits [env: FF_ACCOUNT]
    #[arg(long, global = true, value_parser = account_id)]
    pub account: Option<String>,

    /// Allow plain http:// to another machine than this one, such as a development stack's
    #[arg(long, global = true)]
    pub allow_http: bool,
}

fn profile_name(text: &str) -> Result<String, String> {
    if is_profile_name(text) {
        Ok(text.to_owned())
    } else {
        Err("a profile's name is letters, digits, '-' and '_'".to_owned())
    }
}

/// A metrics period: a minute, five, or an hour, as the API takes it.
fn period(text: &str) -> Result<u32, String> {
    match text {
        "60" | "300" | "3600" => Ok(text.parse().expect("digits")),
        _ => Err("a period is 60, 300 or 3600 seconds".to_owned()),
    }
}

fn account_id(text: &str) -> Result<String, String> {
    if is_account_id(text) { Ok(text.to_owned()) } else { Err("an account ID is 12 digits".to_owned()) }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub enum Format {
    Text,
    Json,
}

#[derive(Subcommand)]
pub enum Command {
    /// Make a function's folder: its handler, an event to call it with, and a README
    Init {
        /// The function's name, and its folder's
        name: String,

        /// Its runtime
        #[arg(long, value_enum)]
        runtime: Runtime,
    },

    /// Create a function from a file, or update the function of that name with what changed
    Deploy(DeployArgs),

    /// Call a function with an event, and print its answer
    Invoke(InvokeArgs),

    /// List the account's functions
    List,

    /// Show a function: its settings, its state, and its error when it has one
    Get {
        /// The function's name
        name: String,
    },

    /// Show a function's log lines: the newest of a window, every page of it, or the live tail
    Logs(LogsArgs),

    /// Show a function's recent calls, newest first, with their request IDs
    History {
        /// The function's name
        name: String,

        /// How many calls
        #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },

    /// Set how many instances a function keeps running when idle, and runs at most
    Scale {
        /// The function's name
        name: String,

        /// Instances kept running when idle, billed as AWS bills provisioned concurrency; 0 scales to zero
        #[arg(long)]
        min: Option<u32>,

        /// The most instances it runs at once, within the plan's limit
        #[arg(long)]
        max: Option<u32>,
    },

    /// Delete a function, with its history and its logs
    Delete {
        /// The function's name
        name: String,

        /// Don't ask first: a script must say it
        #[arg(long, short)]
        yes: bool,
    },

    /// Run a function on this machine, in Docker, as production runs it
    #[command(subcommand)]
    Local(LocalCommand),

    /// Say who the token is, an API key or a user, and the account it acts for
    Whoami,

    /// List the accounts the token reaches, the role in each, the current one marked
    Accounts,

    /// Show the current account: its status, the role in it, its plan's limits, its internet access
    Account,

    /// Show a month's usage per function, with its estimated cost
    Usage {
        /// The month, YYYY-MM, by the UTC calendar [default: this month]
        #[arg(long)]
        month: Option<String>,

        /// The API's CSV, for a spreadsheet
        #[arg(long)]
        csv: bool,
    },

    /// Show the account's balance, this month's charges, and whether calls go on
    Balance,

    /// Show a function's metrics, or the account's: invocations, errors, throttles, durations, a row per period
    Metrics {
        /// The function's name [default: the whole account]
        name: Option<String>,

        /// Seconds per row
        #[arg(long, default_value_t = 60, value_parser = period)]
        period: u32,

        /// How far back: 30m, 6h, 2d
        #[arg(long, default_value = "1h")]
        since: String,
    },

    /// ff's settings: the API's address, the account, the token
    #[command(subcommand)]
    Config(ConfigCommand),

    /// Print ff's version, the commit it was built from, and the platform it was built for
    Version,

    /// Print a completion script for a shell, such as: ff completion bash > ~/.local/share/bash-completion/completions/ff
    Completion {
        /// The shell
        shell: Shell,
    },
}

#[derive(Args)]
pub struct DeployArgs {
    /// The function's file: .ts, .js or .cjs for Node.js, .py for Python
    pub file: PathBuf,

    /// Its name, else the file's without its extension, or for function.ts or .py, its folder's
    #[arg(long)]
    pub name: Option<String>,

    /// Its runtime, else the file's extension says
    #[arg(long, value_enum)]
    pub runtime: Option<Runtime>,

    /// Memory in MB [default for a new function: 128]
    #[arg(long)]
    pub memory: Option<u32>,

    /// Timeout in seconds [default for a new function: 5]
    #[arg(long)]
    pub timeout: Option<u32>,

    /// Instances kept running when idle, once it is live
    #[arg(long)]
    pub min_instances: Option<u32>,

    /// The most instances it runs at once
    #[arg(long)]
    pub max_instances: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub enum Runtime {
    Nodejs,
    Python,
}

impl Runtime {
    pub fn as_str(self) -> &'static str {
        match self {
            Runtime::Nodejs => "nodejs",
            Runtime::Python => "python",
        }
    }
}

#[derive(Args)]
pub struct InvokeArgs {
    /// The function's name
    pub name: String,

    /// The event: JSON, @file for a file's, or - for stdin's [default: {}]
    #[arg(long, short)]
    pub data: Option<String>,

    /// Print the answer only, as compact JSON, for a pipe
    #[arg(long)]
    pub raw: bool,
}

#[derive(Args)]
pub struct LogsArgs {
    /// The function's name
    pub name: String,

    /// How many lines: the newest of the window
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
    pub tail: u32,

    /// The window starts this long ago: 30s, 15m, 2h, 1d
    #[arg(long, conflicts_with = "start")]
    pub since: Option<String>,

    /// The window's start, RFC 3339, such as 2026-10-21T09:00:00Z
    #[arg(long)]
    pub start: Option<String>,

    /// The window's end, RFC 3339 [default: now]
    #[arg(long)]
    pub end: Option<String>,

    /// Only the lines with this phrase, as whole words, case included
    #[arg(long)]
    pub grep: Option<String>,

    /// Only one call's lines: the request ID that ff invoke and ff history show
    #[arg(long)]
    pub request_id: Option<String>,

    /// Every line of the window, page after page, rather than the newest
    #[arg(long)]
    pub all: bool,

    /// Then each new line as it comes, until Ctrl-C
    #[arg(long, short)]
    pub follow: bool,

    /// With --follow, ask every 2 s rather than hold a stream open, through a proxy that holds streams back
    #[arg(long, requires = "follow")]
    pub poll: bool,
}

#[derive(Subcommand)]
pub enum LocalCommand {
    /// Run it once, and print its answer and its log; the container is removed after
    Invoke {
        #[command(flatten)]
        function: LocalArgs,

        /// The event: JSON, @file for a file's, or - for stdin's [default: {}]
        #[arg(long, short)]
        data: Option<String>,

        /// Print the answer only, as compact JSON, for a pipe
        #[arg(long)]
        raw: bool,
    },

    /// Keep it running on a port of this machine, its log as it comes, until Ctrl-C
    Start {
        #[command(flatten)]
        function: LocalArgs,

        /// The port on 127.0.0.1 [default: any free one]
        #[arg(long)]
        port: Option<u16>,

        /// Start it again when its code changes
        #[arg(long)]
        watch: bool,
    },
}

#[derive(Args)]
pub struct LocalArgs {
    /// The function's file, or its folder with a function.ts, .js, .cjs or .py
    pub path: PathBuf,

    /// Its name, as its context gives it, else the file's or the folder's
    #[arg(long)]
    pub name: Option<String>,

    /// Its runtime, else the file's extension says
    #[arg(long, value_enum)]
    pub runtime: Option<Runtime>,

    /// Memory in MB, the container's limit
    #[arg(long, default_value_t = 128, value_parser = clap::value_parser!(u32).range(128..=10240))]
    pub memory: u32,

    /// Timeout in seconds
    #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u32).range(1..=900))]
    pub timeout: u32,
}

#[derive(Subcommand)]
pub enum ConfigCommand {
    /// Set one of the profile's settings
    Set {
        /// endpoint (the API's address), account (for a login with several), dev_account (the account a development stack acts as) or allow_http (true for plain http to a development stack)
        key: ConfigKey,
        value: String,
    },

    /// Remove one of the profile's settings, or its token
    Unset { key: ConfigKey },

    /// Show the settings in effect, and where each comes from; the token masked
    Show,

    /// Save an API key for the profile, read from a prompt that doesn't show it, or from stdin
    SetToken,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum ConfigKey {
    Endpoint,
    Account,
    DevAccount,
    AllowHttp,
    Token,
}

impl ConfigKey {
    /// Its name in config.toml, as typed.
    pub fn name(self) -> &'static str {
        match self {
            ConfigKey::Endpoint => "endpoint",
            ConfigKey::Account => "account",
            ConfigKey::DevAccount => "dev_account",
            ConfigKey::AllowHttp => "allow_http",
            ConfigKey::Token => "token",
        }
    }
}

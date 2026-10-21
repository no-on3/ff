//! The commands and flags, as clap reads them.

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
    #[arg(long, short, global = true)]
    pub verbose: bool,

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
    /// Say who the token is, an API key or a user, and the account it acts for
    Whoami,

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

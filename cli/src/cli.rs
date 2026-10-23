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

    /// Create a function from a file or a folder, or update the function of that name with what changed
    Deploy(DeployArgs),

    /// Make a function's folder a zip with its libraries, as AWS Lambda takes one; ff deploy makes its own
    Package(PackageArgs),

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

    /// A function's environment variables, as AWS Lambda's: readable like its code
    #[command(subcommand)]
    Env(EnvCommand),

    /// A function's secrets: variables whose values nobody reads back
    #[command(subcommand)]
    Secrets(SecretsCommand),

    /// A function's web address, as AWS Lambda's function URLs
    #[command(subcommand)]
    Url(UrlCommand),

    /// The account's own domains for a function's URL, proved by DNS
    #[command(subcommand)]
    Domains(DomainsCommand),

    /// A function's schedules: runs at the times an EventBridge expression names, in UTC
    #[command(subcommand)]
    Schedule(ScheduleCommand),

    /// The account's PostgreSQL databases, as AWS RDS gives them
    #[command(subcommand)]
    Db(DbCommand),

    /// The account's buckets, as AWS S3 gives them, and its access keys to them
    #[command(subcommand)]
    Buckets(BucketsCommand),

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
    /// The function's file, its code alone: .ts, .js or .cjs for Node.js, .py for Python; or its folder, which ff packages with its libraries
    pub path: PathBuf,

    /// Its name, else the file's without its extension, or for function.ts or .py, its folder's; a folder's own
    #[arg(long)]
    pub name: Option<String>,

    /// Its runtime, else the file's extension says, or a folder's package.json (nodejs), requirements.txt or pyproject.toml (python)
    #[arg(long, value_enum)]
    pub runtime: Option<Runtime>,

    /// What the runtime calls, as AWS Lambda's handler: <file>.<function>, such as src/app.handler [default: the function's, else function.handler; for a folder, index.handler or lambda_function.lambda_handler when it has that file]
    #[arg(long)]
    pub handler: Option<String>,

    #[command(flatten)]
    pub build: BuildArgs,

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

    /// Its environment variables, KEY=value, repeated: all of them, as on Lambda, those not named removed
    #[arg(long = "env", value_name = "KEY=value")]
    pub env: Vec<String>,
}

/// How a folder's libraries go into its package.
#[derive(Args)]
pub struct BuildArgs {
    /// Install the libraries in a container of the runtime's base, for its platform exactly, as sam build --use-container: Docker
    #[arg(long, conflicts_with = "no_build")]
    pub container: bool,

    /// Install nothing: the folder as it is, its node_modules included
    #[arg(long)]
    pub no_build: bool,
}

#[derive(Args)]
pub struct PackageArgs {
    /// The function's folder
    #[arg(default_value = ".")]
    pub folder: PathBuf,

    /// The zip to write [default: the folder's .ff/<name>.zip, which no package holds]
    #[arg(long, value_name = "FILE")]
    pub zip: Option<PathBuf>,

    /// Its runtime, else package.json says nodejs, requirements.txt or pyproject.toml python
    #[arg(long, value_enum)]
    pub runtime: Option<Runtime>,

    /// The handler to look for in the package [default: function.handler, else index.handler or lambda_function.lambda_handler when it has that file]
    #[arg(long)]
    pub handler: Option<String>,

    #[command(flatten)]
    pub build: BuildArgs,

    /// Compile TypeScript with the project's own tsc, leaving out its sources, for AWS Lambda, which runs JavaScript alone
    #[arg(long, conflicts_with = "no_build")]
    pub compile: bool,
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

    /// Call it through its URL instead, as a browser or a webhook does: a method and a path, such as GET /orders?status=new
    #[arg(long, num_args = 2, value_names = ["METHOD", "PATH"], conflicts_with_all = ["asynchronous", "dry_run"])]
    pub http: Option<Vec<String>>,

    /// Run it without waiting, as AWS Lambda's invocation type Event: its request ID at once, and the call retried on
    /// failure; ff history shows its attempts
    #[arg(long = "async", id = "asynchronous", conflicts_with = "dry_run")]
    pub asynchronous: bool,

    /// Only check that the call could be made, as Lambda's invocation type DryRun: nothing runs
    #[arg(long)]
    pub dry_run: bool,

    /// With --http, a header of the request, "name: value", repeated
    #[arg(long = "header", short = 'H', requires = "http")]
    pub headers: Vec<String>,
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

        /// Serve it as its URL would: any request calls it with AWS Lambda's URL event, its answer the response
        #[arg(long)]
        url: bool,
    },
}

#[derive(Args)]
pub struct LocalArgs {
    /// The function's file, or its folder with a function.ts, .js, .mjs, .cjs or .py
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

    /// Environment variables for the run, KEY=value, repeated
    #[arg(long = "env", value_name = "KEY=value")]
    pub env: Vec<String>,
}

#[derive(Subcommand)]
pub enum EnvCommand {
    /// List its variables' names, and with --show their values
    List {
        /// The function's name
        name: String,

        /// Their values too
        #[arg(long)]
        show: bool,
    },

    /// Set variables, KEY=value; a KEY alone reads its value from stdin, or a prompt, which the shell doesn't keep
    Set {
        /// The function's name
        name: String,

        /// KEY=value, or KEY
        #[arg(required = true)]
        variables: Vec<String>,
    },

    /// Remove variables
    Unset {
        /// The function's name
        name: String,

        /// Their names
        #[arg(required = true)]
        keys: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum DbCommand {
    /// Make a database and its user: its connection string, with its password, printed this once
    Create {
        /// Its name: lower-case letters, digits and hyphens, as AWS RDS names its databases
        name: String,

        #[command(flatten)]
        secret: SecretFor,
    },

    /// List the account's databases: their status, storage and sessions now
    List,

    /// Show a database: how to reach it, its storage and sessions now
    Get {
        /// The database's name
        name: String,
    },

    /// Give a database a new password: its connection string printed this once; the old one opens no new session
    Password {
        /// The database's name
        name: String,

        #[command(flatten)]
        secret: SecretFor,
    },

    /// Delete a database and its user, with its data
    Delete {
        /// The database's name
        name: String,

        /// Don't ask first: a script must say it
        #[arg(long, short)]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub enum BucketsCommand {
    /// Make a bucket: its name unique across FF, as on AWS
    Create {
        /// Its name: lower-case letters, digits and hyphens, as AWS names buckets, without dots
        name: String,
    },

    /// List the account's buckets
    List,

    /// Show a bucket: its endpoint, address and region
    Get {
        /// The bucket's name
        name: String,
    },

    /// Delete a bucket: an empty one, or with --force every file in it first
    Delete {
        /// The bucket's name
        name: String,

        /// Delete its files first, and the uploads under way
        #[arg(long)]
        force: bool,

        /// Don't ask first: a script must say it
        #[arg(long, short)]
        yes: bool,
    },

    /// The account's access keys to its buckets, for AWS's SDKs and CLI
    #[command(subcommand)]
    Keys(BucketKeysCommand),
}

#[derive(Subcommand)]
pub enum BucketKeysCommand {
    /// List the account's access keys: what each reaches, when it was last used; never a secret
    List,

    /// Make an access key: its secret printed this once, as the variables AWS's tools read
    Create {
        /// A bucket it reaches, by name; again for each; all the account's without it
        #[arg(long = "bucket", value_name = "NAME")]
        buckets: Vec<String>,

        /// Reads and lists only: no upload, copy or delete
        #[arg(long)]
        read_only: bool,
    },

    /// Revoke an access key: whatever uses it is refused at once
    Revoke {
        /// The access key ID, AKFF and 16 characters
        id: String,

        /// Don't ask first: a script must say it
        #[arg(long, short)]
        yes: bool,
    },
}

/// Where the connection string goes besides the terminal: functions' secrets.
#[derive(Args)]
pub struct SecretFor {
    /// Set the connection string as a secret of this function too, which rolls it out; again for each function
    #[arg(long = "secret-for", value_name = "FUNCTION")]
    pub functions: Vec<String>,

    /// The secret's name, which the function reads from its environment
    #[arg(long, default_value = "DATABASE_URL", value_name = "NAME")]
    pub secret_name: String,
}

#[derive(Subcommand)]
pub enum SecretsCommand {
    /// List its secrets: their names, and when each was set; never a value
    List {
        /// The function's name
        name: String,
    },

    /// Set secrets: each value from a prompt that doesn't show it, or a line of stdin each, never the command line
    Set {
        /// The function's name
        name: String,

        /// The secrets' names
        #[arg(required = true)]
        secrets: Vec<String>,
    },

    /// Remove secrets
    Unset {
        /// The function's name
        name: String,

        /// The secrets' names
        #[arg(required = true)]
        secrets: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum UrlCommand {
    /// Show its address, who may call it, its CORS and its domains
    Show {
        /// The function's name
        name: String,
    },

    /// Give it a URL, or change who may call it and its CORS
    Enable {
        /// The function's name
        name: String,

        /// Who may call it: none, anyone; key, the account's API keys with functions:invoke. Needed for a new URL
        #[arg(long, value_enum)]
        auth: Option<UrlAuth>,

        /// A site whose browsers may call it (CORS), such as https://shop.example.tn, repeated
        #[arg(long = "cors-origin")]
        cors_origins: Vec<String>,

        /// A method those browsers may use, repeated
        #[arg(long = "cors-method")]
        cors_methods: Vec<String>,

        /// A header those browsers may send, repeated
        #[arg(long = "cors-header")]
        cors_headers: Vec<String>,
    },

    /// Delete its URL: it stops answering at once
    Disable {
        /// The function's name
        name: String,

        /// Don't ask first: a script must say it
        #[arg(long, short)]
        yes: bool,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub enum UrlAuth {
    None,
    Key,
}

#[derive(Subcommand)]
pub enum DomainsCommand {
    /// List its URL's domains, verified or not
    List {
        /// The function's name
        name: String,
    },

    /// Add a domain of the account's, and show the DNS records that prove it
    Add {
        /// The function's name
        name: String,

        /// The domain, such as shop.example.tn
        domain: String,
    },

    /// Check the domain's DNS records again
    Verify {
        /// The function's name
        name: String,

        /// The domain
        domain: String,
    },

    /// Remove a domain: the URL stops answering there
    Remove {
        /// The function's name
        name: String,

        /// The domain
        domain: String,

        /// Don't ask first: a script must say it
        #[arg(long, short)]
        yes: bool,
    },
}

#[derive(Subcommand)]
pub enum ScheduleCommand {
    /// List its schedules: each one's expression, whether it runs, its next run and how its last went
    List {
        /// The function's name
        name: String,
    },

    /// Make a schedule, or change its expression, input or description; then say its next runs
    Set {
        /// The function's name
        name: String,

        /// EventBridge's, in UTC: rate(5 minutes), rate(1 hour), cron(0 2 * * ? *)…
        expression: String,

        /// The schedule's name, unique within the function
        #[arg(long = "name", default_value = "schedule")]
        schedule: String,

        /// The function's event: JSON, @file or - for stdin [default: EventBridge's Scheduled Event]
        #[arg(long)]
        input: Option<String>,

        /// Back to EventBridge's Scheduled Event, rather than the input it has
        #[arg(long)]
        no_input: bool,

        /// What it is for
        #[arg(long)]
        description: Option<String>,

        /// Made, or kept, without running
        #[arg(long)]
        disabled: bool,
    },

    /// Let a schedule run again, from now
    Enable {
        /// The function's name
        name: String,

        /// The schedule's name
        #[arg(long = "name", default_value = "schedule")]
        schedule: String,
    },

    /// Stop a schedule's runs, keeping it
    Disable {
        /// The function's name
        name: String,

        /// The schedule's name
        #[arg(long = "name", default_value = "schedule")]
        schedule: String,
    },

    /// Remove a schedule: it runs no more
    Remove {
        /// The function's name
        name: String,

        /// The schedule's name
        #[arg(long = "name", default_value = "schedule")]
        schedule: String,
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

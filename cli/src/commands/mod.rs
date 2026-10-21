//! One file per command.

mod account;
mod completion;
mod config;
mod deploy;
mod env;
mod functions;
mod init;
mod invoke;
mod local;
mod logs;
mod package;
mod schedule;
mod secrets;
mod url;
mod version;
mod whoami;

use crate::cli::{
    Command, ConnectionArgs, DomainsCommand, EnvCommand, LocalCommand, ScheduleCommand, SecretsCommand, UrlCommand,
};
use crate::config::Settings;
use crate::error::Error;
use crate::output::Output;

/// What a command works with: the connection's flags, and where its output goes.
pub struct Context<'a> {
    pub connection: &'a ConnectionArgs,
    pub out: &'a Output,
}

impl Context<'_> {
    /// The settings in effect, after saying what in ff's files needs fixing.
    pub fn settings(&self) -> Result<Settings, Error> {
        let settings = crate::config::load(self.connection)?;
        for warning in &settings.warnings {
            self.out.warn(warning);
        }
        Ok(settings)
    }
}

pub fn run(command: Command, context: &Context) -> Result<(), Error> {
    match command {
        Command::Init { name, runtime } => init::run(&name, runtime, context),
        Command::Deploy(args) => deploy::run(args, context),
        Command::Package(args) => package::run(args, context),
        Command::Invoke(args) => invoke::run(args, context),
        Command::List => functions::list(context),
        Command::Get { name } => functions::get(&name, context),
        Command::Logs(args) => logs::run(args, context),
        Command::History { name, limit } => functions::history(&name, limit, context),
        Command::Scale { name, min, max } => functions::scale(&name, min, max, context),
        Command::Delete { name, yes } => functions::delete(&name, yes, context),
        Command::Local(LocalCommand::Invoke { function, data, raw }) => {
            local::invoke(&function, data.as_deref(), raw, context)
        }
        Command::Local(LocalCommand::Start { function, port, watch, url }) => {
            local::start(&function, port, watch, url, context)
        }
        Command::Env(EnvCommand::List { name, show }) => env::list(&name, show, context),
        Command::Env(EnvCommand::Set { name, variables }) => env::set(&name, &variables, context),
        Command::Env(EnvCommand::Unset { name, keys }) => env::unset(&name, &keys, context),
        Command::Secrets(SecretsCommand::List { name }) => secrets::list(&name, context),
        Command::Secrets(SecretsCommand::Set { name, secrets }) => secrets::set(&name, &secrets, context),
        Command::Secrets(SecretsCommand::Unset { name, secrets }) => secrets::unset(&name, &secrets, context),
        Command::Url(UrlCommand::Show { name }) => url::show(&name, context),
        Command::Url(UrlCommand::Enable { name, auth, cors_origins, cors_methods, cors_headers }) => {
            url::enable(&name, auth, url::cors(&cors_origins, &cors_methods, &cors_headers), context)
        }
        Command::Url(UrlCommand::Disable { name, yes }) => url::disable(&name, yes, context),
        Command::Domains(DomainsCommand::List { name }) => url::domains_list(&name, context),
        Command::Domains(DomainsCommand::Add { name, domain }) => url::domains_add(&name, &domain, context),
        Command::Domains(DomainsCommand::Verify { name, domain }) => url::domains_verify(&name, &domain, context),
        Command::Domains(DomainsCommand::Remove { name, domain, yes }) => {
            url::domains_remove(&name, &domain, yes, context)
        }
        Command::Schedule(ScheduleCommand::List { name }) => schedule::list(&name, context),
        Command::Schedule(ScheduleCommand::Set {
            name,
            expression,
            schedule,
            input,
            no_input,
            description,
            disabled,
        }) => {
            let input = schedule::input(input.as_deref())?;
            let changes = schedule::ScheduleChanges { expression, input, no_input, description, disabled };
            schedule::set(&name, &schedule, changes, context)
        }
        Command::Schedule(ScheduleCommand::Enable { name, schedule }) => {
            schedule::enable(&name, &schedule, true, context)
        }
        Command::Schedule(ScheduleCommand::Disable { name, schedule }) => {
            schedule::enable(&name, &schedule, false, context)
        }
        Command::Schedule(ScheduleCommand::Remove { name, schedule }) => schedule::remove(&name, &schedule, context),
        Command::Whoami => whoami::run(context),
        Command::Accounts => account::accounts(context),
        Command::Account => account::account(context),
        Command::Usage { month, csv } => account::usage(month.as_deref(), csv, context),
        Command::Balance => account::balance(context),
        Command::Metrics { name, period, since } => account::metrics(name.as_deref(), period, &since, context),
        Command::Config(command) => config::run(command, context),
        Command::Version => version::run(context.out),
        Command::Completion { shell } => completion::run(shell),
    }
}

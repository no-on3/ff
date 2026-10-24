//! One file per command.

mod account;
mod async_config;
mod buckets;
mod completion;
mod config;
mod db;
mod deploy;
mod env;
mod event_sources;
mod functions;
mod init;
mod invoke;
mod local;
mod logs;
mod package;
mod queues;
mod schedule;
mod secrets;
mod url;
mod version;
mod whoami;

use crate::cli::{
    BucketKeysCommand, BucketsCommand, Command, ConnectionArgs, DbCommand, DomainsCommand, EnvCommand,
    EventSourcesCommand, LocalCommand, QueuesCommand, ScheduleCommand, SecretsCommand, UrlCommand,
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
        Command::AsyncConfig(args) => async_config::run(args, context),
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
        Command::Db(DbCommand::Create { name, secret }) => {
            db::create(&name, &secret.functions, &secret.secret_name, context)
        }
        Command::Db(DbCommand::List) => db::list(context),
        Command::Db(DbCommand::Get { name }) => db::get(&name, context),
        Command::Db(DbCommand::Password { name, secret }) => {
            db::password(&name, &secret.functions, &secret.secret_name, context)
        }
        Command::Db(DbCommand::Delete { name, yes }) => db::delete(&name, yes, context),
        Command::Buckets(BucketsCommand::Create { name }) => buckets::create(&name, context),
        Command::Buckets(BucketsCommand::List) => buckets::list(context),
        Command::Buckets(BucketsCommand::Get { name }) => buckets::get(&name, context),
        Command::Buckets(BucketsCommand::Delete { name, force, yes }) => buckets::delete(&name, force, yes, context),
        Command::Buckets(BucketsCommand::Keys(BucketKeysCommand::List)) => buckets::keys_list(context),
        Command::Buckets(BucketsCommand::Keys(BucketKeysCommand::Create { buckets, queues, read_only })) => {
            buckets::keys_create(&buckets, &queues, read_only, context)
        }
        Command::Buckets(BucketsCommand::Keys(BucketKeysCommand::Revoke { id, yes })) => {
            buckets::keys_revoke(&id, yes, context)
        }
        Command::Queues(QueuesCommand::Create { name, attributes }) => queues::create(&name, &attributes, context),
        Command::Queues(QueuesCommand::List) => queues::list(context),
        Command::Queues(QueuesCommand::Get { name }) => queues::get(&name, context),
        Command::Queues(QueuesCommand::Set { name, attributes, no_dead_letter_queue }) => {
            queues::set(&name, &attributes, no_dead_letter_queue, context)
        }
        Command::Queues(QueuesCommand::Send { name, body, delay, attributes }) => {
            queues::send(&name, &body, delay.as_deref(), &attributes, context)
        }
        Command::Queues(QueuesCommand::Receive { name, max, wait, visibility_timeout, delete }) => {
            queues::receive(&name, max, wait.as_deref(), visibility_timeout.as_deref(), delete, context)
        }
        Command::Queues(QueuesCommand::DeleteMessage { name, receipt_handle }) => {
            queues::delete_message(&name, &receipt_handle, context)
        }
        Command::Queues(QueuesCommand::Purge { name, yes }) => queues::purge(&name, yes, context),
        Command::Queues(QueuesCommand::Delete { name, yes }) => queues::delete(&name, yes, context),
        Command::EventSources(EventSourcesCommand::Add {
            queue,
            function,
            batches,
            report_batch_item_failures,
            disabled,
        }) => {
            let settings = event_sources::Settings {
                batch_size: batches.batch_size,
                batching_window: batches.batching_window.as_deref(),
                report_batch_item_failures: report_batch_item_failures.then_some(true),
                max_concurrency: batches.max_concurrency.map(Some),
                enabled: disabled.then_some(false),
            };
            event_sources::add(&queue, &function, &settings, context)
        }
        Command::EventSources(EventSourcesCommand::List { function, queue }) => {
            event_sources::list(function.as_deref(), queue.as_deref(), context)
        }
        Command::EventSources(EventSourcesCommand::Get { uuid }) => event_sources::get(&uuid, context),
        Command::EventSources(EventSourcesCommand::Update {
            uuid,
            batches,
            report_batch_item_failures,
            no_report_batch_item_failures,
            no_max_concurrency,
            enable,
            disable,
        }) => {
            let settings = event_sources::Settings {
                batch_size: batches.batch_size,
                batching_window: batches.batching_window.as_deref(),
                report_batch_item_failures: if report_batch_item_failures {
                    Some(true)
                } else {
                    no_report_batch_item_failures.then_some(false)
                },
                max_concurrency: if no_max_concurrency { Some(None) } else { batches.max_concurrency.map(Some) },
                enabled: if enable { Some(true) } else { disable.then_some(false) },
            };
            event_sources::update(&uuid, &settings, context)
        }
        Command::EventSources(EventSourcesCommand::Remove { uuid, yes }) => event_sources::remove(&uuid, yes, context),
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

//! One file per command.

mod completion;
mod config;
mod deploy;
mod functions;
mod init;
mod invoke;
mod local;
mod logs;
mod version;
mod whoami;

use crate::cli::{Command, ConnectionArgs, LocalCommand};
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
        Command::Local(LocalCommand::Start { function, port, watch }) => local::start(&function, port, watch, context),
        Command::Whoami => whoami::run(context),
        Command::Config(command) => config::run(command, context),
        Command::Version => version::run(context.out),
        Command::Completion { shell } => completion::run(shell),
    }
}

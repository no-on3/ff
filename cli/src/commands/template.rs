//! A SAM template as `ff deploy` reads it (ADR 0016): its text, where its code and its samconfig.toml are, the stack's
//! name, the parameters' values given, and every problem found before anything is made, each at its line, as one
//! refusal.

use std::path::{Path, PathBuf};

use crate::error::Error;
use crate::output::Output;
use crate::sam::parameters::{self, SAMCONFIG, Samconfig, Values};
use crate::sam::{self, Template, subset};

/// A stack's name, as CloudFormation takes one: letters, digits and hyphens, a letter first, 128 at most.
pub(super) fn is_stack_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes.next().is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Whether a command was given a SAM template: a .yaml or .yml file.
pub fn is_template(path: &Path) -> bool {
    path.is_file() && path.extension().is_some_and(|extension| extension == "yaml" || extension == "yml")
}

/// Where a template's code and its samconfig.toml are. `sam build`'s template, in `.aws-sam/build`, names the folders
/// it built, which ff deploys as they are; its project, and samconfig.toml, are two folders up.
pub(super) struct Location {
    pub folder: PathBuf,
    pub project: PathBuf,
    pub built: bool,
}

impl Location {
    pub fn of(template: &Path) -> Location {
        let folder_of = |path: Option<&Path>| match path {
            Some(path) if !path.as_os_str().is_empty() => path.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let folder = folder_of(template.parent());
        let built = folder.ends_with(".aws-sam/build");
        let project = if built { folder_of(folder.parent().and_then(Path::parent)) } else { folder.clone() };
        Location { folder, project, built }
    }
}

/// The folder's samconfig.toml as `sam deploy` reads it, if it has one.
pub(super) fn samconfig(folder: &Path) -> Result<Option<Samconfig>, Error> {
    let path = folder.join(SAMCONFIG);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(None) };
    parameters::samconfig(&text)
        .map(Some)
        .map_err(|why| Error::usage(format!("{}: the SAM CLI can't read it for `sam deploy`: {why}", path.display())))
}

/// A template's problems, each at its line, as one refusal that says what the command didn't do.
pub(super) struct Problems<'a> {
    file: &'a str,
    template: &'a Template,
    nothing: &'static str,
    found: Vec<String>,
}

impl Problems<'_> {
    /// A problem at a value of the template, or where its resource starts when the value is the Globals'.
    pub fn at(&mut self, pointer: &str, message: &str) {
        let resource: String = pointer.split('/').take(3).collect::<Vec<_>>().join("/");
        let line = self.template.line(pointer).or_else(|| self.template.line(&resource));
        self.line(line, message);
    }

    pub fn line(&mut self, line: Option<usize>, message: &str) {
        let file = &self.file;
        self.found.push(match line {
            Some(line) => format!("{file}:{line}: {message}"),
            None => format!("{file}: {message}"),
        });
    }

    pub fn refusal(self) -> Result<(), Error> {
        match self.found.len() {
            0 => Ok(()),
            count => Err(Error::usage(format!(
                "{}: the template has {}\n{}",
                self.nothing,
                if count == 1 { "a problem".to_owned() } else { format!("{count} problems") },
                self.found.join("\n")
            ))),
        }
    }
}

/// A template read, and what was given with it: the stack's name and the parameters' values.
pub(super) struct Read {
    /// The template's path as given, which messages name.
    pub file: String,
    pub text: String,
    pub template: Template,
    pub at: Location,
    pub stack_name: String,
    /// The parameters' values given, from `--parameter-overrides`, else samconfig.toml.
    pub given: Vec<(String, String)>,
    /// Where they were given.
    pub from: &'static str,
}

impl Read {
    /// The template at `path`, refused where CloudFormation can't read it; the stack's name, `--stack-name`'s, else
    /// samconfig.toml's, else `unnamed`'s; the parameters' values, `--parameter-overrides`', else samconfig.toml's.
    pub fn of(
        path: &Path,
        stack_name: Option<&str>,
        overrides: &[String],
        unnamed: impl FnOnce(&Location) -> Result<String, Error>,
    ) -> Result<Read, Error> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| Error::usage(format!("Couldn't read {} as UTF-8 text: {error}", path.display())))?;
        let file = path.display().to_string();
        let template = sam::read(&text).map_err(|error| {
            Error::usage(format!(
                "{file}:{}: CloudFormation can't read it, at column {}: {}",
                error.at.line, error.at.column, error.message
            ))
        })?;
        let at = Location::of(path);
        let config = samconfig(&at.project)?;
        let stack_name = match (stack_name, config.as_ref().and_then(|config| config.stack_name.as_deref())) {
            (Some(name), _) | (None, Some(name)) => name.to_owned(),
            (None, None) => unnamed(&at)?,
        };
        if !is_stack_name(&stack_name) {
            return Err(Error::usage(format!(
                "{stack_name} can't be a stack's name: letters, digits and hyphens, a letter first, 128 at most, as CloudFormation's"
            )));
        }
        let (given, from) = if overrides.is_empty() {
            (config.map(|config| config.parameter_overrides).unwrap_or_default(), SAMCONFIG)
        } else {
            let overrides = parameters::overrides(overrides)
                .map_err(|why| Error::usage(format!("--parameter-overrides: {why}")))?;
            (overrides, "--parameter-overrides")
        };
        Ok(Read { file, text, template, at, stack_name, given, from })
    }

    /// No problem yet; `nothing` says what the command didn't do when it refuses.
    pub fn problems(&self, nothing: &'static str) -> Problems<'_> {
        Problems { file: &self.file, template: &self.template, nothing, found: Vec::new() }
    }

    /// The parameters' values from those `given`, the template's Default for the rest; and the problems they and the
    /// template have, what is outside FF's subset included, which `ff doctor` warns of since AWS takes it. A value
    /// given for no parameter is warned of: `command` passes it over, as `sam deploy` does.
    pub fn checked(
        &self,
        given: &[(String, String)],
        command: &str,
        nothing: &'static str,
        out: &Output,
    ) -> (Values, Problems<'_>) {
        let values = parameters::values(&self.template, given);
        let mut problems = self.problems(nothing);
        let parameter_line = |name: &str| self.template.line(&format!("/Parameters/{name}"));
        for problem in subset::check(&self.template, &values.values) {
            problems.line(problem.line, &problem.message);
        }
        for (name, why) in &values.refused {
            problems.line(parameter_line(name), &format!("the parameter {name}: {why}, which CloudFormation refuses"));
        }
        for name in &values.missing {
            problems.line(
                parameter_line(name),
                &format!("the parameter {name} has no Default and no value: give one with --parameter-overrides {name}=…, or in {SAMCONFIG}"),
            );
        }
        for name in &values.unknown {
            out.warn(&format!(
                "{} gives {name}, which the template has no parameter for: {command} passes it over, as `sam deploy` does",
                self.from
            ));
        }
        (values, problems)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stacks_name_is_cloudformations() {
        assert!(is_stack_name("shop-prod2"));
        for refused in ["", "2shop", "shop_prod", "shop.prod", &"s".repeat(129)] {
            assert!(!is_stack_name(refused), "{refused}");
        }
    }

    #[test]
    fn sam_builds_template_names_its_built_folders_and_its_project_is_two_folders_up() {
        let built = Location::of(Path::new("app/.aws-sam/build/template.yaml"));
        assert_eq!((built.folder, built.project, built.built), ("app/.aws-sam/build".into(), "app".into(), true));
        let here = Location::of(Path::new(".aws-sam/build/template.yaml"));
        assert_eq!((here.project, here.built), (".".into(), true));
        let source = Location::of(Path::new("template.yaml"));
        assert_eq!((source.folder, source.project, source.built), (".".into(), ".".into(), false));
    }
}

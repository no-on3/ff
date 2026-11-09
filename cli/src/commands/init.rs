//! `ff init <name>`: a function's folder, its handler and an event to call it with, with AWS
//! Lambda's handler and event; or, with `--template terraform`, an app's Terraform project, FF's
//! provider block and four modules that apply on FF and, with only that block changed, on AWS;
//! or, with `--template sam`, a SAM application, which `ff deploy` and `sam deploy` both take.
//! From templates the binary holds.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::Context;
use super::account;
use crate::api::Client;
use crate::api::types::AwsEndpoints;
use crate::cli::{Runtime, Template};
use crate::config::is_function_name;
use crate::error::{Error, Kind};

/// A template's files, each by its path in the template's folder under `cli/templates/` and its text: those under
/// `nodejs/` and `python/` are that runtime's alone, written without that folder; the others are both runtimes'. A
/// `gitignore` is written as `.gitignore`, which in this repository would apply to the repository itself.
type Files = &'static [(&'static str, &'static str)];

/// The files of the template whose folder is named, in the order they are written.
macro_rules! template_files {
    ($folder:literal, [$($path:literal),* $(,)?]) => {
        &[$(($path, include_str!(concat!("../../templates/", $folder, "/", $path)))),*]
    };
}

/// A function's folder: its handler in the runtime's language, an event to call it with, and a README.
const FUNCTION: Files =
    template_files!("function", ["nodejs/function.ts", "python/function.py", "events/event.json", "README.md"]);

/// A Terraform project: FF's provider block, the app's four modules, its site, and its three functions' handlers.
const TERRAFORM: Files = template_files!(
    "terraform",
    [
        "providers.tf",
        "main.tf",
        "README.md",
        "gitignore",
        "modules/function/main.tf",
        "modules/function/variables.tf",
        "modules/function/outputs.tf",
        "modules/queue-worker/main.tf",
        "modules/queue-worker/variables.tf",
        "modules/queue-worker/outputs.tf",
        "modules/bucket-function/main.tf",
        "modules/bucket-function/variables.tf",
        "modules/bucket-function/outputs.tf",
        "modules/site/main.tf",
        "modules/site/variables.tf",
        "modules/site/outputs.tf",
        "site/index.html",
        "site/404.html",
        "nodejs/src/api.mjs",
        "nodejs/src/worker.mjs",
        "nodejs/src/uploads.mjs",
        "python/src/api.py",
        "python/src/worker.py",
        "python/src/uploads.py",
    ]
);

/// A SAM application, `sam init`'s hello world as FF takes it: its template, samconfig.toml naming its stack, a
/// function URL's request as its event, and a README; its code in each runtime's language, in the folder and with the
/// handler `sam init`'s has, and the handler's test.
const SAM: Files = template_files!(
    "sam",
    [
        "template.yaml",
        "samconfig.toml",
        "README.md",
        "gitignore",
        "events/event.json",
        "nodejs/hello-world/app.mjs",
        "nodejs/hello-world/package.json",
        "nodejs/tests/unit/test-handler.mjs",
        "python/hello_world/__init__.py",
        "python/hello_world/app.py",
        "python/hello_world/requirements.txt",
        "python/tests/__init__.py",
        "python/tests/unit/__init__.py",
        "python/tests/unit/test_handler.py",
    ]
);

/// An application of SAM's that `ff init` writes for both runtimes: `template.yaml`, its code in `src/`, its tests
/// outside it in `tests/`, its events in `events/`, `samconfig.toml` naming its stack, a `.gitignore`, and a README
/// for here, FF and AWS. Each function is named after the stack, `<name>-<part>`.
struct App {
    files: Files,
    /// What it is, as `ff init --list` says it.
    about: &'static str,
    /// What it is, in a sentence about it.
    what: &'static str,
    /// Its functions' parts of their names, after the stack's.
    parts: &'static [&'static str],
    /// What its README's lines do, said after `cd <name>`.
    then: &'static str,
}

impl App {
    /// The longest name it takes: its functions' names hold Lambda's 64 characters.
    fn name_most(&self) -> usize {
        64 - 1 - self.parts.iter().map(|part| part.len()).max().unwrap_or_default()
    }
}

/// A REST API at a function's URL: its routes by method and path, its items in PostgreSQL through `DATABASE_URL`,
/// CORS for one origin.
const REST_API: App = App {
    files: template_files!(
        "rest-api",
        [
            "template.yaml",
            "samconfig.toml",
            "README.md",
            "events/list-items.json",
            "events/create-item.json",
            "nodejs/gitignore",
            "nodejs/src/app.mjs",
            "nodejs/src/package.json",
            "nodejs/src/package-lock.json",
            "nodejs/tests/app.test.mjs",
            "python/gitignore",
            "python/src/app.py",
            "python/src/requirements.txt",
            "python/tests/__init__.py",
            "python/tests/test_app.py",
        ]
    ),
    about: "a REST API at a function's URL: its routes by method and path, its items in PostgreSQL, CORS for one origin",
    what: "a REST API",
    parts: &["api"],
    then: "its libraries installed, ff local start template.yaml --with postgres here; ff deploy template.yaml and ff \
           db create on FF; sam deploy on AWS",
};

/// A job on a schedule: each morning, the report of the day before, from the files that arrived in its bucket to a
/// report beside them; a run that fails tried twice more, then its event in a queue of failed runs.
const CRON_JOB: App = App {
    files: template_files!(
        "cron-job",
        [
            "template.yaml",
            "samconfig.toml",
            "README.md",
            "events/scheduled.json",
            "nodejs/gitignore",
            "nodejs/src/app.mjs",
            "nodejs/src/package.json",
            "nodejs/src/package-lock.json",
            "nodejs/tests/app.test.mjs",
            "python/gitignore",
            "python/src/app.py",
            "python/src/requirements.txt",
            "python/tests/__init__.py",
            "python/tests/test_app.py",
        ]
    ),
    about: "a job on a schedule: a report of the day before written to a bucket, its failed runs kept in a queue",
    what: "a cron job",
    parts: &["report"],
    then: "its libraries installed, ff local start template.yaml and ff local run EveryMorning here; ff deploy \
           template.yaml on FF; sam deploy on AWS",
};

/// A queue and its worker: a URL that takes jobs into the queue, a worker reading it in batches that names the jobs
/// it failed, and a dead-letter queue for those that failed three times.
const QUEUE_WORKER: App = App {
    files: template_files!(
        "queue-worker",
        [
            "template.yaml",
            "samconfig.toml",
            "README.md",
            "events/post-job.json",
            "events/batch.json",
            "nodejs/gitignore",
            "nodejs/src/api.mjs",
            "nodejs/src/worker.mjs",
            "nodejs/src/package.json",
            "nodejs/src/package-lock.json",
            "nodejs/tests/api.test.mjs",
            "nodejs/tests/worker.test.mjs",
            "python/gitignore",
            "python/src/api.py",
            "python/src/worker.py",
            "python/src/requirements.txt",
            "python/tests/__init__.py",
            "python/tests/test_api.py",
            "python/tests/test_worker.py",
        ]
    ),
    about: "a queue and its worker: a URL that takes jobs, a worker reading them in batches, a dead-letter queue",
    what: "a queue worker",
    parts: &["api", "worker"],
    then: "its libraries installed, ff local start template.yaml here; ff deploy template.yaml on FF; sam deploy on AWS",
};

/// The application a template is, if it is one.
fn app(template: Template) -> Option<&'static App> {
    match template {
        Template::RestApi => Some(&REST_API),
        Template::CronJob => Some(&CRON_JOB),
        Template::QueueWorker => Some(&QUEUE_WORKER),
        Template::Function | Template::Terraform | Template::Sam => None,
    }
}

/// What a template makes, as `ff init --list` says it.
fn about(template: Template) -> &'static str {
    match template {
        Template::Function => "a function's folder: its handler, an event to call it with, and a README (the default)",
        Template::Terraform => {
            "an app's Terraform project: FF's provider block and four modules, which apply on FF and on AWS"
        }
        Template::Sam => "sam init's hello world as FF takes it: one function at its URL, as a SAM application",
        Template::RestApi | Template::CronJob | Template::QueueWorker => {
            app(template).map(|app| app.about).unwrap_or_default()
        }
    }
}

/// A template's files for a runtime, each by the path it is written at, with its text.
fn files_for(files: Files, runtime: Runtime) -> impl Iterator<Item = (&'static str, &'static str)> {
    files.iter().filter_map(move |&(path, text)| {
        let (own, other) = match runtime {
            Runtime::Nodejs => ("nodejs/", "python/"),
            Runtime::Python => ("python/", "nodejs/"),
        };
        let written = match path.strip_prefix(own) {
            Some(rest) => rest,
            None if path.starts_with(other) => return None,
            None => path,
        };
        Some((if written == "gitignore" { ".gitignore" } else { written }, text))
    })
}

/// A SAM application's function in a runtime's language, as `sam init`'s hello world has it.
struct SamCode {
    /// The folder of its code, its CodeUri.
    code_uri: &'static str,
    handler: &'static str,
    /// What runs the handler's test.
    test: &'static str,
}

const fn sam_code(runtime: Runtime) -> SamCode {
    match runtime {
        Runtime::Nodejs => SamCode { code_uri: "hello-world/", handler: "app.lambdaHandler", test: "node --test" },
        Runtime::Python => {
            SamCode { code_uri: "hello_world/", handler: "app.lambda_handler", test: "python3 -m unittest" }
        }
    }
}

/// The files of a new SAM application, by their path in it: its name, its stack's, in them, and its function in the
/// runtime's language.
pub fn sam_files(name: &str, runtime: Runtime) -> Vec<(&'static str, String)> {
    let code = sam_code(runtime);
    let fill = |template: &str| {
        template
            .replace("{{name}}", name)
            .replace("{{runtime}}", runtime.lambda())
            .replace("{{code_uri}}", code.code_uri)
            .replace("{{handler}}", code.handler)
            // The README's command, its comment in the column of the others'.
            .replace("{{test}}", &format!("{:<41}", code.test))
    };
    files_for(SAM, runtime).map(|(path, template)| (path, fill(template))).collect()
}

/// The files of a new application, by their path in it: its name, its stack's, in them, and its code in the
/// runtime's language, with the commands that install its libraries and run its tests.
fn app_files(app: &App, name: &str, runtime: Runtime) -> Vec<(&'static str, String)> {
    let (language, extension, install, test) = match runtime {
        Runtime::Nodejs => (
            "JavaScript, for Node.js",
            "mjs",
            "(cd src && npm ci)                               # its libraries, for ff local start: ff deploy and sam \
             build install their own",
            "node --test",
        ),
        Runtime::Python => (
            "Python",
            "py",
            "# its libraries, Linux's builds, beside the code for ff local start: ff deploy and sam build install their \
             own\npython3 -m pip install -r src/requirements.txt -t src/ --only-binary=:all: \\\n  \
             --implementation cp --python-version 3.13 --platform manylinux_2_28_x86_64 --platform manylinux2014_x86_64",
            "python3 -m unittest",
        ),
    };
    let fill = |template: &str| {
        template
            .replace("{{name}}", name)
            .replace("{{name_lower}}", &name.to_lowercase())
            .replace("{{runtime}}", runtime.lambda())
            .replace("{{language}}", language)
            .replace("{{extension}}", extension)
            .replace("{{install}}", install)
            // The README's command, its comment in the column of the others'.
            .replace("{{test}}", &format!("{test:<49}"))
    };
    files_for(app.files, runtime).map(|(path, template)| (path, fill(template))).collect()
}

/// Writes an application's folder, which must not exist yet, or be empty.
fn create_app(folder: &Path, name: &str, runtime: Runtime, app: &App) -> Result<Vec<PathBuf>, Error> {
    let most = app.name_most();
    if !super::template::is_stack_name(name) || name.len() > most {
        let functions: Vec<String> = app.parts.iter().map(|part| format!("{name}-{part}")).collect();
        return Err(Error::usage(format!(
            "\"{name}\" can't name {}, which names its stack and its functions, {}: letters, digits and hyphens, a \
             letter first, {most} at most, as Lambda's function names are 64 at most",
            app.what,
            functions.join(" and ")
        )));
    }
    new_folder(folder, "ff init makes a new folder")?;
    write_folder(folder, app_files(app, name, runtime))
}

/// Writes a SAM application's folder, which must not exist yet, or be empty.
fn create_sam(folder: &Path, name: &str, runtime: Runtime) -> Result<Vec<PathBuf>, Error> {
    if !super::template::is_stack_name(name) {
        return Err(Error::usage(format!(
            "\"{name}\" can't name a SAM application, which names its stack: letters, digits and hyphens, a letter \
             first, 128 at most, as CloudFormation's"
        )));
    }
    new_folder(folder, "ff init makes a new folder")?;
    write_folder(folder, sam_files(name, runtime))
}

/// The files of a new function's folder, by their path in it, with the function's name in them.
pub fn files(name: &str, runtime: Runtime) -> Vec<(&'static str, String)> {
    let (language, extension) = match runtime {
        Runtime::Nodejs => ("TypeScript, for Node.js", "ts"),
        Runtime::Python => ("Python", "py"),
    };
    let fill = |template: &str| {
        template.replace("{{name}}", name).replace("{{language}}", language).replace("{{extension}}", extension)
    };
    files_for(FUNCTION, runtime).map(|(path, template)| (path, fill(template))).collect()
}

/// The longest name of a Terraform project: its buckets and queues are named after it, and the longest of them,
/// `<name>-jobs-dead-letters`, stays within Lambda's 64 characters for a function's name besides.
const PROJECT_NAME_MOST: usize = 46;

/// Why a name can't name a Terraform project for FF, if it can't: its buckets are named after it, so S3's rules
/// for a bucket's name hold, lowercase letters, digits and hyphens, a letter or a digit at each end.
fn project_name_problem(name: &str) -> Option<String> {
    let allowed = name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let ends = !name.starts_with('-') && !name.ends_with('-');
    (name.is_empty() || name.len() > PROJECT_NAME_MOST || !allowed || !ends).then(|| {
        format!(
            "\"{name}\" can't name a Terraform project for FF: its buckets and queues are named after it, so 1 to \
             {PROJECT_NAME_MOST} lowercase letters, digits and hyphens, a letter or a digit at each end"
        )
    })
}

/// The provider block's `endpoints`, as `tofu fmt` aligns them: Lambda's, S3's and SQS's, which the modules use, and
/// SES's when FF has one. An FF without one of the three can't apply the modules: said, with what it lacks.
fn endpoints_block(aws: &AwsEndpoints) -> Result<String, Error> {
    let needed =
        [("lambda", &aws.lambda_endpoint, "Lambda"), ("s3", &aws.s3_endpoint, "S3"), ("sqs", &aws.sqs_endpoint, "SQS")];
    if let Some((_, _, whose)) = needed.iter().find(|(_, endpoint, _)| endpoint.is_empty()) {
        return Err(Error::new(
            Kind::Failed,
            format!("This FF gives no {whose} endpoint (GET /me), which the Terraform project's modules need"),
        ));
    }
    let mut lines: Vec<(&str, &str)> =
        needed.iter().map(|(service, endpoint, _)| (*service, endpoint.as_str())).collect();
    if !aws.ses_endpoint.is_empty() {
        lines.push(("sesv2", &aws.ses_endpoint));
    }
    Ok(lines
        .iter()
        .map(|(service, endpoint)| format!("    {service:<6} = \"{endpoint}\""))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// The key a Terraform project's provider takes: one that names the project's functions, at write access, its buckets
/// and its queues, as `main.tf` names them, since a key reaches what it names alone; made before they are, as an IAM
/// policy names resources to come.
pub fn terraform_key_command(name: &str) -> String {
    let functions = ["api", "jobs", "uploads"].map(|part| format!(" --function {name}-{part}")).concat();
    let buckets = ["uploads", "site"].map(|part| format!(" --bucket {name}-{part}")).concat();
    let queues = ["jobs", "jobs-dead-letters"].map(|part| format!(" --queue {name}-{part}")).concat();
    format!("ff keys create --name {name}-terraform{functions} --function-access write{buckets}{queues}")
}

/// The files of a new Terraform project, by their path in it: FF's region, endpoints and account in its provider
/// block, the project's name in its resources' names, its functions in the runtime's language, the key to make in its
/// README.
pub fn terraform_files(
    name: &str,
    runtime: Runtime,
    account: &str,
    aws: &AwsEndpoints,
) -> Result<Vec<(&'static str, String)>, Error> {
    let endpoints = endpoints_block(aws)?;
    let key = terraform_key_command(name);
    let language = match runtime {
        Runtime::Nodejs => "JavaScript, for Node.js",
        Runtime::Python => "Python",
    };
    let fill = |template: &str| {
        template
            .replace("{{name}}", name)
            .replace("{{region}}", &aws.region)
            .replace("{{endpoints}}", &endpoints)
            .replace("{{account}}", account)
            .replace("{{runtime}}", runtime.lambda())
            .replace("{{language}}", language)
            .replace("{{key}}", &key)
    };
    Ok(files_for(TERRAFORM, runtime).map(|(path, template)| (path, fill(template))).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    name: String,
    template: &'static str,
    runtime: &'static str,
    folder: PathBuf,
    files: Vec<String>,
    /// For a Terraform project, the command that makes the key its provider takes.
    #[serde(skip_serializing_if = "Option::is_none")]
    key_command: Option<String>,
}

/// Refuses a folder that holds files already, for a command that writes a new one, `why` saying so.
pub(super) fn new_folder(folder: &Path, why: &str) -> Result<(), Error> {
    let occupied = std::fs::read_dir(folder).map(|mut entries| entries.next().is_some()).unwrap_or(false);
    if occupied {
        return Err(Error::usage(format!("{} already holds files: {why}", folder.display())));
    }
    Ok(())
}

/// Writes the files into the folder, each by its path in it.
fn write_folder(folder: &Path, files: Vec<(&'static str, String)>) -> Result<Vec<PathBuf>, Error> {
    let failed = |path: &Path, error: std::io::Error| {
        Error::new(Kind::Failed, format!("Couldn't write {}: {error}", path.display()))
    };
    let mut written = Vec::new();
    for (relative, text) in files {
        let path = folder.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| failed(parent, error))?;
        }
        std::fs::write(&path, text).map_err(|error| failed(&path, error))?;
        written.push(path);
    }
    Ok(written)
}

/// Writes a function's folder, which must not exist yet, or be empty.
pub fn create(folder: &Path, name: &str, runtime: Runtime) -> Result<Vec<PathBuf>, Error> {
    if !is_function_name(name) {
        return Err(Error::usage(format!(
            "\"{name}\" can't be a function's name: 1 to 64 letters, digits, hyphens or underscores, as on AWS Lambda"
        )));
    }
    new_folder(folder, "ff init makes a new folder")?;
    write_folder(folder, files(name, runtime))
}

/// Writes a Terraform project's folder, which must not exist yet, or be empty, with the endpoints of the FF that
/// `GET /me` answers from, and the account the commands act for.
fn create_terraform(folder: &Path, name: &str, runtime: Runtime, context: &Context) -> Result<Vec<PathBuf>, Error> {
    if let Some(problem) = project_name_problem(name) {
        return Err(Error::usage(problem));
    }
    new_folder(folder, "ff init makes a new folder")?;
    let settings = context.settings()?;
    let me = account::me(&Client::new(&settings)?)?;
    let chosen = account::current(&me, &settings)?;
    let aws = chosen.aws.as_ref().ok_or_else(|| {
        Error::new(
            Kind::Failed,
            "This FF's API gives no endpoints with its accounts (GET /me): it is older than this ff",
        )
    })?;
    write_folder(folder, terraform_files(name, runtime, &chosen.id, aws)?)
}

#[derive(Serialize)]
struct Listed {
    name: &'static str,
    about: &'static str,
    runtimes: [&'static str; 2],
}

/// `ff init --list`: each template, with what it makes; each for both runtimes.
pub fn list(context: &Context) -> Result<(), Error> {
    use clap::ValueEnum;
    let templates: Vec<Listed> = Template::value_variants()
        .iter()
        .map(|&template| Listed {
            name: template.as_str(),
            about: about(template),
            runtimes: [Runtime::Nodejs.as_str(), Runtime::Python.as_str()],
        })
        .collect();
    let widest = templates.iter().map(|template| template.name.len()).max().unwrap_or_default();
    context.out.result(&serde_json::json!({ "templates": &templates }), || {
        let lines: Vec<String> =
            templates.iter().map(|template| format!("  {:<widest$}  {}", template.name, template.about)).collect();
        format!(
            "ff init <name> --runtime nodejs|python --template <template>, each for both runtimes:\n{}",
            lines.join("\n")
        )
    })
}

pub fn run(name: &str, runtime: Runtime, template: Template, context: &Context) -> Result<(), Error> {
    let folder = PathBuf::from(name);
    let written = match template {
        Template::Function => create(&folder, name, runtime)?,
        Template::Terraform => create_terraform(&folder, name, runtime, context)?,
        Template::Sam => create_sam(&folder, name, runtime)?,
        Template::RestApi => create_app(&folder, name, runtime, &REST_API)?,
        Template::CronJob => create_app(&folder, name, runtime, &CRON_JOB)?,
        Template::QueueWorker => create_app(&folder, name, runtime, &QUEUE_WORKER)?,
    };
    let created = Created {
        name: name.to_owned(),
        template: template.as_str(),
        runtime: runtime.as_str(),
        folder: folder.clone(),
        files: written.iter().map(|path| path.display().to_string()).collect(),
        key_command: (template == Template::Terraform).then(|| terraform_key_command(name)),
    };
    context.out.result(&created, || match template {
        Template::RestApi | Template::CronJob | Template::QueueWorker => {
            let app = app(template).expect("an application's template");
            format!(
                "created {}/, {}: template.yaml, its code in src/ with its tests in tests/, its events in events/, \
                 samconfig.toml naming the stack {name}\nthen: cd {name}, and README.md's lines: {}",
                folder.display(),
                app.what,
                app.then
            )
        }
        Template::Function => format!(
            "created {}\nthen: cd {name} && ff local invoke . --data @events/event.json, and ff deploy function.{} to put it on FF",
            created.files.join(", "),
            if runtime == Runtime::Nodejs { "ts" } else { "py" }
        ),
        Template::Terraform => format!(
            "created {}/, a Terraform project: FF's provider block in providers.tf, four modules in modules/, the app in main.tf\n\
             then: cd {name}, a key of `{}` in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and tofu init && tofu apply \
             (or terraform's)",
            folder.display(),
            created.key_command.as_deref().unwrap_or_default()
        ),
        Template::Sam => format!(
            "created {}/, sam init's hello world as FF takes it: template.yaml, its function in {}, a URL in place of \
             its API, samconfig.toml naming the stack {name}\n\
             then: cd {name} && ff deploy template.yaml, again after a change; sam deploy takes the same folder to AWS",
            folder.display(),
            sam_code(runtime).code_uri
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The files under a folder, by their path in it, with `/` between its parts.
    fn files_under(folder: &Path, prefix: &str, found: &mut Vec<String>) {
        for entry in std::fs::read_dir(folder).unwrap() {
            let entry = entry.unwrap();
            let path = format!("{prefix}{}", entry.file_name().to_string_lossy());
            if entry.file_type().unwrap().is_dir() {
                files_under(&entry.path(), &format!("{path}/"), found);
            } else {
                found.push(path);
            }
        }
    }

    #[test]
    fn each_template_s_folder_is_written_whole_as_its_list_names_every_file_once() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("templates");
        let templates = [
            ("cron-job", CRON_JOB.files),
            ("function", FUNCTION),
            ("queue-worker", QUEUE_WORKER.files),
            ("rest-api", REST_API.files),
            ("sam", SAM),
            ("terraform", TERRAFORM),
        ];
        let mut folders: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "export")
            .collect();
        folders.sort();
        assert_eq!(folders, templates.map(|(folder, _)| folder), "a template's folder that ff init doesn't know");
        for (folder, files) in templates {
            let mut found = Vec::new();
            files_under(&root.join(folder), "", &mut found);
            found.sort();
            let mut listed: Vec<String> = files.iter().map(|(path, _)| path.to_string()).collect();
            listed.sort();
            assert_eq!(listed, found, "{folder}");
        }
        let written: Vec<&str> = files_for(SAM, Runtime::Python).map(|(path, _)| path).collect();
        assert_eq!(written[..5], ["template.yaml", "samconfig.toml", "README.md", ".gitignore", "events/event.json"]);
        assert!(written.contains(&"hello_world/app.py") && !written.iter().any(|path| path.ends_with(".mjs")));
    }

    #[test]
    fn a_python_function_has_its_handler_an_event_and_a_readme_with_its_name() {
        let files = files("orders", Runtime::Python);
        let paths: Vec<&str> = files.iter().map(|(path, _)| *path).collect();

        assert_eq!(paths, ["function.py", "events/event.json", "README.md"]);
        assert_eq!(
            files[0].1,
            "# orders: a function in Python, with AWS Lambda's handler: FF calls handler(event, context),\n\
             # and event is what the caller sent, as a payload is on Lambda. The code moves to Lambda as it is.\n\
             def handler(event, context):\n    name = event.get(\"name\", \"world\")\n    \
             print(f\"greeting {name}\")  # a line of the function's log: ff logs orders\n    \
             return {\"message\": f\"Hello {name}\", \"requestId\": context.aws_request_id}\n"
        );
        assert_eq!(files[1].1, "{\n  \"name\": \"Tunis\"\n}\n");
        assert!(
            files[2].1.starts_with("# orders\n\nA function for FF, in Python: `function.py` holds its handler"),
            "{}",
            files[2].1
        );
        assert!(files[2].1.contains("ff invoke orders --data @events/event.json"));
        assert!(!files.iter().any(|(_, text)| text.contains("{{")), "every placeholder is filled");
    }

    #[test]
    fn a_nodejs_function_is_typescript() {
        let files = files("orders", Runtime::Nodejs);

        assert_eq!(files[0].0, "function.ts");
        assert!(
            files[0]
                .1
                .contains("export async function handler(event: { name?: string }, context: { awsRequestId: string })")
        );
        assert!(files[2].1.contains("in TypeScript, for Node.js: `function.ts`"));
    }

    #[test]
    fn a_terraform_project_s_key_names_its_functions_buckets_and_queues_as_main_tf_does_and_its_readme_gives_it() {
        assert_eq!(
            terraform_key_command("shop"),
            "ff keys create --name shop-terraform --function shop-api --function shop-jobs --function shop-uploads \
             --function-access write --bucket shop-uploads --bucket shop-site --queue shop-jobs --queue shop-jobs-dead-letters"
        );
        let files = terraform_files("shop", Runtime::Nodejs, "123456789012", &AwsEndpoints::ffunc()).unwrap();
        let file = |path: &str| &files.iter().find(|(name, _)| *name == path).unwrap().1;
        assert!(file("README.md").contains(&format!("```sh\n{}\n", terraform_key_command("shop"))));
        for name in ["${local.app}-api", "${local.app}-jobs", "${local.app}-uploads", "${local.app}-site"] {
            assert!(file("main.tf").contains(&format!("= \"{name}\"")), "{name}");
        }
        assert!(
            file("modules/queue-worker/main.tf").contains("name                      = \"${var.name}-dead-letters\"")
        );
    }

    #[test]
    fn a_terraform_project_s_provider_block_names_ffs_region_endpoints_and_the_account_in_its_functions_role() {
        let files = terraform_files("shop", Runtime::Nodejs, "123456789012", &AwsEndpoints::ffunc()).unwrap();
        let file = |path: &str| &files.iter().find(|(name, _)| *name == path).unwrap().1;

        let providers = file("providers.tf");
        assert!(providers.contains("  region = \"tn-tunis-1\"\n"), "{providers}");
        assert!(
            providers.contains(
                "  endpoints {\n    lambda = \"https://lambda.ffunc.cloud\"\n    s3     = \"https://s3.ffunc.cloud\"\n    \
                 sqs    = \"https://sqs.ffunc.cloud\"\n    sesv2  = \"https://email.ffunc.cloud\"\n  }\n"
            ),
            "{providers}"
        );
        for skip in [
            "skip_credentials_validation",
            "skip_requesting_account_id",
            "skip_metadata_api_check",
            "skip_region_validation",
        ] {
            assert!(providers.contains(&format!("  {skip:<27} = true\n")), "{skip}: {providers}");
        }
        assert!(providers.contains("  function_role = \"arn:aws:iam::123456789012:role/shop\"\n"));
        assert!(file("main.tf").contains("  app     = \"shop\"\n  runtime = \"nodejs24.x\"\n"));
        assert!(file("src/api.mjs").starts_with("// shop's API"));
        assert!(file("README.md").contains("The code, in JavaScript, for Node.js, is in `src/`"));
        assert!(!files.iter().any(|(_, text)| text.contains("{{")), "every placeholder is filled");
    }

    #[test]
    fn a_terraform_project_holds_four_modules_and_its_functions_code_in_the_runtime_s_language() {
        let files = terraform_files("shop", Runtime::Python, "123456789012", &AwsEndpoints::ffunc()).unwrap();
        let paths: Vec<&str> = files.iter().map(|(path, _)| *path).collect();

        for module in ["function", "queue-worker", "bucket-function", "site"] {
            for file in ["main.tf", "variables.tf", "outputs.tf"] {
                assert!(paths.contains(&format!("modules/{module}/{file}").as_str()), "{module}/{file}: {paths:?}");
            }
        }
        assert_eq!(paths[paths.len() - 3..], ["src/api.py", "src/worker.py", "src/uploads.py"]);
        assert!(paths.contains(&".gitignore") && paths.contains(&"site/index.html"));
        let main = &files.iter().find(|(path, _)| *path == "main.tf").unwrap().1;
        assert!(main.contains("runtime = \"python3.13\""));
    }

    #[test]
    fn without_ses_its_line_is_left_out_and_without_lambda_s3_or_sqs_it_says_which_it_lacks() {
        let without_ses = AwsEndpoints { ses_endpoint: String::new(), ..AwsEndpoints::ffunc() };
        let files = terraform_files("shop", Runtime::Nodejs, "123456789012", &without_ses).unwrap();
        assert!(!files[0].1.contains("sesv2"));

        let without_lambda = AwsEndpoints { lambda_endpoint: String::new(), ..AwsEndpoints::ffunc() };
        let refused = terraform_files("shop", Runtime::Nodejs, "123456789012", &without_lambda).unwrap_err();
        assert_eq!(
            refused.message,
            "This FF gives no Lambda endpoint (GET /me), which the Terraform project's modules need"
        );
    }

    #[test]
    fn a_project_s_name_holds_to_a_bucket_s_rules_as_its_buckets_are_named_after_it() {
        assert_eq!(project_name_problem("shop-2"), None);
        assert_eq!(project_name_problem(&"a".repeat(PROJECT_NAME_MOST)), None);
        for name in ["", "Shop", "-shop", "shop-", "shop_api", "shop.api", &"a".repeat(PROJECT_NAME_MOST + 1)] {
            assert!(project_name_problem(name).is_some(), "{name}");
        }
    }

    #[test]
    fn it_makes_a_new_folder_and_refuses_one_with_files_or_a_name_lambda_refuses() {
        let dir = tempfile::TempDir::new().unwrap();
        let folder = dir.path().join("orders");

        let written = create(&folder, "orders", Runtime::Python).unwrap();
        assert_eq!(written.len(), 3);
        assert!(folder.join("events/event.json").is_file());
        assert_eq!(create(&folder, "orders", Runtime::Python).unwrap_err().exit_code(), 2);
        assert_eq!(create(&dir.path().join("my orders"), "my orders", Runtime::Python).unwrap_err().exit_code(), 2);
    }

    #[test]
    fn a_sam_application_is_sam_inits_hello_world_with_a_url_for_its_api_in_ffs_subset_which_ff_deploy_plans() {
        use crate::sam::{parameters, plan, subset};
        let cases = [
            (Runtime::Nodejs, include_str!("../sam/testdata/hello-node.yaml"), ["app.mjs", "package.json"].as_slice()),
            (
                Runtime::Python,
                include_str!("../sam/testdata/hello-python.yaml"),
                &["__init__.py", "app.py", "requirements.txt"],
            ),
        ];
        for (runtime, sam_init, code) in cases {
            let dir = tempfile::TempDir::new().unwrap();
            let folder = dir.path().join("shop");
            let written = create_sam(&folder, "shop", runtime).unwrap();

            let mut paths: Vec<String> =
                written.iter().map(|path| path.strip_prefix(&folder).unwrap().display().to_string()).collect();
            paths.sort();
            let code_uri = sam_code(runtime).code_uri;
            let mut expected: Vec<String> =
                ["template.yaml", "samconfig.toml", "README.md", ".gitignore", "events/event.json"]
                    .map(String::from)
                    .into();
            expected.extend(code.iter().map(|file| format!("{code_uri}{file}")));
            expected.extend(match runtime {
                Runtime::Nodejs => vec!["tests/unit/test-handler.mjs".to_owned()],
                Runtime::Python => ["tests/__init__.py", "tests/unit/__init__.py", "tests/unit/test_handler.py"]
                    .map(String::from)
                    .into(),
            });
            expected.sort();
            assert_eq!(paths, expected);
            assert!(
                !sam_files("shop", runtime).iter().any(|(_, text)| text.contains("{{")),
                "every placeholder is filled"
            );
            let read = |file: &str| std::fs::read_to_string(folder.join(file)).unwrap();

            // sam init's own template, its Api event a URL, the output that named the API that URL, its role's output
            // left out, and FF's runtime: nothing else changed.
            let template = crate::sam::read(&read("template.yaml")).unwrap();
            let mut variant = crate::sam::read(sam_init).unwrap().value;
            let function = variant["Resources"]["HelloWorldFunction"]["Properties"].as_object_mut().unwrap();
            function.remove("Events");
            function.insert("Runtime".into(), runtime.lambda().into());
            function.insert("FunctionUrlConfig".into(), serde_json::json!({ "AuthType": "NONE" }));
            let outputs = variant["Outputs"].as_object_mut().unwrap();
            outputs.remove("HelloWorldFunctionIamRole");
            let url =
                crate::sam::read("Value: !GetAtt HelloWorldFunctionUrl.FunctionUrl").unwrap().value["Value"].clone();
            outputs.insert(
                "HelloWorldApi".into(),
                serde_json::json!({ "Description": "Function URL for Hello World function", "Value": url }),
            );
            variant["Description"] = template.value["Description"].clone();
            assert_eq!(template.value, variant);

            let config = parameters::samconfig(&read("samconfig.toml")).unwrap();
            assert_eq!(config.stack_name.as_deref(), Some("shop"));
            let values = parameters::values(&template, &config.parameter_overrides);
            assert_eq!(subset::check(&template, &values.values), []);
            let place = plan::Place {
                stack: "shop",
                region: "tn-tunis-1",
                account: "000000000001",
                sqs_endpoint: "https://sqs.ffunc.cloud",
                sqs_function_endpoint: "http://10.43.0.251:3003",
                s3_endpoint: "https://s3.ffunc.cloud",
            };
            let planned = plan::plan(&template, &values.values, &place, &[], &folder, &mut || "ABCDEFGHIJKL".into());
            let [function] = &planned.unwrap().functions[..] else { panic!("one function") };
            assert_eq!(
                (function.name.as_str(), function.runtime, function.timeout, function.alias.as_deref()),
                ("shop-HelloWorldFunction-ABCDEFGHIJKL", runtime, 3, None)
            );
            assert_eq!(function.url.as_ref().map(|url| url.auth_type.as_str()), Some("NONE"));
            assert_eq!(function.code, folder.join(code_uri));
            let files: Vec<String> = code.iter().map(|file| file.to_string()).collect();
            assert_eq!(crate::package::handler_problem(&files, &function.handler, runtime), None);
        }
        assert_eq!(create_sam(&PathBuf::from("2shop"), "2shop", Runtime::Nodejs).unwrap_err().exit_code(), 2);
    }

    /// An application as `ff init` writes it, in a folder of its own, every placeholder filled, and its template as
    /// `ff deploy` plans it there, in FF's subset: its stack the one samconfig.toml names, its parameters
    /// samconfig.toml's and those given, each function's handler a module of `src/`. The folder, the files' paths in
    /// order, and the plan.
    fn written_and_planned(
        app: &App,
        name: &str,
        runtime: Runtime,
        given: &[(&str, &str)],
    ) -> (tempfile::TempDir, Vec<String>, crate::sam::plan::Plan) {
        use crate::sam::{parameters, plan, subset};
        let dir = tempfile::TempDir::new().unwrap();
        let folder = dir.path().join(name);
        let written = create_app(&folder, name, runtime, app).unwrap();
        let mut paths: Vec<String> =
            written.iter().map(|path| path.strip_prefix(&folder).unwrap().display().to_string()).collect();
        paths.sort();
        let files = app_files(app, name, runtime);
        assert!(!files.iter().any(|(_, text)| text.contains("{{")), "every placeholder is filled");

        let read = |file: &str| std::fs::read_to_string(folder.join(file)).unwrap();
        let template = crate::sam::read(&read("template.yaml")).unwrap();
        let config = parameters::samconfig(&read("samconfig.toml")).unwrap();
        assert_eq!(config.stack_name.as_deref(), Some(name));
        let mut overrides = config.parameter_overrides;
        overrides.extend(given.iter().map(|(key, value)| (key.to_string(), value.to_string())));
        let values = parameters::values(&template, &overrides);
        assert_eq!((values.refused.clone(), values.missing.clone()), (vec![], vec![]));
        assert_eq!(subset::check(&template, &values.values), []);
        let place = plan::Place {
            stack: name,
            region: "tn-tunis-1",
            account: "000000000001",
            sqs_endpoint: "https://sqs.ffunc.cloud",
            sqs_function_endpoint: "http://10.43.0.251:3003",
            s3_endpoint: "https://s3.ffunc.cloud",
        };
        let planned =
            plan::plan(&template, &values.values, &place, &[], &folder, &mut || "ABCDEFGHIJKL".into()).unwrap();
        let code: Vec<String> = paths.iter().filter_map(|path| path.strip_prefix("src/")).map(String::from).collect();
        for function in &planned.functions {
            assert_eq!(function.code, folder.join("src/"));
            assert_eq!(
                crate::package::handler_problem(&code, &function.handler, runtime),
                None,
                "{}",
                function.handler
            );
        }
        (dir, paths, planned)
    }

    #[test]
    fn a_rest_api_is_one_function_at_its_url_with_cors_for_one_origin_in_ffs_subset_which_ff_deploy_plans() {
        for (runtime, code) in [
            (Runtime::Nodejs, ["app.mjs", "package.json", "package-lock.json"].as_slice()),
            (Runtime::Python, &["app.py", "requirements.txt"]),
        ] {
            let (dir, paths, planned) = written_and_planned(&REST_API, "Shop-2", runtime, &[]);
            let mut expected: Vec<String> = [
                "template.yaml",
                "samconfig.toml",
                "README.md",
                ".gitignore",
                "events/list-items.json",
                "events/create-item.json",
            ]
            .map(String::from)
            .into();
            expected.extend(code.iter().map(|file| format!("src/{file}")));
            expected.extend(match runtime {
                Runtime::Nodejs => vec!["tests/app.test.mjs".to_owned()],
                Runtime::Python => ["tests/__init__.py", "tests/test_app.py"].map(String::from).into(),
            });
            expected.sort();
            assert_eq!(paths, expected);
            let readme = std::fs::read_to_string(dir.path().join("Shop-2/README.md")).unwrap();
            assert!(readme.contains("ff db create shop-2 --secret-for Shop-2-api"));
            assert!(readme.contains("http://shop-2-api.fn.localhost:3700/items"));

            let [function] = &planned.functions[..] else { panic!("one function") };
            assert_eq!((function.name.as_str(), function.runtime, function.timeout), ("Shop-2-api", runtime, 10));
            let url = function.url.as_ref().unwrap();
            assert_eq!(url.auth_type, "NONE");
            assert_eq!(url.cors.as_ref().unwrap()["allowOrigins"], serde_json::json!(["http://localhost:5173"]));
        }
        assert_eq!(REST_API.name_most(), 60);
        for name in ["2shop", "shop_api", &"a".repeat(REST_API.name_most() + 1)] {
            assert_eq!(create_app(&PathBuf::from(name), name, Runtime::Nodejs, &REST_API).unwrap_err().exit_code(), 2);
        }
    }

    #[test]
    fn a_cron_job_is_a_function_on_a_schedule_with_its_bucket_and_a_queue_for_its_failed_runs_which_ff_deploy_plans() {
        for (runtime, extension) in [(Runtime::Nodejs, "mjs"), (Runtime::Python, "py")] {
            let (_dir, paths, planned) = written_and_planned(&CRON_JOB, "Reports", runtime, &[]);
            for path in [format!("src/app.{extension}"), "events/scheduled.json".into(), ".gitignore".into()] {
                assert!(paths.contains(&path), "{path}: {paths:?}");
            }

            let [function] = &planned.functions[..] else { panic!("one function") };
            assert_eq!(
                (function.name.as_str(), function.handler.as_str(), function.memory, function.timeout),
                ("Reports-report", "app.handler", 256, 60)
            );
            let [schedule] = &function.schedules[..] else { panic!("one schedule") };
            assert_eq!(
                (schedule.name.as_str(), schedule.expression.as_str(), schedule.input.as_ref(), schedule.enabled),
                ("EveryMorning", "cron(0 6 * * ? *)", None, true)
            );
            // The bucket named CloudFormation's way, as a bucket's name is unique across FF; the function told it.
            let [bucket] = &planned.buckets[..] else { panic!("one bucket") };
            assert_eq!(bucket.name, "reports-files-abcdefghijkl");
            assert_eq!(function.environment.get("BUCKET"), Some(&bucket.name));
            let [queue] = &planned.queues[..] else { panic!("one queue") };
            assert_eq!(
                (queue.name.as_str(), &queue.attributes["messageRetentionPeriod"]),
                ("Reports-failed-runs", &serde_json::json!(1_209_600))
            );
            assert_eq!(
                function.event_invoke_config,
                Some(serde_json::json!({
                    "maximumRetryAttempts": 2,
                    "destinationConfig": { "onFailure": { "destination": "arn:aws:sqs:tn-tunis-1:000000000001:Reports-failed-runs" } }
                }))
            );
        }
        assert_eq!(CRON_JOB.name_most(), 57);
    }

    #[test]
    fn a_queue_worker_is_a_url_that_sends_jobs_a_worker_reading_them_in_batches_and_a_dead_letter_queue_planned() {
        for (runtime, extension) in [(Runtime::Nodejs, "mjs"), (Runtime::Python, "py")] {
            let (_dir, paths, planned) = written_and_planned(&QUEUE_WORKER, "Jobs-2", runtime, &[]);
            for path in [format!("src/api.{extension}"), format!("src/worker.{extension}"), "events/batch.json".into()]
            {
                assert!(paths.contains(&path), "{path}: {paths:?}");
            }

            let [api, worker] = &planned.functions[..] else { panic!("two functions") };
            assert_eq!((api.name.as_str(), api.handler.as_str()), ("Jobs-2-api", "api.handler"));
            assert_eq!(api.url.as_ref().map(|url| url.auth_type.as_str()), Some("NONE"));
            assert_eq!(
                api.environment.get("JOBS_QUEUE_URL").map(String::as_str),
                Some("http://10.43.0.251:3003/000000000001/Jobs-2-jobs")
            );
            assert_eq!(
                (worker.name.as_str(), worker.handler.as_str(), worker.timeout),
                ("Jobs-2-worker", "worker.handler", 10)
            );
            let [mapping] = &worker.mappings[..] else { panic!("one SQS event") };
            assert_eq!(
                (mapping.queue(), mapping.batch_size, mapping.report_batch_item_failures, mapping.enabled),
                ("Jobs-2-jobs", 10, true, true)
            );
            // The dead-letter queue made first; the jobs' hidden for the parameter's seconds, 60 unless given.
            let [dead_letters, jobs] = &planned.queues[..] else { panic!("two queues") };
            assert_eq!((dead_letters.name.as_str(), jobs.name.as_str()), ("Jobs-2-jobs-dead-letters", "Jobs-2-jobs"));
            assert_eq!(jobs.dead_letter(), Some("Jobs-2-jobs-dead-letters"));
            assert_eq!(jobs.attributes["redrivePolicy"]["maxReceiveCount"], 3);
            assert_eq!(jobs.attributes["visibilityTimeout"], 60);
        }
        let (_dir, _, planned) =
            written_and_planned(&QUEUE_WORKER, "jobs", Runtime::Nodejs, &[("JobsVisibilityTimeout", "10")]);
        assert_eq!(planned.queues[1].attributes["visibilityTimeout"], 10);
        assert_eq!(QUEUE_WORKER.name_most(), 57);
        let refused =
            create_app(&PathBuf::from("a".repeat(58)), &"a".repeat(58), Runtime::Python, &QUEUE_WORKER).unwrap_err();
        assert!(refused.message.contains("which names its stack and its functions, aaa"), "{}", refused.message);
        assert!(
            refused.message.contains("-api and aaa")
                && refused.message.contains("-worker: letters, digits and hyphens, a letter first, 57 at most")
        );
    }

    #[test]
    fn the_list_names_every_template_as_its_flag_takes_it_with_what_it_makes() {
        use clap::ValueEnum;
        for &template in Template::value_variants() {
            let flag = template.to_possible_value().unwrap();
            assert_eq!(flag.get_name(), template.as_str());
            assert!(!about(template).is_empty() && about(template).len() <= 110, "{}", template.as_str());
        }
    }
}

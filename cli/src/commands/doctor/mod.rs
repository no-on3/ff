//! `ff doctor [path]`: what a function's folder, or a file, holds that works on FF and not on AWS
//! Lambda, before a move: FF's API keys, its variables and hosts, its original event, files
//! written outside `/tmp`, a TypeScript handler, a package over Lambda's size; and in its SAM
//! template, what CloudFormation can't read and what is beyond Lambda's limits. Errors stop a
//! move; warnings are for a person to judge, and fail it too with `--strict`. With `--deployed`,
//! what in the account still points at FF.

mod account;
mod code;
mod template;

use std::net::IpAddr;
use std::path::Path;

use serde::Serialize;

use super::Context;
use super::package::size;
use crate::cli::{DoctorArgs, Runtime};
use crate::error::{Error, Kind};
use crate::package::{self, FolderFile, Project};

/// The folders of libraries a build installs, which aren't the function's own code to read.
const LIBRARY_FOLDERS: [&str; 5] = ["node_modules", ".venv", "venv", "site-packages", "dist-packages"];

/// `sam build`'s output, copies of the code, which the folder's own files are read for.
const SAM_BUILD: &str = ".aws-sam/";

/// Bigger files aren't read: a bundle's or a data file's lines aren't the function's own code.
const MAX_READ_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// What a move to AWS can't take as it is.
    Error,
    /// What may work otherwise on AWS: for a person to judge.
    Warning,
}

#[derive(Debug, Serialize)]
pub struct Finding {
    /// '/'-separated from the folder.
    pub file: String,
    /// None for what is the file's as a whole.
    pub line: Option<usize>,
    pub level: Level,
    /// The check's name, which the text gives in brackets.
    pub check: &'static str,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    path: String,
    /// The files read line by line.
    files_read: usize,
    /// Those over 1 MB, not read.
    files_not_read: usize,
    findings: Vec<Finding>,
    errors: usize,
    warnings: usize,
}

impl Report {
    /// "2 errors, 1 warning in 14 files read".
    fn summary(&self) -> String {
        let count = |n: usize, what: &str| format!("{n} {what}{}", if n == 1 { "" } else { "s" });
        let mut summary = format!(
            "{}, {} in {}",
            count(self.errors, "error"),
            count(self.warnings, "warning"),
            count(self.files_read, "file")
        );
        summary.push_str(" read");
        if self.files_not_read > 0 {
            summary.push_str(&format!(", {} over 1 MB not", count(self.files_not_read, "file")));
        }
        summary
    }
}

/// FF's hosts, which code moved to AWS wouldn't reach: the cluster's services, and the profile's
/// endpoint's domain, a level up from the API's host, where the console's and the functions' URLs
/// are too. None for an endpoint on this machine.
fn ff_hosts(context: &Context) -> Vec<String> {
    let mut hosts = vec![".svc.cluster.local".to_owned()];
    let Ok(settings) = crate::config::load(context.connection) else { return hosts };
    let endpoint = &settings.endpoint.value;
    let host = endpoint.host();
    if endpoint.is_local() {
        return hosts;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if host.parse::<IpAddr>().is_err() && labels.len() > 2 {
        hosts.push(labels[1..].join("."));
    } else {
        hosts.push(host.to_owned());
    }
    hosts
}

/// Whether a file is in a folder of libraries, at any depth.
fn in_libraries(name: &str) -> bool {
    name.split('/').rev().skip(1).any(|folder| LIBRARY_FOLDERS.contains(&folder))
}

/// A TypeScript module with no JavaScript beside it, which FF runs and Lambda doesn't.
fn is_typescript(name: &str) -> bool {
    [".ts", ".mts", ".cts"].iter().any(|extension| name.ends_with(extension)) && !name.ends_with(".d.ts")
}

fn typescript_handler(file: &str, handler: &str) -> Finding {
    Finding {
        file: file.to_owned(),
        line: None,
        level: Level::Warning,
        check: "typescript-handler",
        message: format!(
            "the handler {handler} is TypeScript, which FF runs and AWS Lambda doesn't: `ff package --compile` makes \
             its JavaScript, as `sam build` does with esbuild"
        ),
    }
}

/// The folder's handler, as `ff deploy` finds it, when it is TypeScript alone.
fn handler_findings(root: &Path, files: &[FolderFile]) -> Option<Finding> {
    let project = Project::detect(root, None).ok().filter(|project| project.runtime == Runtime::Nodejs)?;
    let names: Vec<String> = files.iter().map(|file| file.name.clone()).collect();
    let handler = package::default_handler(&names, project.runtime)?;
    let module = handler.split('.').next()?;
    let has = |extension: &str| names.iter().any(|name| *name == format!("{module}.{extension}"));
    (has("ts") && !["js", "mjs", "cjs"].iter().any(|extension| has(extension)))
        .then(|| typescript_handler(&format!("{module}.ts"), &handler))
}

/// More than AWS Lambda takes unzipped, the folder as it is, its libraries included.
fn size_finding(files: &[FolderFile]) -> Option<Finding> {
    let unpacked: u64 = files.iter().map(|file| file.size).sum();
    (unpacked > package::MAX_UNPACKED_BYTES).then(|| Finding {
        file: ".".to_owned(),
        line: None,
        level: Level::Error,
        check: "package-size",
        message: format!(
            "the folder is {} unzipped, its libraries included: AWS Lambda takes 250 MB (262,144,000 bytes) at most, \
             and a container image 10 GB",
            size(unpacked)
        ),
    })
}

/// The report of a folder, or of one file.
fn report(path: &Path, hosts: &[String]) -> Result<Report, Error> {
    let mut findings = Vec::new();
    let (folder, files) = if path.is_dir() {
        let mut files = package::folder_files(path)?;
        files.retain(|file| !file.name.starts_with(SAM_BUILD));
        findings.extend(size_finding(&files));
        // A template names its functions' handlers, which its checks find.
        if !files.iter().any(|file| template::NAMES.contains(&file.name.as_str())) {
            findings.extend(handler_findings(path, &files));
        }
        (path, files)
    } else {
        let metadata = std::fs::metadata(path)
            .map_err(|error| Error::usage(format!("Couldn't read {}: {error}", path.display())))?;
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        if is_typescript(&name) {
            findings.push(typescript_handler(&name, &format!("{}.handler", name.split('.').next().unwrap_or(&name))));
        }
        (
            path.parent().unwrap_or(Path::new(".")),
            vec![FolderFile { name, path: path.to_owned(), size: metadata.len() }],
        )
    };
    let (mut files_read, mut files_not_read) = (0, 0);
    let today = crate::table::today();
    for file in files.iter().filter(|file| !in_libraries(&file.name)) {
        if file.size > MAX_READ_BYTES {
            files_not_read += 1;
            continue;
        }
        // A file that isn't UTF-8 text isn't code.
        let Ok(text) = String::from_utf8(std::fs::read(&file.path)?) else { continue };
        files_read += 1;
        findings.extend(code::check(&file.name, &text, hosts));
        if template::NAMES.contains(&file.name.as_str()) {
            findings.extend(template::check(&file.name, &text, folder, &today));
        }
    }
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    let errors = findings.iter().filter(|finding| finding.level == Level::Error).count();
    Ok(Report {
        path: path.display().to_string(),
        files_read,
        files_not_read,
        warnings: findings.len() - errors,
        errors,
        findings,
    })
}

/// `file:line: level: message [check]`, a line each, then the summary.
fn text(report: &Report) -> String {
    let mut lines: Vec<String> = report
        .findings
        .iter()
        .map(|finding| {
            let at = finding.line.map(|line| format!(":{line}")).unwrap_or_default();
            let level = if finding.level == Level::Error { "error" } else { "warning" };
            format!("{}{at}: {level}: {} [{}]", finding.file, finding.message, finding.check)
        })
        .collect();
    if report.findings.is_empty() {
        lines.push(format!("{}: nothing found that works on FF alone", report.summary()));
    } else {
        lines.push(report.summary());
    }
    lines.join("\n")
}

pub fn run(args: DoctorArgs, context: &Context) -> Result<(), Error> {
    if args.deployed {
        return account::run(args.strict, context);
    }
    if !args.path.exists() {
        return Err(Error::usage(format!("{} isn't there", args.path.display())));
    }
    let report = report(&args.path, &ff_hosts(context))?;
    // The findings on stdout; the summary of a failure again as the error, on stderr.
    context.out.result(&report, || text(&report))?;
    if report.errors > 0 {
        return Err(Error::new(Kind::Findings, format!("{}: fix the errors before a move to AWS", report.summary())));
    }
    if args.strict && report.warnings > 0 {
        return Err(Error::new(Kind::Findings, format!("{}: --strict fails on warnings", report.summary())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn checks(report: &Report) -> Vec<(&str, Option<usize>, &str)> {
        report.findings.iter().map(|finding| (finding.file.as_str(), finding.line, finding.check)).collect()
    }

    #[test]
    fn reads_the_functions_code_and_not_its_libraries_nor_its_env_files() {
        let dir = tempfile::TempDir::new().unwrap();
        write(dir.path(), "package.json", "{}");
        write(dir.path(), "index.js", "exports.handler = async (event) => event.body.name;\n");
        write(dir.path(), "lib/store.js", "\n\nfs.writeFileSync('/data/x', '');\n");
        write(dir.path(), "node_modules/express/index.js", "process.env.PORT\n");
        write(dir.path(), "venv/lib/site.py", "os.environ['FUNCTION_NAME']\n");
        write(dir.path(), ".env", "FF_TOKEN=ffk_3f9a2b1c0d4e_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE\n");
        write(dir.path(), "ignored/a.js", "process.env.FUNCTION_NAME\n");
        write(dir.path(), ".ffignore", "ignored/\n");

        let report = report(dir.path(), &[]).unwrap();

        assert_eq!(
            checks(&report),
            [("index.js", Some(1), "wrapped-event"), ("lib/store.js", Some(3), "write-outside-tmp")]
        );
        assert_eq!((report.files_read, report.errors, report.warnings), (3, 0, 2));
        assert_eq!(report.summary(), "0 errors, 2 warnings in 3 files read");
    }

    #[test]
    fn a_typescript_handler_alone_is_named_and_one_with_its_javascript_isnt() {
        let dir = tempfile::TempDir::new().unwrap();
        write(dir.path(), "function.ts", "export const handler = async () => 'hi';\n");
        assert_eq!(checks(&report(dir.path(), &[]).unwrap()), [("function.ts", None, "typescript-handler")]);
        assert_eq!(
            checks(&report(&dir.path().join("function.ts"), &[]).unwrap()),
            [("function.ts", None, "typescript-handler")]
        );
        write(dir.path(), "function.js", "exports.handler = async () => 'hi';\n");
        assert_eq!(checks(&report(dir.path(), &[]).unwrap()), []);
        // Python's folder has no TypeScript handler, whatever it holds.
        let python = tempfile::TempDir::new().unwrap();
        write(python.path(), "requirements.txt", "");
        write(python.path(), "lambda_function.py", "def lambda_handler(event, context): pass\n");
        write(python.path(), "tools/index.ts", "");
        assert_eq!(checks(&report(python.path(), &[]).unwrap()), []);
    }

    #[test]
    fn a_folder_over_lambdas_size_is_an_error_its_libraries_counted() {
        let files = |sizes: &[u64]| -> Vec<FolderFile> {
            sizes
                .iter()
                .enumerate()
                .map(|(index, size)| FolderFile {
                    name: format!("node_modules/{index}"),
                    path: "x".into(),
                    size: *size,
                })
                .collect()
        };
        assert!(size_finding(&files(&[200 * 1024 * 1024, 50 * 1024 * 1024])).is_none());
        let finding = size_finding(&files(&[200 * 1024 * 1024, 50 * 1024 * 1024 + 1])).unwrap();
        assert_eq!((finding.level, finding.check), (Level::Error, "package-size"));
        assert!(finding.message.starts_with("the folder is 262.1 MB unzipped"), "{}", finding.message);
    }

    #[test]
    fn big_files_and_binary_ones_arent_read() {
        let dir = tempfile::TempDir::new().unwrap();
        write(dir.path(), "index.js", "");
        write(dir.path(), "bundle.js", &"process.env.FUNCTION_NAME\n".repeat(50_000));
        std::fs::write(dir.path().join("image.png"), [0x89, b'P', b'N', b'G', 0xff, 0xfe]).unwrap();

        let report = report(dir.path(), &[]).unwrap();

        assert_eq!((report.files_read, report.files_not_read, report.findings.len()), (1, 1, 0));
        assert_eq!(report.summary(), "0 errors, 0 warnings in 1 file read, 1 file over 1 MB not");
    }

    #[test]
    fn the_text_names_each_finding_where_it_is_then_the_summary() {
        let dir = tempfile::TempDir::new().unwrap();
        write(dir.path(), "app.py", "import os\nname = os.environ['FUNCTION_NAME']\n");
        let report = report(dir.path(), &[]).unwrap();
        assert_eq!(
            text(&report),
            "app.py:2: warning: reads FUNCTION_NAME, which FF's runtime sets: on Lambda, AWS_LAMBDA_FUNCTION_NAME, or \
             the context's function name [ff-variable]\n0 errors, 1 warning in 1 file read"
        );
        write(dir.path(), "app.py", "print('hi')\n");
        assert_eq!(
            text(&super::report(dir.path(), &[]).unwrap()),
            "0 errors, 0 warnings in 1 file read: nothing found that works on FF alone"
        );
    }

    #[test]
    fn a_folders_template_is_checked_and_sams_build_output_isnt_read() {
        let dir = tempfile::TempDir::new().unwrap();
        let template = "Resources:\n  Orders:\n    Type: AWS::Serverless::Function\n    Properties:\n      CodeUri: .\n      Handler: index.handler\n      Runtime: nodejs24.x\n      Timeout: 901\n";
        write(dir.path(), "template.yaml", template);
        write(dir.path(), "index.ts", "export const handler = async () => 1;\n");
        write(dir.path(), ".aws-sam/build/Orders/index.js", "process.env.FUNCTION_NAME\n");

        let report = report(dir.path(), &[]).unwrap();

        // The template's handler found once, by the template, not again as the folder's own.
        assert_eq!(
            checks(&report),
            [("template.yaml", Some(6), "typescript-handler"), ("template.yaml", Some(8), "lambda-limits")]
        );
        assert_eq!(report.files_read, 2);
        assert_eq!(
            checks(&super::report(&dir.path().join("template.yaml"), &[]).unwrap()),
            [("template.yaml", Some(6), "typescript-handler"), ("template.yaml", Some(8), "lambda-limits")]
        );
    }

    #[test]
    fn libraries_folders_are_found_at_any_depth() {
        assert!(in_libraries("node_modules/a.js"));
        assert!(in_libraries("packages/web/node_modules/x/y.js"));
        assert!(in_libraries(".venv/lib/python3.13/site-packages/x.py"));
        assert!(!in_libraries("node_modules"));
        assert!(!in_libraries("src/venv.py"));
    }
}

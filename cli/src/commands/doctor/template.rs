//! A SAM template's checks, read as CloudFormation reads it: what CloudFormation refuses, at its line; a function's
//! memory and timeout beyond AWS Lambda's limits; a runtime Lambda has deprecated; a TypeScript handler that
//! `sam build` won't make JavaScript of.
//! Whether `ff deploy` takes the template is the subset's to say, with `ff deploy`'s own reading of it.

use std::path::Path;

use serde_json::Value;

use super::{Finding, Level};
use crate::commands::export::template::lambda_runtime;
use crate::sam::{self, Template};

/// The names SAM looks for a template by, in a project's folder.
pub const NAMES: [&str; 2] = ["template.yaml", "template.yml"];

/// The functions' types whose memory and timeout are Lambda's.
const FUNCTION_TYPES: [&str; 2] = ["AWS::Serverless::Function", "AWS::Lambda::Function"];

/// AWS Lambda's limits, which FF's platform has too: a property, its least and its most, as Lambda says them.
const LIMITS: [(&str, i64, i64, &str); 2] = [
    ("MemorySize", 128, 10_240, "a whole number of MB from 128 to 10,240"),
    ("Timeout", 1, 900, "a whole number of seconds from 1 to 900"),
];

/// Lambda's Node.js and Python runtimes, each with the day AWS deprecates it, no longer patching it, and the day Lambda
/// stops creating functions on it, as AWS's table of runtimes gave them on 2026-11-01: the days ahead may move.
const RUNTIMES: [(&str, &str, &str); 23] = [
    ("nodejs", "2016-08-30", "2016-09-30"),
    ("nodejs4.3", "2020-03-05", "2020-02-03"),
    ("nodejs4.3-edge", "2020-03-05", "2019-03-31"),
    ("nodejs6.10", "2019-08-12", "2019-07-12"),
    ("nodejs8.10", "2020-03-06", "2020-02-04"),
    ("nodejs10.x", "2021-07-30", "2021-07-30"),
    ("nodejs12.x", "2023-03-31", "2023-03-31"),
    ("nodejs14.x", "2023-12-04", "2024-01-09"),
    ("nodejs16.x", "2024-06-12", "2027-07-29"),
    ("nodejs18.x", "2025-09-01", "2027-07-29"),
    ("nodejs20.x", "2026-04-30", "2027-07-29"),
    ("nodejs22.x", "2027-04-30", "2027-07-29"),
    ("nodejs24.x", "2028-04-30", "2028-06-01"),
    ("python2.7", "2021-07-15", "2021-07-15"),
    ("python3.6", "2022-07-18", "2022-07-18"),
    ("python3.7", "2023-12-04", "2024-01-09"),
    ("python3.8", "2024-10-14", "2027-07-29"),
    ("python3.9", "2025-12-15", "2027-07-29"),
    ("python3.10", "2026-10-31", "2027-07-29"),
    ("python3.11", "2027-06-30", "2027-07-29"),
    ("python3.12", "2028-10-31", "2028-11-30"),
    ("python3.13", "2029-06-30", "2029-07-31"),
    ("python3.14", "2029-06-30", "2029-07-31"),
];

/// A number as CloudFormation takes one for an integer: a number, or a string of one. None for an intrinsic
/// function, whose value comes at deploy.
fn integer(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// A function's property, its own or the template's Globals', with its pointer.
fn property<'a>(template: &'a Template, id: &str, name: &str) -> Option<(&'a Value, String)> {
    let own = format!("/Resources/{id}/Properties/{name}");
    let global = format!("/Globals/Function/{name}");
    [own, global].into_iter().find_map(|pointer| template.value.pointer(&pointer).map(|value| (value, pointer)))
}

struct Checking<'a> {
    file: &'a str,
    template: &'a Template,
    /// Today, `2026-11-01`, for the runtimes' days.
    today: &'a str,
    findings: Vec<Finding>,
}

impl Checking<'_> {
    fn found(&mut self, pointer: &str, level: Level, check: &'static str, message: String) {
        let line = self.template.at.get(pointer).map(|at| at.line);
        self.findings.push(Finding { file: self.file.to_owned(), line, level, check, message });
    }

    /// Memory and timeout beyond Lambda's limits, where they are written: a function's, or the Globals' once.
    fn limits(&mut self, pointer: &str, owner: &str) {
        for (name, least, most, allowed) in LIMITS {
            let pointer = format!("{pointer}/{name}");
            let Some(value) = self.template.value.pointer(&pointer).and_then(integer) else { continue };
            if value < least as f64 || value > most as f64 || value.fract() != 0.0 {
                self.found(
                    &pointer,
                    Level::Error,
                    "lambda-limits",
                    format!("{owner}: {name} {value}, where AWS Lambda takes {allowed}"),
                );
            }
        }
    }

    /// A runtime AWS Lambda has deprecated by today, where it is written: a warning while Lambda still creates functions
    /// on it, an error once it doesn't, since CloudFormation's create of the function then fails.
    fn runtime(&mut self, pointer: &str, owner: &str) {
        let pointer = format!("{pointer}/Runtime");
        let Some(runtime) = self.template.value.pointer(&pointer).and_then(Value::as_str) else { return };
        let Some(&(_, deprecated, blocked)) = RUNTIMES.iter().find(|(name, ..)| *name == runtime) else { return };
        if deprecated > self.today {
            return;
        }
        let ff = lambda_runtime(if runtime.starts_with("python") { "python" } else { "nodejs" });
        let (level, then) = if blocked <= self.today {
            (Level::Error, format!("Lambda has created no function on it since {blocked}, so CloudFormation can't"))
        } else {
            (Level::Warning, format!("Lambda creates no function on it from {blocked}"))
        };
        self.found(
            &pointer,
            level,
            "deprecated-runtime",
            format!(
                "{owner}: Runtime {runtime}, which AWS Lambda deprecated on {deprecated}, no longer patching it: {then}; \
                 FF runs {ff}"
            ),
        );
    }

    /// A Node.js function whose handler's module is TypeScript alone, in a folder `sam build` copies as it is.
    fn typescript_handler(&mut self, folder: &Path, id: &str) {
        let runtime = property(self.template, id, "Runtime").and_then(|(value, _)| value.as_str());
        let code = property(self.template, id, "CodeUri").and_then(|(value, _)| value.as_str());
        let Some(((handler, at), code)) = property(self.template, id, "Handler")
            .and_then(|(value, at)| Some((value.as_str()?, at)))
            .zip(code)
            .filter(|_| runtime.is_some_and(|runtime| runtime.starts_with("nodejs")))
        else {
            return;
        };
        let built = self.template.value.pointer(&format!("/Resources/{id}/Metadata/BuildMethod"));
        let bundled = code.starts_with("s3://") || code.ends_with(".zip");
        if bundled || built.is_some_and(|method| method == "esbuild") {
            return;
        }
        // The module is the handler up to its first dot after its folders, as Lambda's Node.js runtime finds it.
        let name = handler.rsplit('/').next().unwrap_or(handler);
        let module = format!("{}{}", &handler[..handler.len() - name.len()], name.split('.').next().unwrap_or(name));
        let has = |extension: &str| folder.join(code).join(format!("{module}.{extension}")).is_file();
        if has("ts") && !["js", "mjs", "cjs"].into_iter().any(has) {
            self.found(
                &at,
                Level::Warning,
                "typescript-handler",
                format!(
                    "{id}: the handler {handler} is TypeScript, which FF runs and AWS Lambda doesn't: the resource's \
                     `Metadata: BuildMethod: esbuild` has `sam build` make its JavaScript"
                ),
            );
        }
    }
}

/// The findings of a template, `file` its name as the report gives it, `folder` where its code is, `today` the day
/// the runtimes are checked on.
pub fn check(file: &str, text: &str, folder: &Path, today: &str) -> Vec<Finding> {
    let template = match sam::read(text) {
        Ok(template) => template,
        Err(error) => {
            let message = format!("CloudFormation can't read it, at column {}: {}", error.at.column, error.message);
            return vec![Finding {
                file: file.to_owned(),
                line: Some(error.at.line),
                level: Level::Error,
                check: "template",
                message,
            }];
        }
    };
    let mut checking = Checking { file, template: &template, today, findings: Vec::new() };
    checking.limits("/Globals/Function", "Globals");
    checking.runtime("/Globals/Function", "Globals");
    let functions: Vec<String> = template
        .value
        .get("Resources")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, resource)| {
            resource.get("Type").and_then(Value::as_str).is_some_and(|kind| FUNCTION_TYPES.contains(&kind))
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in &functions {
        checking.limits(&format!("/Resources/{id}/Properties"), id);
        checking.runtime(&format!("/Resources/{id}/Properties"), id);
        checking.typescript_handler(folder, id);
    }
    checking.findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(text: &str, folder: &Path) -> Vec<(Option<usize>, &'static str, String)> {
        check("template.yaml", text, folder, TODAY)
            .into_iter()
            .map(|finding| (finding.line, finding.check, finding.message))
            .collect()
    }

    const TODAY: &str = "2026-11-01";

    const TEMPLATE: &str = "\
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: nodejs24.x
    Timeout: 1200
Resources:
  Orders:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: orders/
      Handler: src/app.handler
      MemorySize: 20480
  Receipts:
    Type: AWS::Serverless::Function
    Metadata:
      BuildMethod: esbuild
    Properties:
      CodeUri: receipts/
      Handler: app.handler
      MemorySize: !Ref Memory
      Timeout: '30'
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      MemorySize: 1
";

    #[test]
    fn lambdas_limits_are_named_where_they_are_written_and_an_intrinsics_value_left_to_the_deploy() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            found(TEMPLATE, dir.path()),
            [
                (
                    Some(5),
                    "lambda-limits",
                    "Globals: Timeout 1200, where AWS Lambda takes a whole number of seconds from 1 to 900".to_owned()
                ),
                (
                    Some(12),
                    "lambda-limits",
                    "Orders: MemorySize 20480, where AWS Lambda takes a whole number of MB from 128 to 10,240"
                        .to_owned()
                ),
            ]
        );
        assert_eq!(
            found(
                "Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      MemorySize: 64\n",
                dir.path()
            )
            .len(),
            1
        );
        assert_eq!(
            found(
                "Resources:\n  F:\n    Type: AWS::Serverless::Function\n    Properties:\n      Timeout: 2.5\n",
                dir.path()
            )
            .len(),
            1
        );
    }

    #[test]
    fn a_typescript_handler_is_named_unless_sam_builds_it_with_esbuild() {
        let dir = tempfile::TempDir::new().unwrap();
        for file in ["orders/src/app.ts", "receipts/app.ts"] {
            std::fs::create_dir_all(dir.path().join(file).parent().unwrap()).unwrap();
            std::fs::write(dir.path().join(file), "export const handler = async () => 1;\n").unwrap();
        }
        let typescript: Vec<_> =
            found(TEMPLATE, dir.path()).into_iter().filter(|(_, check, _)| *check == "typescript-handler").collect();
        assert_eq!(
            typescript,
            [(
                Some(11),
                "typescript-handler",
                "Orders: the handler src/app.handler is TypeScript, which FF runs and AWS Lambda doesn't: the resource's \
                 `Metadata: BuildMethod: esbuild` has `sam build` make its JavaScript"
                    .to_owned()
            )]
        );
        // Its JavaScript beside it: what Lambda runs.
        std::fs::write(dir.path().join("orders/src/app.js"), "").unwrap();
        assert!(found(TEMPLATE, dir.path()).iter().all(|(_, check, _)| *check != "typescript-handler"));
    }

    #[test]
    fn a_runtime_lambda_deprecated_is_a_warning_and_an_error_once_lambda_creates_no_function_on_it() {
        let text = "\
Globals:
  Function:
    Runtime: python3.10
Resources:
  Old:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: nodejs14.x
  Current:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: nodejs24.x
";
        let found: Vec<_> = check("template.yaml", text, Path::new("."), TODAY)
            .into_iter()
            .map(|finding| (finding.line, finding.level, finding.message))
            .collect();
        assert_eq!(
            found,
            [
                (
                    Some(3),
                    Level::Warning,
                    "Globals: Runtime python3.10, which AWS Lambda deprecated on 2026-10-31, no longer patching it: \
                     Lambda creates no function on it from 2027-07-29; FF runs python3.13"
                        .to_owned()
                ),
                (
                    Some(8),
                    Level::Error,
                    "Old: Runtime nodejs14.x, which AWS Lambda deprecated on 2023-12-04, no longer patching it: Lambda \
                     has created no function on it since 2024-01-09, so CloudFormation can't; FF runs nodejs24.x"
                        .to_owned()
                ),
            ]
        );
        // The day before python3.10's: Lambda still patched it.
        assert_eq!(check("template.yaml", text, Path::new("."), "2026-10-30").len(), 1);
    }

    #[test]
    fn what_cloudformation_cant_read_is_an_error_at_its_line() {
        assert_eq!(
            found("Resources:\n  A:\n    Type: !Reff X\n", Path::new(".")),
            [(
                Some(3),
                "template",
                "CloudFormation can't read it, at column 17: !Reff: not one of CloudFormation's tags, which are !Ref, \
                 !Condition, !And, !Base64, !Cidr, !Equals, !FindInMap, !GetAtt, !GetAZs, !If, !ImportValue, !Join, \
                 !Not, !Or, !Select, !Split, !Sub, !Transform"
                    .to_owned()
            )]
        );
    }
}

//! A SAM template's checks, read as CloudFormation reads it: what CloudFormation refuses, at its line; a function's
//! memory and timeout beyond AWS Lambda's limits; a runtime Lambda has deprecated; a TypeScript handler that
//! `sam build` won't make JavaScript of. And what `ff deploy` doesn't take, by its own reading of the template: what
//! is outside FF's subset of SAM, a warning each, since AWS takes it; a parameter's value, as `sam deploy` takes it
//! from `--parameter-overrides` or `samconfig.toml`, that CloudFormation would refuse, or none.

use std::path::Path;

use serde_json::Value;

use super::{Finding, Level};
use crate::commands::export::template::lambda_runtime;
use crate::sam::parameters::SAMCONFIG;
use crate::sam::{self, Template, parameters, resolve, subset};

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

struct Checking<'a> {
    file: &'a str,
    template: &'a Template,
    /// The template's value, each parameter's `Ref` resolved where its value is known.
    value: Value,
    /// Today, `2026-11-01`, for the runtimes' days.
    today: &'a str,
    findings: Vec<Finding>,
}

impl Checking<'_> {
    fn found(&mut self, pointer: &str, level: Level, check: &'static str, message: String) {
        let line = self.template.line(pointer);
        self.findings.push(Finding { file: self.file.to_owned(), line, level, check, message });
    }

    /// A function's property, its own or the template's Globals', with its pointer.
    fn property(&self, id: &str, name: &str) -> Option<(&Value, String)> {
        let own = format!("/Resources/{id}/Properties/{name}");
        let global = format!("/Globals/Function/{name}");
        [own, global].into_iter().find_map(|pointer| self.value.pointer(&pointer).map(|value| (value, pointer)))
    }

    /// Memory and timeout beyond Lambda's limits, where they are written: a function's, or the Globals' once.
    fn limits(&mut self, pointer: &str, owner: &str) {
        for (name, least, most, allowed) in LIMITS {
            let pointer = format!("{pointer}/{name}");
            let Some(value) = self.value.pointer(&pointer).and_then(integer) else { continue };
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
        let Some(runtime) = self.value.pointer(&pointer).and_then(Value::as_str) else { return };
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
        let runtime = self.property(id, "Runtime").and_then(|(value, _)| value.as_str());
        let code = self.property(id, "CodeUri").and_then(|(value, _)| value.as_str());
        let Some(((handler, at), code)) = self
            .property(id, "Handler")
            .and_then(|(value, at)| Some((value.as_str()?, at)))
            .zip(code)
            .filter(|_| runtime.is_some_and(|runtime| runtime.starts_with("nodejs")))
        else {
            return;
        };
        let built = self.value.pointer(&format!("/Resources/{id}/Metadata/BuildMethod"));
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

/// The parameters' values given, as `sam deploy` takes them: `--parameter-overrides`', else the folder's
/// samconfig.toml's; with where they were given, for a finding on one the template hasn't.
fn given(folder: &Path, overrides: Option<&[(String, String)]>) -> Result<(Vec<(String, String)>, String), Finding> {
    if let Some(overrides) = overrides {
        return Ok((overrides.to_vec(), "--parameter-overrides".to_owned()));
    }
    let path = folder.join(SAMCONFIG);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok((Vec::new(), SAMCONFIG.to_owned())) };
    parameters::samconfig(&text).map(|config| (config.parameter_overrides, SAMCONFIG.to_owned())).map_err(|why| {
        Finding {
            file: SAMCONFIG.to_owned(),
            line: None,
            level: Level::Error,
            check: "samconfig",
            message: format!("the SAM CLI can't read it for `sam deploy`: {why}"),
        }
    })
}

/// What `ff deploy` wouldn't take, as its reading of the template finds it: the subset's and the parameters'.
fn deploy_findings(file: &str, template: &Template, values: &parameters::Values, from: &str) -> Vec<Finding> {
    let finding = |line, level, check, message| Finding { file: file.to_owned(), line, level, check, message };
    let parameter_line = |name: &str| template.line(&format!("/Parameters/{name}"));
    let mut findings: Vec<Finding> = subset::check(template, &values.values)
        .into_iter()
        .map(|problem| match problem.kind {
            subset::Kind::Outside => finding(problem.line, Level::Warning, "sam-subset", problem.message),
            subset::Kind::Invalid => finding(problem.line, Level::Error, "template", problem.message),
        })
        .collect();
    for (name, why) in &values.refused {
        findings.push(finding(
            parameter_line(name),
            Level::Error,
            "sam-parameter",
            format!("the parameter {name}: {why}, which CloudFormation refuses"),
        ));
    }
    for name in &values.missing {
        findings.push(finding(
            parameter_line(name),
            Level::Warning,
            "sam-parameter",
            format!(
                "the parameter {name} has no Default and no value given: `sam deploy` and `ff deploy` need one, from \
                 --parameter-overrides, {SAMCONFIG} or the stack's last deploy"
            ),
        ));
    }
    for name in &values.unknown {
        findings.push(Finding {
            file: if from == SAMCONFIG { SAMCONFIG.to_owned() } else { file.to_owned() },
            line: None,
            level: Level::Warning,
            check: "sam-parameter",
            message: format!(
                "{from} gives {name}, which the template has no parameter for: `sam deploy` passes it over, as \
                 `ff deploy` does"
            ),
        });
    }
    findings
}

/// The findings of a template, `file` its name as the report gives it, `folder` where its code is, `today` the day
/// the runtimes are checked on, `overrides` the parameters' values given in place of samconfig.toml's.
pub fn check(
    file: &str,
    text: &str,
    folder: &Path,
    today: &str,
    overrides: Option<&[(String, String)]>,
) -> Vec<Finding> {
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
    let (given, from, mut findings) = match given(folder, overrides) {
        Ok((given, from)) => (given, from, Vec::new()),
        Err(finding) => (Vec::new(), SAMCONFIG.to_owned(), vec![finding]),
    };
    let values = parameters::values(&template, &given);
    findings.extend(deploy_findings(file, &template, &values, &from));
    let known = |name: &str, attribute: Option<&str>| attribute.is_none().then(|| values.values.get(name).cloned())?;
    let value = resolve::resolve(&template.value, &known);
    let mut checking = Checking { file, template: &template, value, today, findings };
    checking.limits("/Globals/Function", "Globals");
    checking.runtime("/Globals/Function", "Globals");
    let functions: Vec<String> = checking
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
    let mut findings = checking.findings;
    findings.sort_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The checks of what `ff deploy` would take, which tests of their own name.
    const DEPLOY_CHECKS: [&str; 3] = ["sam-subset", "sam-parameter", "samconfig"];

    /// The findings of a template's own checks.
    fn found(text: &str, folder: &Path) -> Vec<(Option<usize>, &'static str, String)> {
        check("template.yaml", text, folder, TODAY, None)
            .into_iter()
            .filter(|finding| !DEPLOY_CHECKS.contains(&finding.check))
            .map(|finding| (finding.line, finding.check, finding.message))
            .collect()
    }

    /// Every finding, as the report gives it: its file, line, level and check, and its message.
    fn found_all(
        text: &str,
        folder: &Path,
        overrides: Option<&[(String, String)]>,
    ) -> Vec<(String, Option<usize>, Level, &'static str, String)> {
        check("template.yaml", text, folder, TODAY, overrides)
            .into_iter()
            .map(|finding| (finding.file, finding.line, finding.level, finding.check, finding.message))
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
Parameters:
  Memory:
    Type: Number
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
                "Transform: AWS::Serverless-2016-10-31\nResources:\n  F:\n    Type: AWS::Serverless::Function\n    \
                 Properties:\n      CodeUri: f/\n      Handler: a.b\n      Runtime: python3.13\n      Timeout: 2.5\n",
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
        let runtimes = |today| -> Vec<_> {
            check("template.yaml", text, Path::new("."), today, None)
                .into_iter()
                .filter(|finding| finding.check == "deprecated-runtime")
                .map(|finding| (finding.line, finding.level, finding.message))
                .collect()
        };
        let found = runtimes(TODAY);
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
        assert_eq!(runtimes("2026-10-30").len(), 1);
    }

    const WITH_PARAMETERS: &str = "\
Transform: AWS::Serverless-2016-10-31
Parameters:
  Memory:
    Type: Number
    Default: 512
  Stage:
    Type: String
    AllowedValues: [prod, test]
  Runtime:
    Type: String
    Default: nodejs24.x
Resources:
  Orders:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: orders/
      Handler: index.handler
      Runtime: !Ref Runtime
      MemorySize: !Ref Memory
      Layers: [arn:aws:lambda:eu-west-1:123456789012:layer:libraries:1]
      Environment:
        Variables:
          STAGE: !Ref Stage
";

    #[test]
    fn what_ff_deploy_wouldnt_take_is_named_with_the_parameters_values_as_sam_deploy_gives_them() {
        let dir = tempfile::TempDir::new().unwrap();
        let template =
            |line, level, check, message: &str| ("template.yaml".to_owned(), line, level, check, message.to_owned());
        let layers = template(
            Some(20),
            Level::Warning,
            "sam-subset",
            "Orders' Layers: FF has no layers: put the libraries in the function's zip",
        );
        // No samconfig.toml: Stage has no value.
        let no_stage = template(
            Some(6),
            Level::Warning,
            "sam-parameter",
            "the parameter Stage has no Default and no value given: `sam deploy` and `ff deploy` need one, from \
             --parameter-overrides, samconfig.toml or the stack's last deploy",
        );
        assert_eq!(found_all(WITH_PARAMETERS, dir.path(), None), [no_stage.clone(), layers.clone()]);

        // samconfig.toml's values for `sam deploy`: the memory, from its parameter, over Lambda's; a runtime FF hasn't.
        std::fs::write(
            dir.path().join(SAMCONFIG),
            "version = 0.1\n[default.deploy.parameters]\nparameter_overrides = \"Memory=20480 Stage=dev \
             Runtime=nodejs22.x Other=1\"\n",
        )
        .unwrap();
        assert_eq!(
            found_all(WITH_PARAMETERS, dir.path(), None),
            [
                (
                    SAMCONFIG.to_owned(),
                    None,
                    Level::Warning,
                    "sam-parameter",
                    "samconfig.toml gives Other, which the template has no parameter for: `sam deploy` passes it \
                     over, as `ff deploy` does"
                        .to_owned()
                ),
                template(
                    Some(6),
                    Level::Error,
                    "sam-parameter",
                    "the parameter Stage: the value given, dev, isn't one of its AllowedValues, prod, test, which \
                     CloudFormation refuses"
                ),
                template(
                    Some(18),
                    Level::Warning,
                    "sam-subset",
                    "Orders' Runtime nodejs22.x: FF runs nodejs24.x and python3.13, as Lambda names them"
                ),
                template(
                    Some(19),
                    Level::Error,
                    "lambda-limits",
                    "Orders: MemorySize 20480, where AWS Lambda takes a whole number of MB from 128 to 10,240"
                ),
                layers.clone(),
            ]
        );

        // --parameter-overrides, in place of samconfig.toml's.
        let overrides = [("Stage".to_owned(), "prod".to_owned())];
        assert_eq!(found_all(WITH_PARAMETERS, dir.path(), Some(&overrides)), [layers]);

        // A samconfig.toml the SAM CLI can't read: said, and the template checked without its values.
        std::fs::write(dir.path().join(SAMCONFIG), "[default.deploy.parameters\n").unwrap();
        let found = found_all(WITH_PARAMETERS, dir.path(), None);
        assert_eq!(
            found
                .iter()
                .map(|(file, line, level, check, _)| (file.as_str(), *line, *level, *check))
                .collect::<Vec<_>>(),
            [
                (SAMCONFIG, None, Level::Error, "samconfig"),
                ("template.yaml", Some(6), Level::Warning, "sam-parameter"),
                ("template.yaml", Some(20), Level::Warning, "sam-subset"),
            ]
        );
        assert!(found[0].4.starts_with("the SAM CLI can't read it for `sam deploy`: it isn't TOML"), "{}", found[0].4);
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

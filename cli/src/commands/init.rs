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

const FUNCTION_TS: &str = include_str!("../../templates/function.ts");
const FUNCTION_PY: &str = include_str!("../../templates/function.py");
const EVENT: &str = include_str!("../../templates/event.json");
const README: &str = include_str!("../../templates/README.md");

/// A Terraform project's files, by their path in it, but its code's.
const TERRAFORM: [(&str, &str); 18] = [
    ("providers.tf", include_str!("../../templates/terraform/providers.tf")),
    ("main.tf", include_str!("../../templates/terraform/main.tf")),
    ("README.md", include_str!("../../templates/terraform/README.md")),
    (".gitignore", include_str!("../../templates/terraform/gitignore")),
    ("modules/function/main.tf", include_str!("../../templates/terraform/modules/function/main.tf")),
    ("modules/function/variables.tf", include_str!("../../templates/terraform/modules/function/variables.tf")),
    ("modules/function/outputs.tf", include_str!("../../templates/terraform/modules/function/outputs.tf")),
    ("modules/queue-worker/main.tf", include_str!("../../templates/terraform/modules/queue-worker/main.tf")),
    ("modules/queue-worker/variables.tf", include_str!("../../templates/terraform/modules/queue-worker/variables.tf")),
    ("modules/queue-worker/outputs.tf", include_str!("../../templates/terraform/modules/queue-worker/outputs.tf")),
    ("modules/bucket-function/main.tf", include_str!("../../templates/terraform/modules/bucket-function/main.tf")),
    (
        "modules/bucket-function/variables.tf",
        include_str!("../../templates/terraform/modules/bucket-function/variables.tf"),
    ),
    (
        "modules/bucket-function/outputs.tf",
        include_str!("../../templates/terraform/modules/bucket-function/outputs.tf"),
    ),
    ("modules/site/main.tf", include_str!("../../templates/terraform/modules/site/main.tf")),
    ("modules/site/variables.tf", include_str!("../../templates/terraform/modules/site/variables.tf")),
    ("modules/site/outputs.tf", include_str!("../../templates/terraform/modules/site/outputs.tf")),
    ("site/index.html", include_str!("../../templates/terraform/site/index.html")),
    ("site/404.html", include_str!("../../templates/terraform/site/404.html")),
];

/// A Terraform project's code: its three functions' handlers, in each runtime.
const TERRAFORM_NODEJS: [(&str, &str); 3] = [
    ("src/api.mjs", include_str!("../../templates/terraform/src/api.mjs")),
    ("src/worker.mjs", include_str!("../../templates/terraform/src/worker.mjs")),
    ("src/uploads.mjs", include_str!("../../templates/terraform/src/uploads.mjs")),
];
const TERRAFORM_PYTHON: [(&str, &str); 3] = [
    ("src/api.py", include_str!("../../templates/terraform/src/api.py")),
    ("src/worker.py", include_str!("../../templates/terraform/src/worker.py")),
    ("src/uploads.py", include_str!("../../templates/terraform/src/uploads.py")),
];

/// A SAM application's files, by their path in it, but its code's: `sam init`'s hello world as FF takes it, its
/// template, samconfig.toml naming its stack, a function URL's request as its event, and a README.
const SAM: [(&str, &str); 5] = [
    ("template.yaml", include_str!("../../templates/sam/template.yaml")),
    ("samconfig.toml", include_str!("../../templates/sam/samconfig.toml")),
    ("README.md", include_str!("../../templates/sam/README.md")),
    (".gitignore", include_str!("../../templates/sam/gitignore")),
    ("events/event.json", include_str!("../../templates/sam/event.json")),
];
/// Its code in each runtime's language, in the folder and with the handler `sam init`'s has, and the handler's test.
const SAM_NODEJS: [(&str, &str); 3] = [
    ("hello-world/app.mjs", include_str!("../../templates/sam/nodejs/hello-world/app.mjs")),
    ("hello-world/package.json", include_str!("../../templates/sam/nodejs/hello-world/package.json")),
    ("tests/unit/test-handler.mjs", include_str!("../../templates/sam/nodejs/tests/unit/test-handler.mjs")),
];
const SAM_PYTHON: [(&str, &str); 6] = [
    ("hello_world/__init__.py", ""),
    ("hello_world/app.py", include_str!("../../templates/sam/python/hello_world/app.py")),
    ("hello_world/requirements.txt", include_str!("../../templates/sam/python/hello_world/requirements.txt")),
    ("tests/__init__.py", ""),
    ("tests/unit/__init__.py", ""),
    ("tests/unit/test_handler.py", include_str!("../../templates/sam/python/tests/unit/test_handler.py")),
];

/// A SAM application's function in a runtime's language, as `sam init`'s hello world has it.
struct SamCode {
    files: &'static [(&'static str, &'static str)],
    /// The folder of its code, its CodeUri.
    code_uri: &'static str,
    handler: &'static str,
    /// What runs the handler's test.
    test: &'static str,
}

const fn sam_code(runtime: Runtime) -> SamCode {
    match runtime {
        Runtime::Nodejs => {
            SamCode { files: &SAM_NODEJS, code_uri: "hello-world/", handler: "app.lambdaHandler", test: "node --test" }
        }
        Runtime::Python => SamCode {
            files: &SAM_PYTHON,
            code_uri: "hello_world/",
            handler: "app.lambda_handler",
            test: "python3 -m unittest",
        },
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
    SAM.iter().chain(code.files).map(|(path, template)| (*path, fill(template))).collect()
}

/// Writes a SAM application's folder, which must not exist yet, or be empty.
fn create_sam(folder: &Path, name: &str, runtime: Runtime) -> Result<Vec<PathBuf>, Error> {
    if !super::stack::is_stack_name(name) {
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
    let (file, handler, language, extension) = match runtime {
        Runtime::Nodejs => ("function.ts", FUNCTION_TS, "TypeScript, for Node.js", "ts"),
        Runtime::Python => ("function.py", FUNCTION_PY, "Python", "py"),
    };
    let fill = |template: &str| {
        template.replace("{{name}}", name).replace("{{language}}", language).replace("{{extension}}", extension)
    };
    vec![(file, fill(handler)), ("events/event.json", EVENT.to_owned()), ("README.md", fill(README))]
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
    let (code, language) = match runtime {
        Runtime::Nodejs => (&TERRAFORM_NODEJS, "JavaScript, for Node.js"),
        Runtime::Python => (&TERRAFORM_PYTHON, "Python"),
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
    Ok(TERRAFORM.iter().chain(code.iter()).map(|(path, template)| (*path, fill(template))).collect())
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

pub fn run(name: &str, runtime: Runtime, template: Template, context: &Context) -> Result<(), Error> {
    let folder = PathBuf::from(name);
    let written = match template {
        Template::Function => create(&folder, name, runtime)?,
        Template::Terraform => create_terraform(&folder, name, runtime, context)?,
        Template::Sam => create_sam(&folder, name, runtime)?,
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
            let place = plan::Place { stack: "shop", region: "tn-tunis-1", account: "000000000001" };
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
}

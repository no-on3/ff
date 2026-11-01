//! `ff doctor` on folders of code: what it finds, where, how it says so, and the exit code a
//! script reads: 1 for an error, or with `--strict` a warning. It calls no API; with `--deployed`,
//! it reads the account as `ff export` does, here from a scripted API.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

/// A folder holding these files.
fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::TempDir::new().unwrap();
    for (name, text) in files {
        let path = dir.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    dir
}

const KEY: &str = "ffk_3f9a2b1c0d4e_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

const HANDLER: &str = "exports.handler = async (event) => {\n  const name = event.body.name;\n  return fetch(`https://orders.dev.ffunc.cloud/${name}`);\n};\n";

#[test]
fn an_error_fails_with_1_after_every_finding_where_it_is() {
    let code = folder(&[("index.js", HANDLER), ("config.json", &format!("{{ \"key\": \"{KEY}\" }}\n"))]);
    // The profile's API is FF's: its domain is too.
    let settings = with_key("https://api.dev.ffunc.cloud");

    ff(&settings).arg("doctor").arg(code.path()).assert().code(1).stdout(
        "config.json:1: error: holds FF's API key ffk_3f9a2b1c0d4e_…, a secret, which AWS doesn't take: keep it out of \
         the code and revoke it [ff-key]\n\
         index.js:2: warning: reads event.body as an object, as FF's original event gave the payload: on Lambda, a \
         direct call's event is the payload itself, and a function URL's body a string to JSON.parse [wrapped-event]\n\
         index.js:3: warning: names dev.ffunc.cloud, FF's: on AWS, the service's own address, or a variable set at \
         deploy [ff-host]\n\
         1 error, 2 warnings in 2 files read\n",
    )
    .stderr("error: 1 error, 2 warnings in 2 files read: fix the errors before a move to AWS\n");
}

#[test]
fn warnings_pass_unless_strict_and_a_clean_folder_says_so() {
    let code = folder(&[("app.py", "import os\nname = os.environ['FUNCTION_NAME']\n")]);
    let settings = tempfile::TempDir::new().unwrap();

    ff(&settings)
        .arg("doctor")
        .arg(code.path())
        .assert()
        .success()
        .stdout(predicate::str::ends_with("[ff-variable]\n0 errors, 1 warning in 1 file read\n"));
    ff(&settings)
        .arg("doctor")
        .arg(code.path())
        .arg("--strict")
        .assert()
        .code(1)
        .stderr("error: 0 errors, 1 warning in 1 file read: --strict fails on warnings\n");

    let clean = folder(&[("lambda_function.py", "def lambda_handler(event, context):\n    return event\n")]);
    ff(&settings)
        .arg("doctor")
        .arg(clean.path())
        .arg("--strict")
        .assert()
        .success()
        .stdout("0 errors, 0 warnings in 1 file read: nothing found that works on FF alone\n");
}

#[test]
fn json_gives_each_finding_with_its_check_and_the_counts() {
    let code = folder(&[("function.ts", "export const handler = async () => process.env.FUNCTION_TIMEOUT;\n")]);
    let settings = tempfile::TempDir::new().unwrap();

    let output = ff(&settings).arg("doctor").arg(code.path()).args(["--output", "json"]).output().unwrap();

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["path"], json!(code.path().display().to_string()));
    assert_eq!(
        report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|finding| (
                finding["file"].clone(),
                finding["line"].clone(),
                finding["level"].clone(),
                finding["check"].clone()
            ))
            .collect::<Vec<_>>(),
        [
            (json!("function.ts"), Value::Null, json!("warning"), json!("typescript-handler")),
            (json!("function.ts"), json!(1), json!("warning"), json!("ff-variable")),
        ]
    );
    assert_eq!(
        (
            report["filesRead"].clone(),
            report["filesNotRead"].clone(),
            report["errors"].clone(),
            report["warnings"].clone()
        ),
        (json!(1), json!(0), json!(0), json!(2))
    );
}

#[test]
fn a_file_is_checked_alone_and_a_path_not_there_is_a_usage_error() {
    let code = folder(&[("handler.mjs", "fs.writeFileSync('out.json', '{}');\n"), ("other.js", "process.env.FF_X\n")]);
    let settings = tempfile::TempDir::new().unwrap();

    ff(&settings)
        .arg("doctor")
        .arg(code.path().join("handler.mjs"))
        .assert()
        .success()
        .stdout(predicate::str::starts_with("handler.mjs:1: warning: writes to out.json:"))
        .stdout(predicate::str::ends_with("0 errors, 1 warning in 1 file read\n"));
    ff(&settings)
        .arg("doctor")
        .arg(code.path().join("nothing"))
        .assert()
        .code(2)
        .stderr(predicate::str::contains("isn't there"));
}

#[test]
fn a_template_is_read_as_cloudformation_reads_it_and_lambdas_limits_checked() {
    let template = "Transform: AWS::Serverless-2016-10-31\nResources:\n  Orders:\n    Type: AWS::Serverless::Function\n    Properties:\n      CodeUri: code/orders.zip\n      Handler: index.handler\n      Runtime: nodejs24.x\n      MemorySize: 64\n";
    let code = folder(&[("template.yaml", template)]);
    let settings = tempfile::TempDir::new().unwrap();

    ff(&settings).arg("doctor").arg(code.path()).assert().code(1).stdout(
        "template.yaml:9: error: Orders: MemorySize 64, where AWS Lambda takes a whole number of MB from 128 to 10,240 \
         [lambda-limits]\n1 error, 0 warnings in 1 file read\n",
    );

    std::fs::write(
        code.path().join("template.yaml"),
        "Resources:\n  Orders: &orders {Type: AWS::SQS::Queue}\n  Receipts: *orders\n",
    )
    .unwrap();
    ff(&settings).arg("doctor").arg(code.path()).assert().code(1).stdout(predicate::str::starts_with(
        "template.yaml:3: error: CloudFormation can't read it, at column 13: an alias (*name)",
    ));
}

const AT: &str = "2026-10-21T09:00:00.000Z";

/// The replies, in the order `ff doctor --deployed` asks: the account, its function and what calls it or what its
/// keys used, the queues, buckets, databases, caches and mail, then the storage keys, which a developer can't list.
fn account() -> Vec<Reply> {
    let function = json!({ "id": "f1", "name": "orders", "runtime": "nodejs", "code": "", "packageType": "inline",
                           "handler": "function.handler", "memory": 128, "timeout": 3, "status": "ACTIVE",
                           "eventFormat": "wrapped", "minInstances": 2, "maxInstances": 3, "scaleToZero": false,
                           "createdAt": AT, "updatedAt": AT });
    let not_found = || Reply::json(404, json!({ "statusCode": 404, "message": "none" }));
    vec![
        Reply::json(
            200,
            json!({ "user": null, "key": { "id": "0123456789ab", "name": "ci", "scopes": ["functions:read"] },
                    "accounts": [{ "id": "123456789012", "name": "Shop", "status": "active", "role": "developer",
                                   "plan": { "id": "beta", "name": "Beta", "limits": {} },
                                   "internetEgress": false, "dataDeletionDueAt": null, "dataDeletedAt": null }] }),
        ),
        Reply::json(200, json!([function])),
        Reply::json(200, function),
        Reply::json(200, json!({ "secrets": [] })),
        not_found(),
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        not_found(),
        Reply::json(
            200,
            json!({ "uses": [{ "service": "sqs", "resource": "orders", "operation": "SendMessage", "firstDay": "2026-10-22", "lastDay": "2026-10-31" }] }),
        ),
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        Reply::json(403, json!({ "statusCode": 403, "message": "Only the account's owners can do this" })),
    ]
}

#[test]
fn the_account_says_what_still_points_at_ff_and_what_the_token_couldnt_read() {
    let api = Server::start(account());
    let settings = with_key(&api.url);

    ff(&settings).args(["doctor", "--deployed"]).assert().success().stdout(
        "function orders: warning: gets FF's original event, its input in `event.body`: move it to Lambda's event on \
         FF first, its handler reading `event` and its `eventFormat` set to `lambda` together, as the guide says, so \
         that it runs as it will on Lambda [wrapped-event]\n\
         function orders: warning: keeps 2 instances running when idle: AWS bills that as provisioned concurrency, by \
         the hour, called or not, which the export writes as `ProvisionedConcurrencyConfig` [warm-instances]\n\
         function orders: warning: reached FF's SQS (orders) through the endpoints FF sets in its environment, last on \
         2026-10-31: on AWS, AWS's own, its role allowing what it used [ff-endpoints]\n\
         account 123456789012: 3 warnings, what still points at FF\n",
    )
    .stderr(predicate::str::ends_with(
        "warning: not checked, the account's storage keys: Only the account's owners can do this\n",
    ));
    let paths: Vec<String> =
        api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect();
    assert_eq!(paths.first().map(String::as_str), Some("GET /me"));
    assert_eq!(paths.last().map(String::as_str), Some("GET /storage-keys"));
    assert!(paths.iter().all(|path| path.starts_with("GET ")), "{paths:?}");

    let api = Server::start(account());
    let settings = with_key(&api.url);
    let output = ff(&settings).args(["doctor", "--deployed", "--strict", "--output", "json"]).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["warnings"], json!(3));
    assert_eq!(report["findings"][0]["resource"], json!("function orders"));
    assert_eq!(report["notChecked"], json!(["the account's storage keys: Only the account's owners can do this"]));

    ff(&settings).args(["doctor", "--deployed", "some/folder"]).assert().code(2);
}

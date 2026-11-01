//! `ff doctor` on folders of code: what it finds, where, how it says so, and the exit code a
//! script reads: 1 for an error, or with `--strict` a warning. It calls no API.

mod common;

use common::{ff, with_key};
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

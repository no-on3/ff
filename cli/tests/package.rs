//! `ff package` and `ff deploy <folder>` against a scripted API: the zip each makes, what a
//! deploy sends and uploads, and when it uploads nothing. npm and pip are stand-ins on the PATH
//! that record where and how they ran.

mod common;

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const INDEX: &str = "exports.handler = async () => ({ statusCode: 200, body: require('./lib/greet')('FF') });\n";
const GREET: &str = "module.exports = (name) => `Hello ${name}`;\n";

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

/// A function's folder, `orders`, with its handler's file and a library of its own.
fn orders() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::TempDir::new().unwrap();
    let root = dir.path().join("orders");
    for (name, text) in [("index.js", INDEX), ("lib/greet.js", GREET)] {
        std::fs::create_dir_all(root.join(name).parent().unwrap()).unwrap();
        std::fs::write(root.join(name), text).unwrap();
    }
    (dir, root)
}

/// The names of a zip's files, from its central directory.
fn names(zip: &[u8]) -> Vec<String> {
    let u16at = |at: usize| u16::from_le_bytes([zip[at], zip[at + 1]]) as usize;
    let u32at = |at: usize| u32::from_le_bytes([zip[at], zip[at + 1], zip[at + 2], zip[at + 3]]) as usize;
    let end = zip.len() - 22;
    let (count, mut at) = (u16at(end + 10), u32at(end + 16));
    let mut names = Vec::new();
    for _ in 0..count {
        let length = u16at(at + 28);
        names.push(String::from_utf8(zip[at + 46..at + 46 + length].to_vec()).unwrap());
        at += 46 + length + u16at(at + 30) + u16at(at + 32);
    }
    names
}

fn sha256(bytes: &[u8]) -> String {
    STANDARD.encode(ring::digest::digest(&ring::digest::SHA256, bytes))
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

fn calls(api: &Server) -> Vec<String> {
    api.requests().iter().map(|request| format!("{} {}", request.method, request.path)).collect()
}

/// A query's value as sent, its %XX escapes undone.
fn unescape(text: &str) -> String {
    let mut bytes = Vec::new();
    let mut rest = text.as_bytes();
    while let Some((&byte, tail)) = rest.split_first() {
        if byte == b'%' && tail.len() >= 2 {
            bytes.push(u8::from_str_radix(std::str::from_utf8(&tail[..2]).unwrap(), 16).unwrap());
            rest = &tail[2..];
        } else {
            bytes.push(byte);
            rest = tail;
        }
    }
    String::from_utf8(bytes).unwrap()
}

/// `ff package --output json` of a folder, as a script reads it.
fn package(root: &Path, args: &[&str]) -> Value {
    let settings = tempfile::TempDir::new().unwrap();
    let output = ff(&settings).arg("package").arg(root).args(args).args(["--output", "json"]).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

fn function(fields: Value) -> Value {
    let mut function = json!({
        "id": "f1", "name": "orders", "accountId": "123456789012", "runtime": "nodejs", "code": "", "memory": 128, "timeout": 5,
        "packageType": "zip", "handler": "index.handler", "codeSha256": "old=", "codeSize": 900,
        "status": "ACTIVE", "eventFormat": "lambda", "metadata": null, "error": null, "minInstances": 0, "maxInstances": 3,
        "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:05:00.000Z"
    });
    function.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
    function
}

#[test]
fn package_writes_the_same_zip_twice_into_ffs_own_folder_and_says_what_it_holds() {
    let (_dir, root) = orders();
    std::fs::write(root.join(".env"), "DB_PASSWORD=hunter2\n").unwrap();

    let settings = tempfile::TempDir::new().unwrap();
    ff(&settings)
        .arg("package")
        .arg(&root)
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^packaged .*orders as .*orders/\.ff/orders\.zip: nodejs, 2 files, \d+ bytes \(\d+ bytes unpacked\)\nhandler: index.handler\nSHA-256: [A-Za-z0-9+/]{43}=\n$").unwrap())
        .stderr(predicate::str::contains("warning: not packaged: .env, which usually hold secrets: `ff secrets set` gives a function its secrets"));

    let zip = std::fs::read(root.join(".ff/orders.zip")).unwrap();
    assert_eq!(names(&zip), ["index.js", "lib/greet.js"]);
    assert_eq!(
        std::fs::read_to_string(root.join(".ff/.gitignore")).unwrap(),
        "# ff's own: the zips ff package makes\n*\n"
    );

    // Again, its own zip in the folder: the same bytes.
    let again = package(&root, &[]);
    assert_eq!(again["codeSha256"], sha256(&zip));
    assert_eq!(std::fs::read(root.join(".ff/orders.zip")).unwrap(), zip);
    assert_eq!(again["fileCount"], 2);
    assert_eq!(again["handler"], "index.handler");
    assert_eq!(again["runtime"], "nodejs");
    assert_eq!(again["codeSize"], zip.len());
    assert_eq!(again["unpackedSize"], INDEX.len() + GREET.len());
}

#[test]
fn package_writes_where_asked_leaving_that_file_out_and_checks_a_handler_named() {
    let (_dir, root) = orders();

    let packaged =
        package(&root, &["--zip", root.join("dist.zip").to_str().unwrap(), "--handler", "lib/greet.handler"]);
    assert_eq!(packaged["handler"], "lib/greet.handler");
    assert_eq!(names(&std::fs::read(root.join("dist.zip")).unwrap()), ["index.js", "lib/greet.js"]);
    assert_eq!(
        package(&root, &["--zip", root.join("dist.zip").to_str().unwrap()])["codeSha256"],
        packaged["codeSha256"]
    );

    ff(&tempfile::TempDir::new().unwrap())
        .arg("package")
        .arg(&root)
        .args(["--handler", "src/app.handler"])
        .assert()
        .code(2)
        .stderr(predicate::str::ends_with("\nerror: The package has no src/app.js, .mjs, .cjs or .ts, nor a folder src/app/, which the handler src/app.handler names: name another with --handler\n"));
}

#[test]
fn package_refuses_what_it_cant_package_before_writing() {
    let settings = tempfile::TempDir::new().unwrap();
    let both = folder(&[("package.json", "{}"), ("requirements.txt", "requests\n")]);
    ff(&settings).arg("package").arg(both.path()).assert().code(2).stderr(predicate::str::ends_with(
        "has a package.json and Python's requirements: name the runtime with --runtime\n",
    ));

    let negated = folder(&[("app.py", ""), (".ffignore", "*.log\n!keep.log\n")]);
    ff(&settings).arg("package").arg(negated.path()).assert().code(2).stderr(predicate::str::ends_with(
        ".ffignore, line 2: ff doesn't read negated patterns (!): name what to leave out\n",
    ));

    ff(&settings)
        .args(["package", "--compile", "--no-build"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("cannot be used with"));
    assert!(!both.path().join(".ff").exists() && !negated.path().join(".ff").exists());
}

/// A folder of stand-ins for npm and python3 that log how and where they ran to
/// `$FF_TEST_LOG`, and make what npm and pip would; and the PATH that finds them first.
#[cfg(unix)]
fn tools() -> (tempfile::TempDir, String) {
    use std::os::unix::fs::PermissionsExt;
    let bin = tempfile::TempDir::new().unwrap();
    let npm = r#"#!/bin/sh
echo "npm $* in $(pwd)" >> "$FF_TEST_LOG"
case "$1" in
  ci|install)
    mkdir -p node_modules/greet node_modules/typescript
    printf 'module.exports = () => "hi";\n' > node_modules/greet/index.js
    printf 'tsc\n' > node_modules/typescript/index.js ;;
  prune) rm -rf node_modules/typescript ;;
esac
"#;
    let python = r#"#!/bin/sh
echo "python3 $* in $(pwd)" >> "$FF_TEST_LOG"
[ -f requirements.txt ] && sed 's/^/requirement: /' requirements.txt >> "$FF_TEST_LOG"
mkdir -p requests && : > requests/__init__.py
"#;
    for (name, script) in [("npm", npm), ("python3", python)] {
        std::fs::write(bin.path().join(name), script).unwrap();
        std::fs::set_permissions(bin.path().join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = format!("{}:{}", bin.path().display(), std::env::var("PATH").unwrap_or_default());
    (bin, path)
}

#[cfg(unix)]
#[test]
fn npm_installs_builds_and_prunes_in_a_copy_never_in_the_folder() {
    let (_dir, root) = orders();
    std::fs::write(root.join("package.json"), r#"{"scripts": {"build": "true"}, "dependencies": {"greet": "1.0.0"}}"#)
        .unwrap();
    std::fs::write(root.join("package-lock.json"), "{}").unwrap();
    std::fs::create_dir_all(root.join("node_modules/stale")).unwrap();
    std::fs::write(root.join("node_modules/stale/index.js"), "old\n").unwrap();
    let log = tempfile::NamedTempFile::new().unwrap();
    let (_bin, path) = tools();

    let output = ff(&tempfile::TempDir::new().unwrap())
        .arg("package")
        .arg(&root)
        .args(["--output", "json"])
        .env("PATH", &path)
        .env("FF_TEST_LOG", log.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

    let ran = std::fs::read_to_string(log.path()).unwrap();
    let steps: Vec<&str> = ran.lines().map(|line| line.split(" in ").next().unwrap()).collect();
    assert_eq!(steps, ["npm ci --no-audit --no-fund", "npm run build", "npm prune --omit=dev --no-audit --no-fund"]);
    let root = std::fs::canonicalize(&root).unwrap();
    assert!(
        ran.lines().all(|line| !line.ends_with(&format!(" in {}", root.display())) && line.contains("ff-package-")),
        "{ran}"
    );
    // The folder as it was: npm ran in the copy, which held the folder's node_modules no more.
    assert!(!root.join("node_modules/greet").exists());
    let zip = std::fs::read(root.join(".ff/orders.zip")).unwrap();
    assert_eq!(
        names(&zip),
        ["index.js", "lib/greet.js", "node_modules/greet/index.js", "package-lock.json", "package.json"]
    );
}

#[cfg(unix)]
#[test]
fn pip_installs_wheels_for_the_runtimes_platform_and_pyproject_names_them() {
    let project = folder(&[
        ("lambda_function.py", "def lambda_handler(event, context):\n    return 1\n"),
        ("pyproject.toml", "[project]\nname = \"orders\"\ndependencies = [\"requests>=2\"]\n"),
    ]);
    let log = tempfile::NamedTempFile::new().unwrap();
    let (_bin, path) = tools();

    let output = ff(&tempfile::TempDir::new().unwrap())
        .arg("package")
        .arg(project.path())
        .args(["--output", "json"])
        .env("PATH", &path)
        .env("FF_TEST_LOG", log.path())
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

    let ran = std::fs::read_to_string(log.path()).unwrap();
    assert!(ran.starts_with("python3 -m pip install --quiet --disable-pip-version-check --no-compile --target . --platform manylinux_2_28_x86_64 --implementation cp --python-version 3.13 --only-binary=:all: --upgrade -r requirements.txt in "), "{ran}");
    assert!(ran.ends_with("requirement: requests>=2\n"), "{ran}");
    let packaged: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(packaged["handler"], "lambda_function.lambda_handler");
    assert_eq!(packaged["runtime"], "python");
    // The requirements ff wrote for pip are no file of the folder's: the package hasn't them.
    let name = project.path().file_name().unwrap().to_str().unwrap();
    let zip = std::fs::read(project.path().join(format!(".ff/{name}.zip"))).unwrap();
    assert_eq!(names(&zip), ["lambda_function.py", "pyproject.toml", "requests/__init__.py"]);
}

#[test]
fn deploy_packages_a_folder_uploads_what_the_account_lacks_and_names_it() {
    let (_dir, root) = orders();
    let sha = package(&root, &["--zip", "/dev/null"])["codeSha256"].as_str().unwrap().to_owned();
    let api = Server::start(vec![
        Reply::json(200, json!([])),
        Reply::json(200, json!([])),
        Reply::json(
            201,
            json!({ "codeSha256": sha, "codeSize": 400, "unpackedSize": 130, "fileCount": 2, "createdAt": "2026-10-21T09:00:00.000Z" }),
        ),
        Reply::json(201, function(json!({ "codeSha256": sha }))),
    ]);

    ff(&with_key(&api.url))
        .arg("deploy")
        .arg(&root)
        .assert()
        .success()
        .stdout(predicate::str::is_match(r"^created orders \(nodejs, 128 MB, 5 s\): ACTIVE in \d+(\.\d)? s\npackage: 2 files, \d+ bytes, uploaded\n$").unwrap());

    let requests = api.requests();
    let calls = calls(&api);
    assert_eq!([&calls[0], &calls[2], &calls[3]], ["GET /functions?name=orders", "POST /packages", "POST /functions"]);
    assert_eq!(calls[1].strip_prefix("GET /packages?codeSha256=").map(unescape), Some(sha.clone()));
    assert_eq!(requests[2].header("content-type"), Some("application/zip"));
    assert_eq!(sha256(&requests[2].bytes), sha);
    assert_eq!(names(&requests[2].bytes), ["index.js", "lib/greet.js"]);
    assert_eq!(
        body(&requests[3]),
        json!({ "name": "orders", "runtime": "nodejs", "codeSha256": sha, "handler": "index.handler", "memory": 128, "timeout": 5 })
    );
}

#[test]
fn deploy_uploads_nothing_the_account_has_and_keeps_the_functions_handler() {
    let (_dir, root) = orders();
    let sha = package(&root, &["--zip", "/dev/null"])["codeSha256"].as_str().unwrap().to_owned();
    let api = Server::start(vec![
        Reply::json(200, json!([function(json!({ "handler": "lib/greet.handler" }))])),
        Reply::json(
            200,
            json!([{ "codeSha256": sha, "codeSize": 400, "unpackedSize": 130, "fileCount": 2, "createdAt": "2026-10-21T09:00:00.000Z" }]),
        ),
        Reply::json(200, function(json!({ "codeSha256": sha, "handler": "lib/greet.handler", "memory": 256 }))),
    ]);

    ff(&with_key(&api.url)).arg("deploy").arg(&root).args(["--memory", "256", "--output", "json"]).assert().success();

    let requests = api.requests();
    assert_eq!(calls(&api)[2], "PUT /functions/f1");
    assert_eq!(body(&requests[2]), json!({ "codeSha256": sha, "memory": 256 }));
}

#[test]
fn deploy_sends_nothing_when_the_package_and_settings_are_the_functions() {
    let (_dir, root) = orders();
    let sha = package(&root, &["--zip", "/dev/null"])["codeSha256"].as_str().unwrap().to_owned();
    let api = Server::start(vec![Reply::json(200, json!([function(json!({ "codeSha256": sha }))]))]);

    let output = ff(&with_key(&api.url)).arg("deploy").arg(&root).args(["--output", "json"]).output().unwrap();

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let deployed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        (deployed["action"].as_str(), deployed["package"]["uploaded"].as_bool()),
        (Some("unchanged"), Some(false))
    );
    assert_eq!(deployed["package"]["codeSha256"], sha);
    assert_eq!(calls(&api), ["GET /functions?name=orders"]);
}

#[test]
fn deploy_changing_settings_alone_asks_for_no_package() {
    let (_dir, root) = orders();
    let sha = package(&root, &["--zip", "/dev/null"])["codeSha256"].as_str().unwrap().to_owned();
    let api = Server::start(vec![
        Reply::json(200, json!([function(json!({ "codeSha256": sha }))])),
        Reply::json(200, function(json!({ "codeSha256": sha, "timeout": 30 }))),
    ]);

    ff(&with_key(&api.url)).arg("deploy").arg(&root).args(["--timeout", "30"]).assert().success().stdout(
        predicate::str::is_match(
            r"^updated orders \(nodejs, 128 MB, 30 s\): ACTIVE in \d+(\.\d)? s, changed: timeout\n$",
        )
        .unwrap(),
    );

    assert_eq!(calls(&api), ["GET /functions?name=orders", "PUT /functions/f1"]);
    assert_eq!(body(&api.requests()[1]), json!({ "timeout": 30 }));
}

#[test]
fn deploy_sends_the_package_again_when_the_purge_took_it_meanwhile() {
    let (_dir, root) = orders();
    let sha = package(&root, &["--zip", "/dev/null"])["codeSha256"].as_str().unwrap().to_owned();
    let gone = format!("The account has no package {sha}: upload it with POST /packages, which answers its SHA-256");
    let api = Server::start(vec![
        Reply::json(200, json!([function(json!({}))])),
        Reply::json(200, json!([{ "codeSha256": sha }])),
        Reply::json(400, json!({ "statusCode": 400, "message": [gone], "error": "Bad Request" })),
        Reply::json(201, json!({ "codeSha256": sha })),
        Reply::json(200, function(json!({ "codeSha256": sha }))),
    ]);

    ff(&with_key(&api.url)).arg("deploy").arg(&root).assert().success().stdout(
        predicate::str::contains(", changed: code\npackage: 2 files, ")
            .and(predicate::str::ends_with(" bytes, uploaded\n")),
    );

    assert_eq!(calls(&api)[2..], ["PUT /functions/f1", "POST /packages", "PUT /functions/f1"]);
}

#[test]
fn deploy_says_when_code_moves_between_a_file_and_a_package() {
    let (_dir, root) = orders();
    let inline = json!({ "packageType": "inline", "code": INDEX, "handler": "function.handler", "codeSha256": sha256(INDEX.as_bytes()) });
    let api = Server::start(vec![
        Reply::json(200, json!([function(inline.clone())])),
        Reply::json(200, json!([])),
        Reply::json(201, json!({ "codeSha256": "x" })),
    ]);

    // The API answers a hash other than the one ff made: the deploy stops there.
    ff(&with_key(&api.url))
        .arg("deploy")
        .arg(&root)
        .assert()
        .code(3)
        .stderr(predicate::str::contains(
            "warning: orders ran inline code: it becomes a package, which the console shows but doesn't edit",
        ))
        .stderr(predicate::str::contains("error: The API kept the package as x, where ff made "));

    let api = Server::start(vec![
        Reply::json(200, json!([function(json!({ "handler": "src/app.main" }))])),
        Reply::json(200, function(inline)),
    ]);
    ff(&with_key(&api.url))
        .arg("deploy")
        .arg(root.join("index.js"))
        .args(["--name", "orders"])
        .assert()
        .success()
        .stderr(predicate::str::contains(format!(
            "warning: orders ran a package: it becomes inline code, {} alone, its handler function.handler",
            root.join("index.js").display()
        )));
    assert_eq!(body(&api.requests()[1]), json!({ "code": INDEX, "handler": "function.handler" }));
}

#[test]
fn deploy_refuses_a_folder_without_a_handler_it_can_tell_and_what_isnt_for_a_file() {
    let project = folder(&[("src/app.js", "exports.main = async () => 1;\n")]);
    let api = Server::start(vec![Reply::json(200, json!([]))]);

    ff(&with_key(&api.url))
        .arg("deploy")
        .arg(project.path())
        .args(["--runtime", "nodejs", "--name", "app"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("it has no function.* file, nor index.js, .mjs, .cjs or .ts; name it with --handler, such as src/app.handler"));

    let settings = tempfile::TempDir::new().unwrap();
    let file = project.path().join("src/app.js");
    ff(&settings)
        .arg("deploy")
        .arg(&file)
        .arg("--container")
        .assert()
        .code(2)
        .stderr("error: --container and --no-build are for a folder, which ff packages: a file is deployed as it is\n");
    std::fs::write(project.path().join("app.zip"), "PK").unwrap();
    ff(&settings).arg("deploy").arg(project.path().join("app.zip")).assert().code(2).stderr(predicate::str::contains(
        "app.zip is a zip: ff deploy takes the function's folder, which it packages itself, or its code's one file",
    ));
}

//! `ff init --template terraform` against a scripted API: the project takes the endpoints and the
//! account `GET /me` gives; a name it can't take, or a folder with files, asks the API nothing.

mod common;

use common::{Reply, Server, ff, unreachable_url, with_key};
use predicates::prelude::*;
use serde_json::json;

fn me() -> serde_json::Value {
    json!({
        "user": null,
        "key": { "id": "0123456789ab", "name": "laptop", "scopes": ["functions:write"] },
        "accounts": [{ "id": "123456789012", "name": "Shop", "status": "active", "role": "owner",
                       "plan": { "id": "beta", "name": "Beta", "limits": {} },
                       "aws": { "region": "tn-tunis-1", "s3Endpoint": "https://s3.ff.example", "sqsEndpoint": "https://sqs.ff.example",
                                "sesEndpoint": "", "lambdaEndpoint": "https://lambda.ff.example" } }]
    })
}

#[test]
fn a_terraform_project_takes_ffs_endpoints_and_the_account_from_get_me() {
    let api = Server::start(vec![Reply::json(200, me())]);
    let dir = with_key(&api.url);
    let work = tempfile::TempDir::new().unwrap();

    ff(&dir)
        .current_dir(work.path())
        .args(["init", "shop", "--template", "terraform", "--runtime", "nodejs"])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("created shop/, a Terraform project: FF's provider block in providers.tf"));

    let providers = std::fs::read_to_string(work.path().join("shop/providers.tf")).unwrap();
    assert!(providers.contains("    lambda = \"https://lambda.ff.example\"\n    s3     = \"https://s3.ff.example\"\n    sqs    = \"https://sqs.ff.example\"\n  }"));
    assert!(providers.contains("arn:aws:iam::123456789012:role/shop"));
    assert!(
        work.path().join("shop/modules/site/main.tf").is_file() && work.path().join("shop/src/worker.mjs").is_file()
    );
    let requests = api.requests();
    assert_eq!(
        requests.iter().map(|request| format!("{} {}", request.method, request.path)).collect::<Vec<_>>(),
        ["GET /me"]
    );
}

#[test]
fn as_json_it_gives_the_command_of_the_key_the_project_takes() {
    let api = Server::start(vec![Reply::json(200, me())]);
    let dir = with_key(&api.url);
    let work = tempfile::TempDir::new().unwrap();

    let output = ff(&dir)
        .current_dir(work.path())
        .args(["init", "shop", "--template", "terraform", "--runtime", "python", "--output", "json"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let created: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(created["template"], "terraform");
    assert!(
        created["keyCommand"]
            .as_str()
            .unwrap()
            .starts_with("ff keys create --name shop-terraform --function shop-api ")
    );
}

#[test]
fn a_name_its_buckets_cant_take_or_a_folder_with_files_asks_the_api_nothing() {
    let api = Server::start(vec![]);
    let dir = with_key(&api.url);
    let work = tempfile::TempDir::new().unwrap();
    std::fs::create_dir(work.path().join("taken")).unwrap();
    std::fs::write(work.path().join("taken/main.tf"), "").unwrap();

    ff(&dir)
        .current_dir(work.path())
        .args(["init", "Shop", "--template", "terraform", "--runtime", "python"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("\"Shop\" can't name a Terraform project for FF"));
    ff(&dir)
        .current_dir(work.path())
        .args(["init", "taken", "--template", "terraform", "--runtime", "python"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("already holds files"));
    assert!(api.requests().is_empty());
}

#[test]
fn without_an_api_it_writes_no_folder() {
    let dir = with_key(&unreachable_url());
    let work = tempfile::TempDir::new().unwrap();

    ff(&dir)
        .current_dir(work.path())
        .args(["init", "shop", "--template", "terraform", "--runtime", "nodejs"])
        .assert()
        .failure();

    assert!(!work.path().join("shop").exists());
}

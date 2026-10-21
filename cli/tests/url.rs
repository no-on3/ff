//! `ff url`, `ff domains` and `ff invoke --http` against a scripted API, which plays the
//! function's URL too.

mod common;

use common::{KEY, Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

fn listed() -> Value {
    json!([{ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
             "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" }])
}

fn url(address: &str, auth: &str) -> Value {
    json!({ "functionUrl": address, "functionId": "f1", "authType": auth, "cors": null, "invokeMode": "BUFFERED",
            "createdAt": "2026-10-21T09:10:00.000Z", "updatedAt": "2026-10-21T09:10:00.000Z" })
}

fn domain(status: &str) -> Value {
    json!({ "domain": "shop.example.tn", "functionId": "f1", "status": status,
            "records": { "cname": [{ "type": "CNAME", "name": "shop.example.tn", "value": "abc.fn.ff.tn" }],
                         "txt": [{ "type": "TXT", "name": "_ff-verify.shop.example.tn", "value": "ff-verify=t0k3n" }] },
            "checkedAt": null, "checkError": null, "verifiedAt": null, "createdAt": "2026-10-21T09:20:00.000Z" })
}

fn not_found() -> Reply {
    Reply::json(404, json!({ "statusCode": 404, "message": "Function f1 has no URL" }))
}

fn body(request: &common::Request) -> Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn enable_makes_a_url_who_may_call_it_said_and_needed() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        not_found(),
        Reply::json(201, url("https://abc.fn.ff.tn/", "AWS_IAM")),
        Reply::json(200, listed()),
        not_found(),
    ]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args([
            "url",
            "enable",
            "hello",
            "--auth",
            "key",
            "--cors-origin",
            "https://shop.example.tn",
            "--cors-method",
            "post",
        ])
        .assert()
        .success()
        .stdout(
            "hello has a URL: https://abc.fn.ff.tn/\ncallers need an API key of the account with functions:invoke\n",
        );
    assert_eq!(
        body(&api.requests()[2]),
        json!({ "authType": "AWS_IAM", "cors": { "allowOrigins": ["https://shop.example.tn"], "allowMethods": ["POST"] } })
    );
    ff(&dir)
        .args(["url", "enable", "hello"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("Say who may call the new address"));
}

#[test]
fn enable_on_a_url_changes_what_is_given_and_disable_deletes_it() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, url("https://abc.fn.ff.tn/", "AWS_IAM")),
        Reply::json(200, url("https://abc.fn.ff.tn/", "NONE")),
        Reply::json(200, listed()),
        Reply::json(200, url("https://abc.fn.ff.tn/", "NONE")),
        Reply::json(200, json!(null)),
    ]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["url", "enable", "hello", "--auth", "none"])
        .assert()
        .success()
        .stdout(predicate::str::contains("has its URL changed").and(predicate::str::contains("anyone may call it")));
    assert_eq!((api.requests()[2].method.as_str(), body(&api.requests()[2])), ("PUT", json!({ "authType": "NONE" })));
    ff(&dir)
        .args(["url", "disable", "hello", "--yes"])
        .assert()
        .success()
        .stdout("hello's URL deleted: https://abc.fn.ff.tn/ answers 404\n");
    assert_eq!(format!("{} {}", api.requests()[5].method, api.requests()[5].path), "DELETE /functions/f1/url");
}

#[test]
fn show_says_the_address_its_callers_and_domains_or_that_there_is_none() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(200, url("https://abc.fn.ff.tn/", "NONE")),
        Reply::json(200, json!([domain("verified")])),
        Reply::json(200, listed()),
        not_found(),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["url", "show", "hello"]).assert().success().stdout(
        "https://abc.fn.ff.tn/\nanyone may call it; made 2026-10-21 09:10:00 UTC\ndomain shop.example.tn: verified\n",
    );
    ff(&dir)
        .args(["url", "show", "hello"])
        .assert()
        .code(3)
        .stderr("error: hello has no URL: `ff url enable hello --auth none|key` gives it one\n");
}

#[test]
fn domains_add_says_the_records_to_make_then_verify_and_remove() {
    let api = Server::start(vec![
        Reply::json(200, listed()),
        Reply::json(201, domain("pending")),
        Reply::json(200, listed()),
        Reply::json(200, domain("verified")),
        Reply::json(200, listed()),
        Reply::json(200, json!(null)),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["domains", "add", "hello", "shop.example.tn"]).assert().success().stdout(
        "shop.example.tn: pending\nmake, for a subdomain:\n  CNAME shop.example.tn abc.fn.ff.tn\nor, for any domain, an apex too:\n  \
         TXT _ff-verify.shop.example.tn ff-verify=t0k3n\nthen: ff domains verify hello shop.example.tn\n",
    );
    assert_eq!(body(&api.requests()[1]), json!({ "domain": "shop.example.tn" }));
    ff(&dir)
        .args(["domains", "verify", "hello", "shop.example.tn"])
        .assert()
        .success()
        .stdout("shop.example.tn: verified\n");
    assert_eq!(api.requests()[3].path, "/functions/f1/url/domains/shop.example.tn/verify");
    ff(&dir).args(["domains", "remove", "hello", "shop.example.tn", "--yes"]).assert().success();
    assert_eq!(
        format!("{} {}", api.requests()[5].method, api.requests()[5].path),
        "DELETE /functions/f1/url/domains/shop.example.tn"
    );
}

#[test]
fn invoke_http_calls_the_url_with_the_key_when_it_takes_one_and_prints_the_answer() {
    // The scripted API plays the function's URL too, under a host of localhost's, which ff reaches on 127.0.0.1.
    let bound = Server::bind();
    let address = format!("http://abc.fn.localhost:{}/", bound.port());
    let api = bound.serve(vec![
        Reply::json(200, listed()),
        Reply::json(200, url(&address, "AWS_IAM")),
        Reply::text(201, "text/plain", "created order 7"),
    ]);

    ff(&with_key(&api.url))
        .args([
            "invoke",
            "hello",
            "--http",
            "POST",
            "/orders?rush=1",
            "-H",
            "Content-Type: application/json",
            "--data",
            "{\"item\": 7}",
        ])
        .assert()
        .success()
        .stdout("HTTP 201\n\ncreated order 7\n");
    let call = &api.requests()[2];
    assert_eq!(
        (call.method.as_str(), call.path.as_str(), call.body.as_str()),
        ("POST", "/orders?rush=1", "{\"item\": 7}")
    );
    assert_eq!(
        call.header("host"),
        Some(format!("abc.fn.localhost:{}", address.trim_end_matches('/').rsplit(':').next().unwrap()).as_str())
    );
    assert_eq!(call.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
    assert_eq!(call.header("content-type"), Some("application/json"));
}

#[test]
fn invoke_http_sends_no_key_to_a_url_anyone_may_call() {
    let bound = Server::bind();
    let address = format!("http://127.0.0.1:{}/", bound.port());
    let api = bound.serve(vec![
        Reply::json(200, listed()),
        Reply::json(200, url(&address, "NONE")),
        Reply::text(404, "text/plain", "no such order"),
    ]);

    ff(&with_key(&api.url))
        .args(["invoke", "hello", "--http", "GET", "/orders/9"])
        .assert()
        .success()
        .stdout("HTTP 404\n\nno such order\n");
    assert_eq!(api.requests()[2].header("authorization"), None);
}

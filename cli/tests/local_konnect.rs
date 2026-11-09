//! `ff local konnect` as a shop's developer runs it: a payment made through its API, its page paid, the shop's
//! webhook called with the payment's reference, the browser sent there, and the payment then completed.

mod common;

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};

use common::{Reply, Server};
use serde_json::{Value, json};
use tempfile::TempDir;

/// The stand-in, stopped when the test ends, whether it passes or not.
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `ff local konnect --port 0 --output json` started, and the document it printed once listening.
fn started(settings: &TempDir) -> (Running, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ff"))
        .args(["local", "konnect", "--port", "0", "--output", "json"])
        .env("FF_CONFIG_DIR", settings.path())
        .env("FF_NO_UPDATE_CHECK", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut document = String::new();
    while serde_json::from_str::<Value>(&document).is_err() {
        assert!(stdout.read_line(&mut document).unwrap() > 0, "it stopped before saying where it listens: {document}");
    }
    (Running(child), serde_json::from_str(&document).unwrap())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).max_redirects(0).build().into()
}

fn body(response: ureq::http::Response<ureq::Body>) -> String {
    response.into_body().read_to_string().unwrap()
}

#[test]
fn a_payment_made_paid_at_its_page_notifies_the_shop_and_is_then_completed() {
    let settings = TempDir::new().unwrap();
    let shop = Server::bind();
    let webhook = format!("http://shop.fn.localhost:{}/webhooks/konnect", shop.port());
    let shop = shop.serve(vec![Reply::text(200, "text/plain", "noted")]);
    let (mut running, document) = started(&settings);
    let api = document["apiUrl"].as_str().unwrap().to_owned();
    assert!(api.starts_with("http://127.0.0.1:") && api.ends_with("/api/v2"), "{document}");
    assert_eq!(
        [&document["apiKey"], &document["walletId"]],
        [&json!("ff-local-konnect"), &json!("ff0000000000000000000001")]
    );
    let agent = agent();

    let order = json!({ "receiverWalletId": "ff0000000000000000000001", "amount": 12500, "token": "TND", "orderId": "o-1",
                        "description": "2 jars of harissa", "webhook": webhook });
    let made = agent
        .post(format!("{api}/payments/init-payment"))
        .header("x-api-key", "ff-local-konnect")
        .content_type("application/json")
        .send(order.to_string())
        .unwrap();
    assert_eq!(made.status(), 200);
    let made: Value = serde_json::from_str(&body(made)).unwrap();
    let (reference, pay_url) = (made["paymentRef"].as_str().unwrap(), made["payUrl"].as_str().unwrap());
    let refused = agent
        .post(format!("{api}/payments/init-payment"))
        .content_type("application/json")
        .send(order.to_string())
        .unwrap();
    assert_eq!(refused.status(), 401, "without the key");

    let page = agent.get(pay_url).call().unwrap();
    assert_eq!(page.status(), 200);
    let page = body(page);
    assert!(page.contains("12.500 TND") && page.contains("<button>Pay</button>"), "{page}");

    let paid = agent.get(format!("{pay_url}&outcome=paid")).call().unwrap();
    let notification = format!("{webhook}?payment_ref={reference}");
    assert_eq!(paid.status(), 303);
    assert_eq!(paid.headers()["location"], notification.as_str(), "the browser is sent to the webhook's address");
    let received = shop.requests();
    assert_eq!(received.len(), 1, "the stand-in called the webhook itself");
    assert_eq!(
        (received[0].method.as_str(), received[0].path.as_str()),
        ("GET", format!("/webhooks/konnect?payment_ref={reference}").as_str())
    );

    let asked =
        agent.get(format!("{api}/payments/{reference}")).header("x-api-key", "ff-local-konnect").call().unwrap();
    assert_eq!(asked.status(), 200);
    let source = asked.headers()["x-ff-konnect-source"].to_str().unwrap().to_owned();
    assert_eq!(source, "https://docs.konnect.network/docs/en/api-integration/endpoints/get-payment-details#response");
    let payment: Value = serde_json::from_str(&body(asked)).unwrap();
    assert_eq!([&payment["payment"]["status"], &payment["payment"]["orderId"]], [&json!("completed"), &json!("o-1")]);

    let _ = running.0.kill();
    let mut said = String::new();
    running.0.stderr.take().unwrap().read_to_string(&mut said).unwrap();
    assert!(said.contains(&format!("{reference}: 12.500 TND for order o-1, made")), "{said}");
    assert!(said.contains(&format!("{reference}: paid at its page; its webhook answered 200")), "{said}");
}

#[test]
fn a_port_another_program_has_is_said_and_a_key_with_a_space_refused() {
    let settings = TempDir::new().unwrap();
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port().to_string();
    let run = |arguments: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ff"))
            .args(["local", "konnect"])
            .args(arguments)
            .env("FF_CONFIG_DIR", settings.path())
            .env("FF_NO_UPDATE_CHECK", "1")
            .output()
            .unwrap()
    };

    let busy = run(&["--port", &port]);
    assert_eq!(busy.status.code(), Some(3));
    let said = String::from_utf8_lossy(&busy.stderr);
    assert!(said.contains(&format!("Couldn't listen on 127.0.0.1:{port}")) && said.contains("--port"), "{said}");

    let spaced = run(&["--port", "0", "--key", "a key"]);
    assert_eq!(spaced.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&spaced.stderr).contains("--key must be a word, without spaces"));
}

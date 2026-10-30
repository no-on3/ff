//! `ff email` against a scripted API: a domain's records to publish, a name that is neither a
//! domain nor an address refused before any call, an address in a path, a message sent and what
//! became of each recipient, every page of the suppression list, and a deletion asked first.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

const MESSAGE_ID: &str = "6f1c2a52-8f0e-4b8e-9d1e-3c2b1a0f9e8d";

fn domain(status: &str) -> Value {
    json!({ "identity": "shop.example.tn", "type": "DOMAIN", "status": status, "sendingEnabled": true,
            "dkimSelector": "ff1a2b", "mailFromDomain": "bounces.mail.shop.example.tn", "mailFromVerified": false,
            "records": [
                { "purpose": "DKIM", "type": "TXT", "name": "ff1a2b._domainkey.shop.example.tn", "value": "v=DKIM1; k=rsa; p=MIIB" },
                { "purpose": "MAIL_FROM", "type": "MX", "name": "bounces.mail.shop.example.tn", "value": "10 mail.ff.test" },
                { "purpose": "SPF", "type": "TXT", "name": "bounces.mail.shop.example.tn", "value": "v=spf1 a:mail.ff.test -all" },
                { "purpose": "DMARC", "type": "TXT", "name": "_dmarc.shop.example.tn", "value": "v=DMARC1; p=none;" }
            ],
            "verifiedAt": null, "createdAt": "2026-10-30T08:00:00.000Z" })
}

fn address() -> Value {
    json!({ "identity": "orders@shop.example.tn", "type": "EMAIL_ADDRESS", "status": "PENDING", "sendingEnabled": true,
            "dkimSelector": null, "mailFromDomain": null, "mailFromVerified": false, "records": [],
            "verifiedAt": null, "createdAt": "2026-10-30T08:01:00.000Z" })
}

fn said(request: &common::Request) -> String {
    format!("{} {}", request.method, request.path)
}

#[test]
fn add_a_domain_prints_the_records_to_publish_at_its_dns() {
    let api = Server::start(vec![Reply::json(201, domain("PENDING"))]);

    ff(&with_key(&api.url)).args(["email", "add", "Shop.Example.TN"]).assert().success().stdout(concat!(
        "shop.example.tn added: publish these records at its DNS. FF looks for them every minute, for 72 hours; `ff email verify shop.example.tn` looks now.\n",
        "FOR              TYPE  NAME                               VALUE\n",
        "DKIM             TXT   ff1a2b._domainkey.shop.example.tn  v=DKIM1; k=rsa; p=MIIB\n",
        "MAIL FROM        MX    bounces.mail.shop.example.tn       10 mail.ff.test\n",
        "SPF              TXT   bounces.mail.shop.example.tn       v=spf1 a:mail.ff.test -all\n",
        "DMARC (advised)  TXT   _dmarc.shop.example.tn             v=DMARC1; p=none;\n",
    ));
    let requests = api.requests();
    assert_eq!(said(&requests[0]), "POST /email/identities");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), json!({ "identity": "shop.example.tn" }));
}

#[test]
fn a_name_neither_a_domain_nor_an_address_is_refused_before_any_call() {
    let api = Server::start(vec![]);
    let dir = with_key(&api.url);

    ff(&dir).args(["email", "add", "localhost"]).assert().code(2).stderr(predicate::str::contains(
        "\"localhost\" is neither a domain, such as shop.example.tn, nor an address, such as orders@shop.example.tn: A domain has two labels at least, such as example.tn",
    ));
    ff(&dir)
        .args(["email", "get", "orders@192.0.2.1"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("The address's domain: An IP address is no domain"));
    ff(&dir).args(["email", "suppress", "shop.example.tn"]).assert().code(2).stderr(predicate::str::contains(
        "\"shop.example.tn\" is not an address: An address is a local part, @ and a domain",
    ));
    assert!(api.requests().is_empty());
}

#[test]
fn an_address_goes_in_the_path_and_verify_emails_its_link_again() {
    let api = Server::start(vec![Reply::json(200, address()), Reply::json(200, address())]);
    let dir = with_key(&api.url);

    ff(&dir).args(["email", "get", "Orders@shop.example.tn"]).assert().success().stdout(concat!(
        "orders@shop.example.tn\n",
        "type        address\n",
        "status      waiting: FF e-mailed it a link, whose following proves it\n",
        "sending     on\n",
        "proved      -\n",
        "created     2026-10-30 08:01:00 UTC\n",
    ));
    ff(&dir)
        .args(["email", "verify", "orders@shop.example.tn"])
        .assert()
        .success()
        .stdout("orders@shop.example.tn: its link e-mailed again; the last one is no longer good\n");
    let requests = api.requests();
    assert_eq!(said(&requests[0]), "GET /email/identities/orders%40shop.example.tn");
    assert_eq!(said(&requests[1]), "POST /email/identities/orders%40shop.example.tn/verify");
}

#[test]
fn identities_list_each_ones_proof_and_a_proved_domain_says_so() {
    let mut proved = domain("SUCCESS");
    proved["mailFromVerified"] = json!(true);
    proved["verifiedAt"] = json!("2026-10-30T08:03:00.000Z");
    let api = Server::start(vec![Reply::json(200, json!([proved.clone(), address()])), Reply::json(200, proved)]);
    let dir = with_key(&api.url);

    ff(&dir).args(["email", "identities"]).assert().success().stdout(concat!(
        "IDENTITY                TYPE     STATUS   SENDING  CREATED (UTC)\n",
        "shop.example.tn         domain   proved   on       2026-10-30 08:00:00\n",
        "orders@shop.example.tn  address  waiting  on       2026-10-30 08:01:00\n",
    ));
    ff(&dir)
        .args(["email", "verify", "shop.example.tn"])
        .assert()
        .success()
        .stdout("shop.example.tn: proved: mail goes from it\n");
    assert_eq!(said(&api.requests()[1]), "POST /email/identities/shop.example.tn/verify");
}

#[test]
fn send_queues_a_message_and_names_it() {
    let api = Server::start(vec![Reply::json(201, json!({ "messageId": MESSAGE_ID }))]);

    ff(&with_key(&api.url))
        .args([
            "email",
            "send",
            "--from",
            "Shop <orders@shop.example.tn>",
            "--to",
            "ana@example.tn",
            "--to",
            "sami@example.tn",
        ])
        .args(["--bcc", "audit@shop.example.tn", "--subject", "Your receipt", "--text", "Thank you."])
        .assert()
        .success()
        .stdout(format!("queued as {MESSAGE_ID}: `ff email messages` shows what became of each recipient\n"));
    let requests = api.requests();
    assert_eq!(said(&requests[0]), "POST /email/messages");
    assert_eq!(
        serde_json::from_str::<Value>(&requests[0].body).unwrap(),
        json!({ "from": "Shop <orders@shop.example.tn>", "to": ["ana@example.tn", "sami@example.tn"],
                "bcc": ["audit@shop.example.tn"], "subject": "Your receipt", "text": "Thank you." })
    );
}

#[test]
fn send_wants_a_body_and_says_the_apis_refusal() {
    let api = Server::start(vec![Reply::json(
        400,
        json!({ "statusCode": 400, "message": "Email address is not verified. The following identities failed the check in region TN-TUNIS-1: ana@example.tn" }),
    )]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["email", "send", "--from", "orders@shop.example.tn", "--to", "ana@example.tn", "--subject", "Hello"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--text"));
    ff(&dir)
        .args(["email", "send", "--from", "orders@shop.example.tn", "--to", "ana@example.tn", "--subject", "Hello"])
        .args(["--html", "<p>Hello</p>"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("Email address is not verified."));
    let requests = api.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap()["html"], json!("<p>Hello</p>"));
}

#[test]
fn messages_show_what_became_of_each_recipient_with_the_servers_words() {
    let api = Server::start(vec![Reply::json(
        200,
        json!({ "messages": [{ "messageId": MESSAGE_ID, "from": "orders@shop.example.tn", "identity": "shop.example.tn", "status": "SENT",
                               "recipients": [{ "address": "ana@example.tn", "status": "SENT", "diagnostic": "250 2.0.0 Ok: queued" },
                                              { "address": "gone@example.tn", "status": "BOUNCED", "diagnostic": "550 5.1.1 no such user" }],
                               "sizeBytes": 2_150, "createdAt": "2026-10-30T08:05:00.000Z", "sentAt": "2026-10-30T08:05:01.000Z" }] }),
    )]);
    let dir = with_key(&api.url);

    ff(&dir).args(["email", "messages", "--limit", "5"]).assert().success().stdout(concat!(
        "CREATED (UTC)        MESSAGE ID                            FROM                    SIZE    RECIPIENTS\n",
        "2026-10-30 08:05:00  6f1c2a52-8f0e-4b8e-9d1e-3c2b1a0f9e8d  orders@shop.example.tn  2.1 KB  ana@example.tn sent, gone@example.tn bounced (550 5.1.1 no such user)\n",
    ));
    assert_eq!(said(&api.requests()[0]), "GET /email/messages?limit=5");
    ff(&dir).args(["email", "messages", "--limit", "101"]).assert().code(2);
}

#[test]
fn suppressions_read_every_page_and_an_address_goes_on_and_off_the_list() {
    let api = Server::start(vec![
        Reply::json(
            200,
            json!({ "suppressions": [{ "address": "gone@example.tn", "reason": "BOUNCE", "messageId": MESSAGE_ID, "feedback": null,
                                       "updatedAt": "2026-10-30T08:06:00.000Z" }], "next": "page-2" }),
        ),
        Reply::json(
            200,
            json!({ "suppressions": [{ "address": "angry@example.tn", "reason": "COMPLAINT", "messageId": null, "feedback": "abuse",
                                       "updatedAt": "2026-10-30T08:07:00.000Z" }], "next": null }),
        ),
        Reply::json(
            200,
            json!({ "address": "spam-trap@example.tn", "reason": "COMPLAINT", "messageId": null, "feedback": null,
                    "updatedAt": "2026-10-30T08:08:00.000Z" }),
        ),
        Reply::json(204, json!(null)),
    ]);
    let dir = with_key(&api.url);

    ff(&dir).args(["email", "suppressions"]).assert().success().stdout(concat!(
        "ADDRESS           REASON     FROM MESSAGE                          PUT THERE (UTC)\n",
        "gone@example.tn   bounce     6f1c2a52-8f0e-4b8e-9d1e-3c2b1a0f9e8d  2026-10-30 08:06:00\n",
        "angry@example.tn  complaint  -                                     2026-10-30 08:07:00\n",
    ));
    ff(&dir)
        .args(["email", "suppress", "Spam-Trap@example.tn", "--reason", "COMPLAINT"])
        .assert()
        .success()
        .stdout("spam-trap@example.tn is on the suppression list (complaint): no mail of the account goes to it\n");
    ff(&dir)
        .args(["email", "unsuppress", "gone@example.tn"])
        .assert()
        .success()
        .stdout("gone@example.tn is off the suppression list: the account's mail goes to it again\n");
    let requests = api.requests();
    assert_eq!(
        requests.iter().map(said).collect::<Vec<_>>(),
        [
            "GET /email/suppressions?limit=1000",
            "GET /email/suppressions?limit=1000&next=page-2",
            "PUT /email/suppressions/spam-trap%40example.tn",
            "DELETE /email/suppressions/gone%40example.tn",
        ]
    );
    assert_eq!(serde_json::from_str::<Value>(&requests[2].body).unwrap(), json!({ "reason": "COMPLAINT" }));
    ff(&dir).args(["email", "suppress", "gone@example.tn", "--reason", "SPAM"]).assert().code(2);
}

#[test]
fn account_says_the_sandbox_and_the_quotas_and_json_keeps_ses_names() {
    let state = json!({ "sandbox": true, "sendingEnabled": true, "enforcementStatus": "HEALTHY",
                        "max24HourSend": 200, "maxSendRate": 1, "sentLast24Hours": 12 });
    let api = Server::start(vec![Reply::json(200, state.clone()), Reply::json(200, state.clone())]);
    let dir = with_key(&api.url);

    ff(&dir).args(["email", "account"]).assert().success().stdout(concat!(
        "sandbox  yes\n",
        "sending  on\n",
        "standing healthy\n",
        "sent     12 of 200 messages in the last 24 hours, 1 a second at most\n",
        "\n",
        "In the sandbox, as every new account is: mail goes only to the addresses and domains it proved. FF's operator lets it out once it says what it sends.\n",
    ));
    let output = ff(&dir).args(["--output", "json", "email", "account"]).output().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), state);
}

#[test]
fn delete_asks_first_naming_itself_and_a_script_must_say_yes() {
    let api = Server::start(vec![]);
    ff(&with_key(&api.url))
        .args(["email", "delete", "shop.example.tn"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("ff email delete asks first, and there is no terminal to ask in: say --yes"));

    let api = Server::start(vec![Reply::json(204, json!(null))]);
    ff(&with_key(&api.url))
        .args(["email", "delete", "shop.example.tn", "--yes"])
        .assert()
        .success()
        .stdout("deleted shop.example.tn: no mail goes from it\n");
    assert_eq!(said(&api.requests()[0]), "DELETE /email/identities/shop.example.tn");
}

//! The account's commands against a scripted API: who and where, what was used, what is owed,
//! how the functions ran.

mod common;

use common::{Reply, Server, ff, with_key};
use predicates::prelude::*;
use serde_json::{Value, json};

fn me(egress: bool) -> Value {
    json!({ "user": null, "key": { "id": "0123456789ab", "name": "ci", "scopes": ["usage:read"] },
            "accounts": [{ "id": "123456789012", "name": "Acme", "status": "active", "role": "developer",
                           "plan": { "id": "beta", "name": "Beta", "limits": { "functions": 25, "memoryMb": 1024, "invokesPerSecond": 100,
                                                                             "databases": 1, "databaseStorageMb": 1024, "databaseConnections": 10,
                                                                             "buckets": 5, "bucketStorageMb": 5120, "storageRequestsPerSecond": 100, "maxObjectMb": 5120,
                                                                             "siteTransferGbPerMonth": 10, "queues": 10, "eventSourceMappingsPerFunction": 5, "queueRequestsPerSecond": 100,
                                                                             "queueStorageMb": 100, "caches": 1, "cacheMb": 64 } },
                           "internetEgress": egress, "dataDeletionDueAt": null, "dataDeletedAt": null }] })
}

#[test]
fn accounts_lists_them_with_the_current_one_marked() {
    let api = Server::start(vec![Reply::json(200, me(false))]);

    ff(&with_key(&api.url))
        .arg("accounts")
        .assert()
        .success()
        .stdout("   ID            NAME  STATUS  ROLE       PLAN\n*  123456789012  Acme  active  developer  Beta\n");
}

#[test]
fn account_says_its_plan_and_whether_its_functions_reach_the_internet() {
    let api = Server::start(vec![Reply::json(200, me(false)), Reply::json(200, me(true))]);
    let dir = with_key(&api.url);

    ff(&dir).arg("account").assert().success().stdout(
        "account      123456789012 \"Acme\"\nstatus       active\nrole         developer\n\
         plan         Beta: 25 functions, 1024 MB of memory a function at most, 100 invocations a second, 1 database, 1024 MB a database, \
         10 sessions a database, 5 buckets, 5120 MB in the buckets, 100 requests to the buckets a second, 5120 MB a file in one upload, \
         10 GB a month from the sites, 10 queues, 5 queues read by a function, 100 requests to the queues a second, 100 MB of messages waiting, \
         1 cache, 64 MB a cache\n\
         internet     off: its functions reach FF's services only, and a call out fails; FF's operator turns it on\n",
    );
    ff(&dir)
        .arg("account")
        .assert()
        .success()
        .stdout(predicate::str::contains("internet     its functions may reach the internet"));
}

fn usage() -> Value {
    let amounts = |requests: u64| json!({ "requests": requests, "billedMs": 25_150, "gbSeconds": "3.14375", "throttled": 1, "platformErrors": 0, "lost": 0 });
    let mut hello = amounts(12);
    hello.as_object_mut().unwrap().extend(
        json!({ "functionId": "f1", "functionName": "hello", "deleted": false, "cost": "0.752" })
            .as_object()
            .unwrap()
            .clone(),
    );
    let mut old = amounts(3);
    old.as_object_mut().unwrap().extend(
        json!({ "functionId": "f2", "functionName": "old", "deleted": true, "cost": "0.100" })
            .as_object()
            .unwrap()
            .clone(),
    );
    json!({ "month": "2026-10", "functions": [hello, old], "totals": amounts(15),
            "estimate": { "currency": "TND", "usage": "0.852", "freeTier": "-0.852", "volumeTiers": "0.000", "monthlyFee": "0.000", "total": "0.000", "pricedFrom": "2026-10-01T00:00:00.000Z", "priceBooks": ["pb1"] } })
}

#[test]
fn usage_shows_each_function_the_total_and_the_estimate() {
    let api = Server::start(vec![Reply::json(200, usage())]);

    ff(&with_key(&api.url)).args(["usage", "--month", "2026-10"]).assert().success().stdout(
        "2026-10\nFUNCTION       REQUESTS  GB-SECONDS  NOT BILLED  COST\nhello          12        3.14375     1           0.752\n\
         old (deleted)  3         3.14375     1           0.100\ntotal          15        3.14375     1           0.852\n\
         estimated cost: 0.000 TND (0.852 TND of usage, -0.852 of free tier)\n",
    );
    assert_eq!(api.requests()[0].path, "/usage?month=2026-10");
}

#[test]
fn usage_shows_each_database_after_the_functions() {
    let mut month = usage();
    month["databases"] = json!([{ "databaseId": "d1", "name": "orders", "deleted": false, "hours": 312, "gbMonths": "0.003182", "sizeBytes": 7_634_423, "cost": "0.001" },
                                { "databaseId": "d2", "name": "audit", "deleted": true, "hours": 2, "gbMonths": "0.000021", "sizeBytes": 8_000_000, "cost": "0.000" }]);
    let api = Server::start(vec![Reply::json(200, month)]);

    let output = ff(&with_key(&api.url)).args(["usage", "--month", "2026-10"]).output().unwrap();

    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("total          15        3.14375     1           0.852\nDATABASE         HOURS  GB-MONTHS  COST\norders           312    0.003182   0.001\naudit (deleted)  2      0.000021   0.000\nestimated cost:"),
        "{text}"
    );
}

#[test]
fn usage_shows_each_bucket_after_the_databases_its_requests_by_s3s_classes_and_what_it_sent_out() {
    let mut month = usage();
    month["buckets"] = json!([
        { "bucketId": "b1", "name": "photos", "deleted": false, "hours": 312, "gbMonths": "0.215231", "sizeBytes": 161_480_253, "objects": 1204,
          "tier1Requests": 2310, "tier2Requests": 48920, "bytesDownloaded": 2_831_155_200u64, "bytesUploaded": 734_003_200, "cost": "0.108" },
        // As an API before what buckets sent out was shown answers: nothing sent out.
        { "bucketId": "b2", "name": "tmp", "deleted": true, "hours": 0, "gbMonths": "0", "sizeBytes": 0, "objects": 0, "tier1Requests": 0, "tier2Requests": 5, "cost": "0.000" }
    ]);
    let api = Server::start(vec![Reply::json(200, month)]);

    let output = ff(&with_key(&api.url)).args(["usage", "--month", "2026-10"]).output().unwrap();

    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains(
            "total          15        3.14375     1           0.852\nBUCKET         GB-MONTHS  PUT, LIST…  GET…   SENT OUT  COST\n\
             photos         0.215231   2310        48920  2.6 GB    0.108\ntmp (deleted)  0          0           5      0 MB      0.000\nestimated cost:"
        ),
        "{text}"
    );
}

#[test]
fn usage_shows_each_queue_after_the_buckets_its_requests_as_sqs_bills_them_and_its_messages() {
    let mut month = usage();
    month["queues"] = json!([
        { "queueId": "q1", "name": "orders", "deleted": false, "requests": 18_420, "messagesSent": 6_140, "messagesReceived": 6_152, "cost": "0.022" },
        { "queueId": "q2", "name": "old", "deleted": true, "requests": 3, "messagesSent": 1, "messagesReceived": 0, "cost": "0.000" }
    ]);
    let api = Server::start(vec![Reply::json(200, month)]);

    let output = ff(&with_key(&api.url)).args(["usage", "--month", "2026-10"]).output().unwrap();

    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains(
            "total          15        3.14375     1           0.852\nQUEUE          REQUESTS  SENT  RECEIVED  COST\n\
             orders         18420     6140  6152      0.022\nold (deleted)  3         1     0         0.000\nestimated cost:"
        ),
        "{text}"
    );
}

#[test]
fn usage_shows_each_cache_after_the_queues_its_memory_by_the_hour_as_elasticache_bills_a_node() {
    let mut month = usage();
    month["caches"] = json!([
        { "cacheId": "c1", "name": "sessions", "deleted": false, "hours": 312, "memoryMb": 64, "gbHours": "19.5", "gbMonths": "0.02621", "cost": "1.502" }
    ]);
    let api = Server::start(vec![Reply::json(200, month)]);

    let output = ff(&with_key(&api.url)).args(["usage", "--month", "2026-10"]).output().unwrap();

    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains(
            "total          15        3.14375     1           0.852\nCACHE     MEMORY  HOURS  GB-HOURS  COST\n\
             sessions  64 MB   312    19.5      1.502\nestimated cost:"
        ),
        "{text}"
    );
}

#[test]
fn usage_as_csv_is_the_apis_own_and_a_wrong_month_is_refused_before_calling() {
    let csv = "functionId,functionName,requests\r\nf1,hello,12\r\n";
    let api = Server::start(vec![Reply::text(200, "text/csv; charset=utf-8", csv)]);
    let dir = with_key(&api.url);

    ff(&dir).args(["usage", "--csv"]).assert().success().stdout(csv);
    assert_eq!(api.requests()[0].header("accept"), Some("text/csv"));
    ff(&dir)
        .args(["usage", "--month", "2026-13"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--month is a month as YYYY-MM"));
}

#[test]
fn usage_without_the_scope_exits_6_naming_it() {
    let api = Server::start(vec![Reply::json(
        403,
        json!({ "statusCode": 403, "message": "This API key lacks the scope usage:read" }),
    )]);

    ff(&with_key(&api.url))
        .arg("usage")
        .assert()
        .code(6)
        .stderr(predicate::str::contains("This API key lacks the scope usage:read"));
}

#[test]
fn balance_says_what_is_left_charged_and_whether_calls_go_on() {
    let balance = json!({ "currency": "TND", "balance": "-1.500", "shadowMode": false, "month": "2026-10", "charged": "6.500",
                          "ratedUntil": "2026-10-21T09:00:00.000Z",
                          "credit": { "state": "grace", "buffer": "1.000", "belowBufferSince": "2026-10-21T08:00:00.000Z", "invokesStopAt": "2026-10-22T08:00:00.000Z" } });
    let api = Server::start(vec![Reply::json(200, balance)]);

    ff(&with_key(&api.url)).arg("balance").assert().success().stdout(
        "balance   -1.500 TND\ncharged   6.500 TND in 2026-10, rated until 2026-10-21 09:00:00 UTC\n\
         invokes   go on until 2026-10-22 08:00:00 UTC: the balance is below its buffer; add credit\n",
    );
}

fn metrics() -> Value {
    json!({ "period": 60, "start": "2026-10-21T09:00:00.000Z", "end": "2026-10-21T09:02:00.000Z",
            "timestamps": ["2026-10-21T09:00:00.000Z", "2026-10-21T09:01:00.000Z"],
            "metrics": { "Invocations": [3, 0], "Errors": [1, 0], "Throttles": [0, 0], "ColdStarts": [1, 0],
                         "Duration": { "Average": [12.5, null], "Maximum": [30.2, null], "p50": [10.0, null], "p95": [29.0, null], "p99": [30.0, null] },
                         "Instances": { "Maximum": [1, 1], "Average": [1.0, 1.0] } } })
}

#[test]
fn metrics_of_a_function_show_a_row_per_period_and_the_totals() {
    let function = json!({ "id": "f1", "name": "hello", "runtime": "python", "code": "", "memory": 128, "timeout": 5, "status": "ACTIVE",
                           "minInstances": 0, "maxInstances": 3, "scaleToZero": true, "createdAt": "2026-10-21T09:00:00.000Z", "updatedAt": "2026-10-21T09:00:00.000Z" });
    let api = Server::start(vec![Reply::json(200, json!([function])), Reply::json(200, metrics())]);

    ff(&with_key(&api.url)).args(["metrics", "hello", "--period", "60", "--since", "2m"]).assert().success().stdout(
        "TIME (UTC)           INVOCATIONS  ERRORS  THROTTLES  COLD  P50 MS  P95 MS  MAX MS  INSTANCES\n\
         2026-10-21 09:00:00  3            1       0          1     10.0    29.0    30.2    1\n\
         2026-10-21 09:01:00  0            0       0          0     -       -       -       1\n\
         \"hello\" for 2m, a point each 1m: invocations 3, errors 1, throttles 0, cold starts 1\n",
    );
    let path = &api.requests()[1].path;
    assert!(path.starts_with("/functions/f1/metrics?period=60&start=20"), "{path}");
}

#[test]
fn metrics_say_the_calls_that_didnt_wait_as_lambdas_metrics_count_them_when_there_were_any() {
    let mut answer = metrics();
    answer["metrics"]["AsyncEventsReceived"] = json!([4, 1]);
    answer["metrics"]["AsyncEventAge"] = json!({ "Average": [120.0, null], "Maximum": [200.0, null] });
    answer["metrics"]["AsyncEventsDropped"] = json!([0, 3]);
    answer["metrics"]["DestinationDeliveryFailures"] = json!([1, 0]);
    let api = Server::start(vec![Reply::json(200, answer)]);

    let output = ff(&with_key(&api.url)).args(["metrics", "--since", "2m"]).output().unwrap();

    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.ends_with(
            "cold starts 1; calls without waiting: 5 kept, 3 dropped, 1 record its destination didn't take\n"
        ),
        "{text}"
    );
}

#[test]
fn metrics_of_the_account_and_a_wrong_period() {
    let api = Server::start(vec![Reply::json(200, metrics())]);
    let dir = with_key(&api.url);

    ff(&dir)
        .args(["metrics", "--output", "json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"Invocations\""));
    assert!(api.requests()[0].path.starts_with("/metrics?period=60&start="));
    ff(&dir)
        .args(["metrics", "--period", "120"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("a period is 60, 300 or 3600 seconds"));
}

#[test]
fn usage_shows_the_mail_after_the_caches_by_the_domain_or_address_it_went_from_as_ses_bills_it() {
    let mut month = usage();
    month["email"] = json!([
        { "resourceId": "e1", "identity": "shop.example.tn", "deleted": false, "recipients": 1250, "attachmentBytes": 52_428_800, "cost": "0.376" },
        { "resourceId": "e2", "identity": "ana@example.tn", "deleted": true, "recipients": 3, "attachmentBytes": 0, "cost": "0.001" }
    ]);
    let api = Server::start(vec![Reply::json(200, month)]);

    let output = ff(&with_key(&api.url)).args(["usage", "--month", "2026-10"]).output().unwrap();

    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains(
            "SENT FROM                 RECIPIENTS  ATTACHMENTS  COST\n\
             shop.example.tn           1250        50 MB        0.376\n\
             ana@example.tn (deleted)  3           -            0.001\nestimated cost:"
        ),
        "{text}"
    );
}

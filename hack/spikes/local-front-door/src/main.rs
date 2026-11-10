//! The spike's front doors on two ports, as `ff local start` would start them:
//!   local-front-door-spike --data <folder> --account <12 digits> --key <id>:<secret> \
//!     [--host localhost] [--s3-port 0] [--sqs-port 0] [--bucket <name>]… [--queue <name>]…
//! Prints one line of JSON once both listen, {"s3": <port>, "sqs": <port>}, then answers until it is stopped.

use local_front_door_spike::{Key, http, s3::S3, sqs::Sqs};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut data, mut account, mut key, mut host) = (None, None, None, "localhost".to_string());
    let (mut s3_port, mut sqs_port, mut buckets, mut queues) = (0u16, 0u16, Vec::new(), Vec::new());
    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_else(|| usage(&format!("{flag} needs a value")));
        match flag.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            "--account" => account = Some(value),
            "--key" => key = value.split_once(':').map(|(id, secret)| Key { id: id.into(), secret: secret.into() }),
            "--host" => host = value,
            "--s3-port" => s3_port = value.parse().unwrap_or_else(|_| usage("--s3-port takes a port")),
            "--sqs-port" => sqs_port = value.parse().unwrap_or_else(|_| usage("--sqs-port takes a port")),
            "--bucket" => buckets.push(value),
            "--queue" => queues.push(value),
            _ => usage(&format!("{flag} is not one of its flags")),
        }
    }
    let (Some(data), Some(account), Some(key)) = (data, account, key) else {
        usage("--data, --account and --key are needed")
    };
    let s3_listener = TcpListener::bind(("127.0.0.1", s3_port)).expect("S3's port");
    let sqs_listener = TcpListener::bind(("127.0.0.1", sqs_port)).expect("SQS's port");
    let (s3_port, sqs_port) = (s3_listener.local_addr().unwrap().port(), sqs_listener.local_addr().unwrap().port());
    let s3 = Arc::new(S3::new(key.clone(), &host, data, &buckets).expect("the buckets' folders"));
    let sqs = Arc::new(Sqs::new(key, &account, &format!("http://{host}:{sqs_port}"), &queues));
    println!("{{\"s3\": {s3_port}, \"sqs\": {sqs_port}}}");
    std::thread::spawn(move || {
        http::serve(s3_listener, Arc::new(move |incoming: &mut http::Incoming| s3.handle(incoming)))
    });
    http::serve(sqs_listener, Arc::new(move |incoming: &mut http::Incoming| sqs.handle(incoming)));
}

fn usage(problem: &str) -> ! {
    eprintln!("local-front-door-spike: {problem}");
    std::process::exit(2);
}

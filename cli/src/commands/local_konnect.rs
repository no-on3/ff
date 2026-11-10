//! `ff local konnect`: Konnect's stand-in on a port of this machine, until Ctrl-C.

use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use super::Context;
use crate::error::{Error, Kind};
use crate::local::{self, http, konnect};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    api_url: String,
    /// The same API from a function that ff local start runs, in a container.
    api_url_from_functions: Option<String>,
    api_key: String,
    wallet_id: String,
    /// How long each answer of its API waits first, as `--delay` gave it.
    delay: Option<String>,
}

pub fn start(port: u16, key: String, wallet: String, delay: Option<&str>, context: &Context) -> Result<(), Error> {
    if key.is_empty() || key.chars().any(|character| character.is_control() || character == ' ') {
        return Err(Error::usage("--key must be a word, without spaces"));
    }
    if wallet.is_empty() || !wallet.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(Error::usage("--wallet must be letters and digits, as a Konnect wallet's ID"));
    }
    let pause = match delay {
        None => Duration::ZERO,
        Some(text) => humantime::parse_duration(text)
            .map_err(|error| Error::usage(format!("--delay {text}: {error}: a duration, such as 2s or 500ms")))?,
    };
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
        Error::new(
            Kind::Failed,
            format!(
                "Couldn't listen on 127.0.0.1:{port}: {error}: another program has it; name another port with --port"
            ),
        )
    })?;
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(port);
    let address = format!("http://127.0.0.1:{port}");
    let quiet = context.out.quiet;
    let say = Box::new(move |line: &str| {
        if !quiet {
            eprintln!("{line}")
        }
    });
    let stand_in: Arc<dyn http::Answers> =
        Arc::new(konnect::Konnect::new(key.clone(), wallet.clone(), address.clone(), say).delayed(pause));
    http::serve(listener, Arc::clone(&stand_in));
    // Where containers reach this machine on Linux, which Docker Desktop leads to 127.0.0.1 itself.
    let from_functions = match local::docker_gateway().map(|gateway| TcpListener::bind((gateway, port))) {
        Some(Ok(listener)) => {
            http::serve(listener, stand_in);
            Some(format!("http://host.docker.internal:{port}{}", konnect::API_PATH))
        }
        _ => None,
    };
    let started = Started {
        api_url: format!("{address}{}", konnect::API_PATH),
        api_url_from_functions: from_functions,
        api_key: key,
        wallet_id: wallet,
        delay: delay.map(str::to_owned),
    };
    context.out.result(&started, || {
        let mut lines = vec![
            format!("Konnect's stand-in answers at {}: nothing is paid, and its payments are kept while it runs", started.api_url),
            format!("  KONNECT_API_URL={}", started.api_url),
        ];
        if let Some(from_functions) = &started.api_url_from_functions {
            lines.push(format!("  KONNECT_API_URL={from_functions}  from the functions ff local start runs"));
        }
        lines.push(format!("  KONNECT_API_KEY={}", started.api_key));
        lines.push(format!("  KONNECT_WALLET_ID={}", started.wallet_id));
        if let Some(delay) = &started.delay {
            lines.push(format!("Each answer of its API waits {delay} first, as --delay says"));
        }
        lines.push(format!(
            "Each payment's page, its payUrl, is under {address}/pay: Pay and Fail call the shop's webhook, and its faults' buttons try the webhook against a notification sent twice, before the payment is completed, or for one that doesn't exist. Ctrl-C stops it"
        ));
        lines.join("\n")
    })?;
    loop {
        std::thread::park();
    }
}

//! The spike's command, for run.sh. Each prints one line of JSON, the tokens never in it: their lifetimes and the claims
//! the spike reports. Tokens are kept in the file given, as `ff` will keep them in its credentials.
//!   device-flow-spike start <issuer> <client> <scope> <authorization file>
//!   device-flow-spike poll <issuer> <client> <authorization file> [<tokens file>]
//!   device-flow-spike wait <issuer> <client> <authorization file> <tokens file>
//!   device-flow-spike refresh <issuer> <client> <tokens file>
//!   device-flow-spike revoke <issuer> <client> <tokens file>
use device_flow_spike::{DeviceAuthorization, Error, Issuer, Poll, Tokens, claims};
use serde_json::{Value, json};
use std::process::ExitCode;
use std::time::Instant;

fn summary(tokens: &Tokens) -> Value {
    let access = claims(&tokens.access_token).unwrap_or(Value::Null);
    let refresh = tokens.refresh_token.as_deref().and_then(claims).unwrap_or(Value::Null);
    json!({
        "expires_in": tokens.expires_in,
        "refresh_expires_in": tokens.refresh_expires_in,
        "scope": tokens.scope,
        "access": { "aud": access["aud"], "azp": access["azp"], "typ": access["typ"], "sid": access["sid"],
                    "lifetime": access["exp"].as_i64().zip(access["iat"].as_i64()).map(|(exp, iat)| exp - iat) },
        "refresh": { "typ": refresh["typ"], "sid": refresh["sid"],
                     "lifetime": refresh["exp"].as_i64().zip(refresh["iat"].as_i64()).map(|(exp, iat)| exp - iat) },
    })
}

fn poll_name(poll: &Poll) -> &'static str {
    match poll {
        Poll::Pending => "pending",
        Poll::SlowDown => "slow_down",
        Poll::Expired => "expired",
        Poll::Denied => "denied",
        Poll::Approved(_) => "approved",
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> T {
    serde_json::from_str(&std::fs::read_to_string(path).expect(path)).expect(path)
}

fn save(path: &str, tokens: &Tokens) {
    let value = json!({ "access_token": tokens.access_token, "expires_in": tokens.expires_in,
                        "refresh_token": tokens.refresh_token, "refresh_expires_in": tokens.refresh_expires_in,
                        "scope": tokens.scope, "id_token": tokens.id_token });
    std::fs::write(path, value.to_string()).expect(path);
}

fn run(args: &[String]) -> Result<Value, Error> {
    let issuer = Issuer::discover(&args[1], &args[2])?;
    match (args[0].as_str(), args.len()) {
        ("start", 5) => {
            let authorization = issuer.start(&args[3])?;
            let file = json!({ "device_code": authorization.device_code, "user_code": authorization.user_code,
                               "verification_uri": authorization.verification_uri,
                               "verification_uri_complete": authorization.verification_uri_complete,
                               "expires_in": authorization.expires_in, "interval": authorization.interval });
            std::fs::write(&args[4], file.to_string()).expect("the authorization file");
            Ok(json!({ "user_code": authorization.user_code, "verification_uri": authorization.verification_uri,
                       "complete": authorization.verification_uri_complete.is_some(),
                       "expires_in": authorization.expires_in, "interval": authorization.interval }))
        }
        ("poll", 4 | 5) => {
            let authorization: DeviceAuthorization = read_json(&args[3]);
            let poll = issuer.poll(&authorization.device_code)?;
            if let (Poll::Approved(tokens), Some(path)) = (&poll, args.get(4)) {
                save(path, tokens);
            }
            Ok(json!({ "poll": poll_name(&poll) }))
        }
        ("wait", 5) => {
            let authorization: DeviceAuthorization = read_json(&args[3]);
            let started = Instant::now();
            let mut polls = Vec::new();
            let ended = issuer.wait(&authorization, std::thread::sleep, |poll, interval| {
                polls.push(json!({ "at": started.elapsed().as_secs(), "interval": interval, "poll": poll_name(poll) }))
            })?;
            match ended {
                Ok(tokens) => {
                    save(&args[4], &tokens);
                    Ok(json!({ "approved": true, "polls": polls, "tokens": summary(&tokens) }))
                }
                Err(poll) => Ok(json!({ "approved": false, "ended": poll_name(&poll), "polls": polls })),
            }
        }
        ("refresh", 4) => {
            let saved: Tokens = read_json(&args[3]);
            let refresh_token = saved.refresh_token.as_deref().expect("a refresh token");
            let tokens = issuer.refresh(refresh_token)?;
            save(&args[3], &tokens);
            Ok(json!({ "refreshed": true, "rotated": tokens.refresh_token.as_deref() != Some(refresh_token),
                       "tokens": summary(&tokens) }))
        }
        ("revoke", 4) => {
            let saved: Tokens = read_json(&args[3]);
            issuer.revoke(saved.refresh_token.as_deref().expect("a refresh token"))?;
            Ok(json!({ "revoked": true }))
        }
        _ => {
            eprintln!("device-flow-spike start|poll|wait|refresh|revoke <issuer> <client> …: see src/main.rs");
            std::process::exit(2);
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("device-flow-spike start|poll|wait|refresh|revoke <issuer> <client> …: see src/main.rs");
        return ExitCode::from(2);
    }
    match run(&args) {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(Error::Refused { status, error, description }) => {
            println!("{}", json!({ "refused": { "status": status, "error": error, "description": description } }));
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(3)
        }
    }
}

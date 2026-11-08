//! The spike's command, for run.sh:
//!   minisign-spike verify <public key, base64> <file> [<signature file>] [by-hand|crate]
//!   minisign-spike hash <file> [by-hand|crate]      the file's BLAKE2b-512 in hexadecimal, and the time it took
use minisign_spike::{Hasher, PublicKey, Signature, digest_reader};
use std::fs::File;
use std::io::BufReader;
use std::process::ExitCode;
use std::time::Instant;

fn hasher(name: Option<&String>) -> Hasher {
    match name.map(String::as_str) {
        None | Some("by-hand") => Hasher::ByHand,
        #[cfg(feature = "blake2-crate")]
        Some("crate") => Hasher::Crate,
        Some(other) => panic!("no hasher {other}"),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("verify") if args.len() >= 3 => {
            let key = PublicKey::from_base64(&args[1]).expect("a public key");
            let signature_path = args.get(3).cloned().unwrap_or_else(|| format!("{}.minisig", args[2]));
            let signature = Signature::parse(&std::fs::read_to_string(&signature_path).expect("the signature"));
            let file = BufReader::new(File::open(&args[2]).expect("the file"));
            let digest = digest_reader(file, hasher(args.get(4))).expect("the file read");
            match signature.and_then(|signature| signature.verify_digest(&key, &digest).map(str::to_string)) {
                Ok(comment) => {
                    println!("verified, by key {}: {comment}", key.id());
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{}: {error}", args[2]);
                    ExitCode::FAILURE
                }
            }
        }
        Some("hash") if args.len() >= 2 => {
            let started = Instant::now();
            let digest = digest_reader(File::open(&args[1]).expect("the file"), hasher(args.get(2))).expect("read");
            let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
            println!("{hex} {} ms", started.elapsed().as_millis());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!(
                "minisign-spike verify <public key> <file> [<signature>] [by-hand|crate] | hash <file> [by-hand|crate]"
            );
            ExitCode::from(2)
        }
    }
}

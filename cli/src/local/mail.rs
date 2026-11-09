//! The mail a template's functions send (ADR 0017): SES v2's `SendEmail` at the local front door, in SES's REST JSON,
//! each request checked in FF's order and refused in its words (`BE/src/email/ses-operations.ts` and
//! `email-messages.service.ts`), its message made as FF makes it, then kept, never sent: a file under
//! `.ff/local/mail/` that a mail reader opens, its envelope beside it, and a line on stderr. FF's checks of the
//! account, its proved identities, its sandbox, its quotas and its suppression list, are FF's: here any sender goes.
//! Its cases are `BE/src/email/send-email-examples.json`'s, which the backend's tests read too.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::http::{Request, Response, lenient_base64, request_id};
use super::key::Key;
use super::s3::requests::signed_service;
use super::schedule_expression::Millis;
use crate::dates::{iso_millis, mail_date};
use crate::sigv4::{Problem, SignedRequest, Words, check_authorization, decode_escapes, read_authorization, words};

/// The service SES's requests are signed for.
pub const SERVICE: &str = "ses";
/// The most a request's body holds: a raw message of 10 MB, in base64, and its JSON around it, as FF's endpoint takes.
pub const MAX_BODY_BYTES: usize = 14 * 1024 * 1024;
/// The most recipients a message has, To, Cc and Bcc together, as SES's.
const MAX_RECIPIENTS: usize = 50;
/// The most a message is, as SES's raw messages: 10 MB.
const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;
/// The host a message's ID names, as FF's names its SES endpoint's.
const MESSAGE_HOST: &str = "email.localhost";
/// The headers SES writes itself, which a request's own can't be.
const OWN_HEADERS: [&str; 14] = [
    "from",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "return-path",
    "dkim-signature",
    "sender",
];
/// SES v2's routes FF answers, each a method, a path whose `{name}` is one segment, and the operation.
const ROUTES: [(&str, &str, &str); 11] = [
    ("POST", "/v2/email/identities", "CreateEmailIdentity"),
    ("POST", "/v2/email/list-identities", "ListEmailIdentities"),
    ("GET", "/v2/email/identities", "ListEmailIdentities"),
    ("GET", "/v2/email/identities/{name}", "GetEmailIdentity"),
    ("DELETE", "/v2/email/identities/{name}", "DeleteEmailIdentity"),
    ("POST", "/v2/email/outbound-emails", "SendEmail"),
    ("GET", "/v2/email/account", "GetAccount"),
    ("PUT", "/v2/email/suppression/addresses", "PutSuppressedDestination"),
    ("GET", "/v2/email/suppression/addresses", "ListSuppressedDestinations"),
    ("GET", "/v2/email/suppression/addresses/{name}", "GetSuppressedDestination"),
    ("DELETE", "/v2/email/suppression/addresses/{name}", "DeleteSuppressedDestination"),
];
/// The characters of an encoded word's text at most, in bytes: its base64 then 48 characters, a folded line short.
const WORD_BYTES: usize = 36;
/// The longest line of a header or a body as written, but where a word is longer.
const LINE: usize = 76;

/// An error as SES v2 answers it in AWS's REST JSON protocol: a status, its name in `x-amzn-ErrorType`, its words.
#[derive(Debug, PartialEq, Eq)]
pub struct SesError {
    pub status: u16,
    pub kind: &'static str,
    pub message: String,
}

impl SesError {
    fn new(status: u16, kind: &'static str, message: impl Into<String>) -> SesError {
        SesError { status, kind, message: message.into() }
    }

    pub fn response(&self) -> Response {
        Response {
            status: self.status,
            headers: vec![
                ("content-type".into(), "application/json".into()),
                (
                    "x-amzn-ErrorType".into(),
                    format!("{}:http://internal.amazon.com/coral/com.amazon.coral.service/", self.kind),
                ),
            ],
            body: json!({ "message": self.message }).to_string().into_bytes(),
        }
    }
}

fn bad_request(message: impl Into<String>) -> SesError {
    SesError::new(400, "BadRequestException", message)
}

fn not_implemented(message: impl Into<String>) -> SesError {
    SesError::new(501, "NotImplemented", message)
}

/// SES's answer to a request it couldn't read: over what a body holds, or not HTTP.
pub fn unreadable(too_large: bool) -> Response {
    match too_large {
        true => {
            SesError::new(413, "RequestEntityTooLargeException", format!("The request is over {MAX_BODY_BYTES} bytes."))
        }
        false => bad_request("The client went before its request ended."),
    }
    .response()
}

/// Whether a request is SES's: signed for SES, or unsigned at one of its paths.
pub fn is_ses(request: &Request) -> bool {
    let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
    match signed_service(request.header("authorization"), query) {
        Some(service) => service == SERVICE,
        None => path.starts_with("/v2/email/"),
    }
}

/// The operation a request is, as FF routes it, and the name its path holds, decoded; None for one FF doesn't answer.
pub fn route_of(method: &str, raw_path: &str) -> Option<(&'static str, Option<String>)> {
    let segments: Vec<&str> = raw_path.split('/').collect();
    ROUTES.iter().filter(|(route_method, _, _)| *route_method == method).find_map(|(_, pattern, operation)| {
        let wanted: Vec<&str> = pattern.split('/').collect();
        if wanted.len() != segments.len() {
            return None;
        }
        let mut name = None;
        for (want, segment) in wanted.iter().zip(&segments) {
            match *want {
                "{name}" if !segment.is_empty() => name = Some(decode_escapes(segment)),
                _ if want == segment => {}
                _ => return None,
            }
        }
        Some((*operation, name))
    })
}

/// A message kept, as its envelope says it beside it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeptMessage {
    pub message_id: String,
    pub sent_at: String,
    /// The sender's address.
    pub from: String,
    /// Each recipient once, Bcc's too, in lower case, as the envelope names them.
    pub recipients: Vec<String>,
    pub subject: String,
    pub bytes: usize,
    /// The message's file, a mail reader's, in the mail's folder.
    pub file: String,
}

/// The mail of the template's app: its folder, its clock, and where it says what it keeps.
pub struct Mail {
    folder: PathBuf,
    now: Arc<dyn Fn() -> Millis + Send + Sync>,
    say: Arc<dyn Fn(&str) + Send + Sync>,
    /// The last message's time: the next one's is after it, so that the mail lists in the order it came.
    last: Mutex<Millis>,
}

impl Mail {
    pub fn new(
        folder: &Path,
        now: Arc<dyn Fn() -> Millis + Send + Sync>,
        say: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Mail {
        Mail { folder: folder.to_path_buf(), now, say, last: Mutex::new(0) }
    }

    /// The answer to a request of SES's, in FF's order: its size, its signature, its body as JSON, its route.
    pub fn answer(&self, request: &Request, key: &Key, other_key: impl Fn(&str)) -> Response {
        match self.answered(request, key, other_key) {
            Ok(document) => Response {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: document.to_string().into_bytes(),
            },
            Err(error) => error.response(),
        }
    }

    fn answered(&self, request: &Request, key: &Key, other_key: impl Fn(&str)) -> Result<Value, SesError> {
        if request.body.len() > MAX_BODY_BYTES {
            return Err(SesError::new(
                413,
                "RequestEntityTooLargeException",
                format!("The request is over {MAX_BODY_BYTES} bytes."),
            ));
        }
        let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
        let refused = |problem: Problem| {
            match words(problem, SERVICE) {
            Words::Token => unrecognized_client(),
            Words::Incomplete(message) => SesError::new(400, "IncompleteSignatureException", message),
            Words::Mismatch(message) => SesError::new(
                403,
                "SignatureDoesNotMatch",
                message.unwrap_or_else(|| {
                    "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.".to_owned()
                }),
            ),
        }
        };
        if let Some(signature) = read_authorization(&request.headers, SERVICE).map_err(refused)? {
            if signature.access_key_id != key.id {
                other_key(&signature.access_key_id);
                return Err(unrecognized_client());
            }
            let signed =
                SignedRequest { method: &request.method, raw_path: path, raw_query: query, headers: &request.headers };
            check_authorization(&signed, &request.body, &signature, &key.secret, (self.now)() / 1000, SERVICE)
                .map_err(refused)?;
        }
        let input = match request.body.is_empty() {
            true => Map::new(),
            false => match serde_json::from_slice::<Value>(&request.body) {
                Ok(Value::Object(input)) => input,
                Ok(_) => return Err(bad_request("The request body must be a JSON object.")),
                Err(_) => return Err(bad_request("The request body is not JSON.")),
            },
        };
        match route_of(&request.method, path) {
            Some(("SendEmail", _)) => self.send_email(&input),
            Some((operation, _)) => Err(not_implemented(format!(
                "ff local keeps the mail its functions send, and answers SendEmail alone: {operation} is FF's, whose account has identities, quotas and a suppression list"
            ))),
            None => Err(not_implemented(format!(
                "ff local's mail answers SES v2's SendEmail alone, POST /v2/email/outbound-emails, not {} {path}",
                request.method
            ))),
        }
    }

    /// SendEmail, its request checked as FF checks it, then its message made and kept.
    fn send_email(&self, input: &Map<String, Value>) -> Result<Value, SesError> {
        let request = send_request(input)?;
        let (from, recipients) = checked(&request)?;
        let id = request_id();
        let at = {
            let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
            *last = (self.now)().max(*last + 1);
            *last
        };
        let (message, subject) = match &request.content {
            Content::Simple(simple) => {
                (compose_simple(&request, simple, &id, MESSAGE_HOST, at), one_line(&simple.subject))
            }
            Content::Raw(raw) => (without_bcc(raw), raw_subject(raw)),
        };
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(SesError::new(
                400,
                "MessageRejected",
                format!("Message length is more than {MAX_MESSAGE_BYTES} bytes long: {}.", message.len()),
            ));
        }
        let stamp: String = iso_millis(at).chars().filter(char::is_ascii_alphanumeric).collect();
        let name = format!("{stamp}-{id}");
        let kept = KeptMessage {
            message_id: id.clone(),
            sent_at: iso_millis(at),
            from,
            recipients,
            subject,
            bytes: message.len(),
            file: format!("{name}.eml"),
        };
        let file = self.folder.join(&kept.file);
        let written =
            std::fs::create_dir_all(&self.folder).and_then(|()| std::fs::write(&file, &message)).and_then(|()| {
                let envelope = serde_json::to_string_pretty(&kept).unwrap_or_default();
                std::fs::write(self.folder.join(format!("{name}.json")), envelope + "\n")
            });
        if let Err(error) = written {
            (self.say)(&format!("A message couldn't be kept in {}: {error}", self.folder.display()));
            return Err(SesError::new(
                500,
                "InternalFailure",
                "The request processing has failed because of an unknown error, exception or failure.",
            ));
        }
        (self.say)(&format!(
            "A message from {} to {}, \"{}\", kept in {}, not sent",
            kept.from,
            kept.recipients.join(", "),
            kept.subject,
            file.display()
        ));
        Ok(json!({ "MessageId": id }))
    }
}

fn unrecognized_client() -> SesError {
    SesError::new(403, "UnrecognizedClientException", "The security token included in the request is invalid.")
}

/// The messages kept in a folder, in the order they were sent, each file's path whole; none for no folder.
pub fn kept_in(folder: &Path) -> std::io::Result<Vec<KeptMessage>> {
    let mut envelopes: Vec<PathBuf> = match std::fs::read_dir(folder) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    envelopes.sort();
    Ok(envelopes
        .iter()
        .filter_map(|path| std::fs::read(path).ok())
        .filter_map(|text| serde_json::from_slice::<KeptMessage>(&text).ok())
        .map(|kept| KeptMessage { file: folder.join(&kept.file).display().to_string(), ..kept })
        .collect())
}

/// A message's content, as SendEmail takes it: simple, which FF makes into MIME, or raw, the whole message.
#[derive(Debug)]
enum Content {
    Simple(Simple),
    Raw(Vec<u8>),
}

#[derive(Debug)]
struct Simple {
    subject: String,
    text: Option<String>,
    html: Option<String>,
    headers: Vec<(String, String)>,
}

/// A SendEmail request, as FF reads it: its lists as their texts.
#[derive(Debug)]
struct SendRequest {
    from: Option<String>,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    reply_to: Vec<String>,
    content: Content,
}

/// A field of the request's that is an object, or none; anything else refused, naming the field.
fn object_of<'a>(value: Option<&'a Value>, name: &str) -> Result<Option<&'a Map<String, Value>>, SesError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(object)) => Ok(Some(object)),
        Some(_) => Err(bad_request(format!("{name} must be an object"))),
    }
}

/// A list of strings of the request's, or none; anything else refused, naming the field.
fn strings(value: Option<&Value>, name: &str) -> Result<Vec<String>, SesError> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
            Ok(items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        }
        Some(_) => Err(bad_request(format!("{name} must be a list of strings"))),
    }
}

/// A Content's text, SES's `{ Data, Charset }`, its Charset taken as UTF-8.
fn data_of(value: Option<&Value>, name: &str) -> Result<Option<String>, SesError> {
    let Some(content) = object_of(value, name)? else { return Ok(None) };
    match content.get("Data") {
        Some(Value::String(data)) => Ok(Some(data.clone())),
        _ => Err(bad_request(format!("{name}.Data is required: a string"))),
    }
}

/// SendEmail's request read in FF's order: its configuration set, its sender, its lists, then its content.
fn send_request(input: &Map<String, Value>) -> Result<SendRequest, SesError> {
    if let Some(set) = input.get("ConfigurationSetName") {
        return Err(SesError::new(404, "NotFoundException", format!("Configuration set {set} does not exist.")));
    }
    let from = match input.get("FromEmailAddress") {
        None => None,
        Some(Value::String(from)) => Some(from.clone()),
        Some(_) => return Err(bad_request("FromEmailAddress must be a string")),
    };
    let empty = Map::new();
    let destination = object_of(input.get("Destination"), "Destination")?.unwrap_or(&empty);
    Ok(SendRequest {
        from,
        to: strings(destination.get("ToAddresses"), "Destination.ToAddresses")?,
        cc: strings(destination.get("CcAddresses"), "Destination.CcAddresses")?,
        bcc: strings(destination.get("BccAddresses"), "Destination.BccAddresses")?,
        reply_to: strings(input.get("ReplyToAddresses"), "ReplyToAddresses")?,
        content: content_of(input)?,
    })
}

/// SendEmail's content: Simple, or Raw; a template, which FF doesn't send, refused.
fn content_of(input: &Map<String, Value>) -> Result<Content, SesError> {
    let content =
        object_of(input.get("Content"), "Content")?.ok_or_else(|| bad_request("Content is required: Simple or Raw"))?;
    if content.contains_key("Template") {
        return Err(not_implemented("FF's SES endpoint doesn't send templates: send Simple or Raw content"));
    }
    if let Some(simple) = object_of(content.get("Simple"), "Content.Simple")? {
        let subject = data_of(simple.get("Subject"), "Content.Simple.Subject")?
            .ok_or_else(|| bad_request("Content.Simple.Subject is required"))?;
        let empty = Map::new();
        let body = object_of(simple.get("Body"), "Content.Simple.Body")?.unwrap_or(&empty);
        let text = data_of(body.get("Text"), "Content.Simple.Body.Text")?;
        let html = data_of(body.get("Html"), "Content.Simple.Body.Html")?;
        if text.is_none() && html.is_none() {
            return Err(bad_request("Content.Simple.Body needs Text, Html or both"));
        }
        let headers = match simple.get("Headers") {
            None => Vec::new(),
            Some(Value::Array(headers)) => headers
                .iter()
                .map(|header| {
                    let header = object_of(Some(header), "Content.Simple.Headers[]")?.unwrap_or(&empty);
                    match (header.get("Name"), header.get("Value")) {
                        (Some(Value::String(name)), Some(Value::String(value))) => Ok((name.clone(), value.clone())),
                        _ => Err(bad_request("Content.Simple.Headers are each a Name and a Value")),
                    }
                })
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(bad_request("Content.Simple.Headers must be a list")),
        };
        return Ok(Content::Simple(Simple { subject, text, html, headers }));
    }
    if let Some(raw) = object_of(content.get("Raw"), "Content.Raw")? {
        return match raw.get("Data") {
            Some(Value::String(data))
                if data
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=') || c.is_whitespace()) =>
            {
                Ok(Content::Raw(lenient_base64(data)))
            }
            _ => Err(bad_request("Content.Raw.Data is required: the whole message, in base64")),
        };
    }
    Err(bad_request("Content is Simple or Raw"))
}

/// The request's sender and recipients checked as FF checks them before the account's: the sender's one address,
/// each recipient's, each once and 50 at most, the reply-to's, and the request's own headers.
fn checked(request: &SendRequest) -> Result<(String, Vec<String>), SesError> {
    let parties = match &request.content {
        Content::Raw(raw) => Some(raw_parties(raw)),
        Content::Simple(_) => None,
    };
    let from_text = request.from.clone().or_else(|| parties.as_ref().and_then(|parties| parties.from.clone()));
    let Some(from_text) = from_text.filter(|text| !text.is_empty()) else {
        return Err(bad_request("FromEmailAddress is required, unless the raw message has a From header"));
    };
    let from = sender_of(&from_text).ok_or_else(|| bad_request(format!("{from_text} is not one address")))?;
    // The request's lists, else the raw message's fields: each read alike, and the one that holds no address named.
    let named = !(request.to.is_empty() && request.cc.is_empty() && request.bcc.is_empty());
    let given: Vec<&String> = match (named, &parties) {
        (true, _) => request.to.iter().chain(&request.cc).chain(&request.bcc).collect(),
        (false, Some(parties)) => parties.to.iter().chain(&parties.cc).chain(&parties.bcc).collect(),
        (false, None) => Vec::new(),
    };
    if let Some(text) = given.iter().find(|text| addresses_of(text).contains(&None)) {
        return Err(bad_request(format!("Illegal address: {text}")));
    }
    let mut recipients: Vec<String> = Vec::new();
    for address in given.iter().flat_map(|text| addresses_of(text)).flatten() {
        if !recipients.contains(&address) {
            recipients.push(address);
        }
    }
    if recipients.is_empty() {
        return Err(bad_request("A message needs a recipient: Destination's ToAddresses, CcAddresses or BccAddresses"));
    }
    if recipients.len() > MAX_RECIPIENTS {
        return Err(bad_request(format!("Recipient count exceeds {MAX_RECIPIENTS}.")));
    }
    if request.reply_to.iter().flat_map(|text| addresses_of(text)).any(|address| address.is_none()) {
        return Err(bad_request("Illegal address in ReplyToAddresses"));
    }
    if let Content::Simple(simple) = &request.content
        && let Some(problem) = simple.headers.iter().find_map(|(name, value)| header_problem(name, value))
    {
        return Err(bad_request(problem));
    }
    Ok((from, recipients))
}

/// A mailbox of an address list: its display name, empty for none, and its address as written.
#[derive(Debug, PartialEq, Eq)]
pub struct Mailbox {
    pub name: String,
    pub address: String,
}

/// An address list's entries, as a header or SES's API writes them: split at its commas, and a group's colon and
/// semicolon, outside quotes, comments and angle brackets, each entry's comments dropped.
fn entries(list: &str) -> Vec<String> {
    let (mut entries, mut entry) = (Vec::new(), String::new());
    let (mut quoted, mut angle, mut comment) = (false, false, 0usize);
    let mut characters = list.chars();
    while let Some(character) = characters.next() {
        match character {
            '\\' if quoted || comment > 0 => {
                if comment == 0 {
                    entry.push(character);
                }
                if let Some(next) = characters.next()
                    && comment == 0
                {
                    entry.push(next);
                }
            }
            '"' if comment == 0 && !angle => {
                quoted = !quoted;
                entry.push(character);
            }
            '(' if !quoted && !angle => {
                comment += 1;
                if comment == 1 {
                    entry.push(' ');
                }
            }
            ')' if comment > 0 => comment -= 1,
            _ if comment > 0 => {}
            '<' if !quoted => {
                angle = true;
                entry.push(character);
            }
            '>' if angle => {
                angle = false;
                entry.push(character);
            }
            ',' | ';' if !quoted && !angle => entries.push(std::mem::take(&mut entry)),
            // A group's name, before its colon, names no mailbox: its members follow.
            ':' if !quoted && !angle => entry.clear(),
            _ => entry.push(character),
        }
    }
    entries.push(entry);
    entries.into_iter().map(|entry| entry.trim().to_owned()).filter(|entry| !entry.is_empty()).collect()
}

/// A display name as written, its quotes taken off and its escapes undone, its spaces as one.
fn unquoted(text: &str) -> String {
    let mut name = String::new();
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        match character {
            '"' => {}
            '\\' => name.extend(characters.next()),
            other => name.push(other),
        }
    }
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An address list's mailboxes, as FF's parser reads the forms a header or SES's API writes: `a@b.tn`,
/// `Name <a@b.tn>`, `"Name, Shop" <a@b.tn>`, a comment, a group's members. An entry without angle brackets is its
/// first word that looks like an address, the others its name; an entry that is no address keeps its words.
pub fn mailboxes(list: &str) -> Vec<Mailbox> {
    entries(list)
        .into_iter()
        .map(|entry| {
            if let (Some(open), Some(close)) = (entry.rfind('<'), entry.rfind('>'))
                && open < close
            {
                return Mailbox { name: unquoted(&entry[..open]), address: entry[open + 1..close].trim().to_owned() };
            }
            let words: Vec<&str> = entry.split_whitespace().collect();
            let looks = |word: &&str| {
                word.split_once('@')
                    .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty() && !domain.contains('@'))
            };
            match words.iter().position(looks) {
                Some(at) if words.len() > 1 => Mailbox {
                    name: words
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| *index != at)
                        .map(|(_, word)| *word)
                        .collect::<Vec<_>>()
                        .join(" "),
                    address: words[at].to_owned(),
                },
                _ if words.len() == 1 => Mailbox { name: String::new(), address: unquoted(words[0]) },
                _ => Mailbox { name: unquoted(&entry), address: String::new() },
            }
        })
        .collect()
}

/// The name as FF keeps it: trimmed, lower case, a domain without its final dot.
pub fn identity_key(name: &str) -> String {
    let key = name.trim().to_lowercase();
    key.strip_suffix('.').map(str::to_owned).unwrap_or(key)
}

/// Why a name is no domain mail can go from, or None when it is one.
fn mail_domain_problem(domain: &str) -> Option<String> {
    if domain.is_empty() || domain.chars().count() > 253 {
        return Some("A domain has 1 to 253 characters".to_owned());
    }
    let bare = domain.trim_start_matches('[').trim_end_matches(']');
    if domain.parse::<std::net::IpAddr>().is_ok() || bare.parse::<std::net::IpAddr>().is_ok() {
        return Some("An IP address is no domain: give a name, such as example.tn".to_owned());
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return Some("A domain has two labels at least, such as example.tn".to_owned());
    }
    let is_label = |label: &&str| {
        (1..=63).contains(&label.len())
            && label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    if let Some(bad) = labels.iter().find(|label| !is_label(label)) {
        return Some(format!(
            "\"{bad}\" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen"
        ));
    }
    if labels.last().is_some_and(|last| last.bytes().all(|byte| byte.is_ascii_digit())) {
        return Some("A domain ends with a name, not a number".to_owned());
    }
    None
}

/// Why a name is no address mail can go to or from, or None when it is one.
fn address_problem(address: &str) -> Option<String> {
    if address.encode_utf16().count() > 320 {
        return Some("An address has 320 characters at most".to_owned());
    }
    let at = address.rfind('@').filter(|at| *at > 0 && *at + 1 < address.len());
    let Some(at) = at else {
        return Some("An address is a local part, @ and a domain, such as orders@example.tn".to_owned());
    };
    let local = &address[..at];
    let atom = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"!#$%&'*+/=?^_`{|}~-".contains(&byte)
            })
    };
    if local.encode_utf16().count() > 64 || !local.split('.').all(atom) {
        return Some(format!(
            "\"{local}\" is not an address's local part: 64 letters, digits, dots and !#$%&'*+/=?^_`{{|}}~- at most"
        ));
    }
    mail_domain_problem(&address[at + 1..]).map(|problem| format!("The address's domain: {problem}"))
}

/// The addresses of an address list, in lower case; None for one that is no address.
pub fn addresses_of(list: &str) -> Vec<Option<String>> {
    mailboxes(list)
        .iter()
        .map(|mailbox| {
            let key = identity_key(&mailbox.address);
            (!key.is_empty() && address_problem(&key).is_none()).then_some(key)
        })
        .collect()
}

/// The one address of a sender: `Ana <orders@shop.tn>` or `orders@shop.tn`; None for none, or more than one.
pub fn sender_of(text: &str) -> Option<String> {
    match addresses_of(text).as_slice() {
        [one] => one.clone(),
        _ => None,
    }
}

/// Why a header of the request's can't be the message's, or None when it can.
pub fn header_problem(name: &str, value: &str) -> Option<String> {
    let name_ok =
        (1..=76).contains(&name.len()) && name.bytes().all(|byte| (0x21..=0x7e).contains(&byte) && byte != b':');
    if !name_ok {
        return Some(format!("{} is not a header's name", Value::from(name)));
    }
    if OWN_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
        return Some(format!("{name} is a header SES writes itself"));
    }
    if value.contains(['\r', '\n']) || value.encode_utf16().count() > 870 {
        return Some(format!("{name}'s value is one line of 870 characters at most"));
    }
    None
}

/// A raw message's header: its fields unfolded, by their names in lower case, in order, each byte a character as
/// Latin-1 reads it; and where its body starts.
pub fn header_of(raw: &[u8]) -> (Vec<(String, String)>, usize) {
    let head = &raw[..raw.len().min(256 * 1024)];
    let blank = blank_line(head);
    let end = blank.map_or(head.len(), |(_, end)| end);
    let text: String = head[..blank.map_or(head.len(), |(start, _)| start)].iter().map(|&byte| byte as char).collect();
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)) {
        if line.starts_with([' ', '\t'])
            && let Some((_, value)) = fields.last_mut()
        {
            value.push(' ');
            value.push_str(line.trim());
        } else if let Some(colon) = line.find(':').filter(|colon| *colon > 0) {
            fields.push((line[..colon].trim().to_lowercase(), line[colon + 1..].trim().to_owned()));
        }
    }
    (fields, end)
}

/// The first blank line of a message, `\r?\n\r?\n`: where it starts and where it ends.
fn blank_line(bytes: &[u8]) -> Option<(usize, usize)> {
    (0..bytes.len()).filter(|&at| bytes[at] == b'\n').find_map(|at| {
        let next = at + 1 + usize::from(bytes.get(at + 1) == Some(&b'\r'));
        (bytes.get(next) == Some(&b'\n'))
            .then(|| (if at > 0 && bytes[at - 1] == b'\r' { at - 1 } else { at }, next + 1))
    })
}

/// A raw message's sender, its one From field, and its recipients' fields, each list as its header writes it.
#[derive(Debug, PartialEq, Eq, Deserialize)]
pub struct Parties {
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
}

pub fn raw_parties(raw: &[u8]) -> Parties {
    let (fields, _) = header_of(raw);
    let all = |name: &str| -> Vec<String> {
        fields.iter().filter(|(field, _)| field == name).map(|(_, value)| value.clone()).collect()
    };
    let from = all("from");
    Parties {
        from: if from.len() == 1 { from.into_iter().next() } else { None },
        to: all("to"),
        cc: all("cc"),
        bcc: all("bcc"),
    }
}

/// The raw message without its Bcc field and the lines that fold it, which only the envelope carries; the message as
/// it came when it has none.
pub fn without_bcc(raw: &[u8]) -> Vec<u8> {
    let head_end = blank_line(raw).map_or(raw.len(), |(start, _)| start);
    let head = &raw[..head_end];
    let mut kept: Vec<u8> = Vec::with_capacity(head.len());
    let mut in_bcc = false;
    for line in head.split_inclusive(|&byte| byte == b'\n') {
        let folded = line.first().is_some_and(|byte| matches!(byte, b' ' | b'\t'));
        in_bcc = if folded { in_bcc } else { line.len() >= 4 && line[..4].eq_ignore_ascii_case(b"bcc:") };
        if !in_bcc {
            kept.extend_from_slice(line);
        }
    }
    if kept == head {
        return raw.to_vec();
    }
    if kept.ends_with(b"\n") {
        kept.pop();
        if kept.ends_with(b"\r") {
            kept.pop();
        }
    }
    kept.extend_from_slice(&raw[head_end..]);
    kept
}

/// A header field's value as a reader shows it: RFC 2047's encoded words decoded, those side by side as one text.
pub fn decoded_words(value: &str) -> String {
    let mut shown = String::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        if let Some((bytes, after)) = encoded_word(rest) {
            pending.extend(bytes);
            rest = after;
            // The space between two encoded words is no text of theirs.
            let spaced = rest.trim_start_matches([' ', '\t']);
            if encoded_word(spaced).is_some() {
                rest = spaced;
            }
            continue;
        }
        shown.push_str(&String::from_utf8_lossy(&std::mem::take(&mut pending)));
        let character = rest.chars().next().unwrap_or_default();
        shown.push(character);
        rest = &rest[character.len_utf8()..];
    }
    shown.push_str(&String::from_utf8_lossy(&pending));
    shown
}

/// The encoded word a text starts with, `=?UTF-8?Q?…?=` or `?B?`: its bytes, and the text after it.
fn encoded_word(text: &str) -> Option<(Vec<u8>, &str)> {
    let inner = text.strip_prefix("=?")?;
    let (charset, inner) = inner.split_once('?')?;
    if !charset.eq_ignore_ascii_case("utf-8") {
        return None;
    }
    let (encoding, inner) = inner.split_once('?')?;
    let (encoded, after) = inner.split_once("?=")?;
    let bytes = match encoding {
        "B" | "b" => STANDARD.decode(encoded).ok()?,
        "Q" | "q" => quoted_printable_decode(&encoded.replace('_', " ")),
        _ => return None,
    };
    Some((bytes, after))
}

/// Quoted-printable's text back to its bytes: `=XX` a byte, `=` at a line's end a soft break.
fn quoted_printable_decode(text: &str) -> Vec<u8> {
    let bytes = text.replace("=\r\n", "").replace("=\n", "").into_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes.get(at + 1..at + 3).and_then(|pair| std::str::from_utf8(pair).ok());
        match (bytes[at], hex.and_then(|hex| u8::from_str_radix(hex, 16).ok())) {
            (b'=', Some(byte)) => {
                decoded.push(byte);
                at += 3;
            }
            (byte, _) => {
                decoded.push(byte);
                at += 1;
            }
        }
    }
    decoded
}

/// A raw message's subject, as a reader shows it; none for none.
fn raw_subject(raw: &[u8]) -> String {
    let (fields, _) = header_of(raw);
    let latin1 = fields.iter().find(|(name, _)| name == "subject").map(|(_, value)| value.clone()).unwrap_or_default();
    let bytes: Vec<u8> = latin1.chars().map(|character| character as u32 as u8).collect();
    decoded_words(&String::from_utf8_lossy(&bytes))
}

/// A field's text on one line, as FF writes a subject: each line break a space.
fn one_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

/// Whether a field's text needs encoded words: a character beyond ASCII, or a control but a tab.
fn needs_words(text: &str) -> bool {
    text.chars().any(|character| !character.is_ascii() || (character.is_ascii_control() && character != '\t'))
}

/// A text as RFC 2047's encoded words, in base64, each whole characters of 36 bytes at most.
fn encoded_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut chunk = String::new();
    for character in text.chars() {
        if chunk.len() + character.len_utf8() > WORD_BYTES {
            words.push(std::mem::take(&mut chunk));
        }
        chunk.push(character);
    }
    words.push(chunk);
    words.into_iter().map(|chunk| format!("=?UTF-8?B?{}?=", STANDARD.encode(chunk))).collect()
}

/// A display name as FF writes it: as it is of letters, digits and spaces; quoted with other printable characters;
/// else as encoded words.
fn display_name(name: &str) -> String {
    if name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | ' ')) {
        name.to_owned()
    } else if name.chars().all(|character| (' '..='~').contains(&character)) {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        encoded_words(name).join(" ")
    }
}

/// A header field, its items folded onto lines of 76 characters where they allow it.
fn field(name: &str, items: &[String], separator: &str) -> String {
    let mut written = format!("{name}: ");
    let mut line = written.len();
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            written.push_str(separator.trim_end());
            line += separator.trim_end().len();
            if line + 1 + item.len() > LINE {
                written.push_str("\r\n ");
                line = 1;
            } else {
                written.push(' ');
                line += 1;
            }
        }
        written.push_str(item);
        line += item.len();
    }
    written.push_str("\r\n");
    written
}

/// A text field: as it is, or as encoded words.
fn text_field(name: &str, text: &str) -> String {
    let text = one_line(text);
    match needs_words(&text) {
        true => field(name, &encoded_words(&text), " "),
        false => format!("{name}: {text}\r\n"),
    }
}

/// An address field's mailboxes, as FF writes them: the address alone, or after its name.
fn address_items(lists: &[String]) -> Vec<String> {
    lists
        .iter()
        .flat_map(|list| mailboxes(list))
        .filter(|mailbox| !mailbox.address.is_empty())
        .map(|mailbox| match mailbox.name.is_empty() {
            true => mailbox.address,
            false => format!("{} <{}>", display_name(&mailbox.name), mailbox.address),
        })
        .collect()
}

/// A body as FF sends it: 7 bits as it is when it is ASCII in lines of 76 characters at most, each line break CRLF;
/// else quoted-printable. Its transfer encoding, and its text.
fn body(text: &str) -> (&'static str, String) {
    let lines: Vec<&str> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    let plain = lines.iter().all(|line| {
        line.len() <= LINE
            && line
                .chars()
                .all(|character| character.is_ascii() && (!character.is_ascii_control() || character == '\t'))
    });
    if plain {
        return ("7bit", lines.join("\r\n"));
    }
    let encoded: Vec<String> = lines.iter().map(|line| quoted_printable_line(line.as_bytes())).collect();
    ("quoted-printable", encoded.join("\r\n"))
}

/// A line as quoted-printable writes it, a soft break before 76 characters.
fn quoted_printable_line(line: &[u8]) -> String {
    let mut written = String::new();
    let mut width = 0;
    for (index, &byte) in line.iter().enumerate() {
        let last = index + 1 == line.len();
        let token = match byte {
            b' ' | b'\t' if !last => (byte as char).to_string(),
            33..=126 if byte != b'=' => (byte as char).to_string(),
            _ => format!("={byte:02X}"),
        };
        if width + token.len() > LINE - 1 {
            written.push_str("=\r\n");
            width = 0;
        }
        written.push_str(&token);
        width += token.len();
    }
    written
}

/// A body part: its type, its transfer encoding, then its text.
fn part(media_type: &str, text: &str) -> String {
    let (encoding, written) = body(text);
    format!("Content-Type: {media_type}; charset=utf-8\r\nContent-Transfer-Encoding: {encoding}\r\n\r\n{written}")
}

/// Simple content made into MIME, as FF makes it: the request's sender and lists, its subject, its own headers, its
/// ID at the SES endpoint's host and the time; multipart when it has both bodies, the text first.
fn compose_simple(request: &SendRequest, simple: &Simple, id: &str, host: &str, at: Millis) -> Vec<u8> {
    let mut head = String::new();
    head.push_str(&field(
        "From",
        &address_items(std::slice::from_ref(request.from.as_ref().unwrap_or(&String::new()))),
        ",",
    ));
    for (name, list) in [("To", &request.to), ("Cc", &request.cc), ("Reply-To", &request.reply_to)] {
        let items = address_items(list);
        if !items.is_empty() {
            head.push_str(&field(name, &items, ","));
        }
    }
    head.push_str(&text_field("Subject", &simple.subject));
    for (name, value) in &simple.headers {
        head.push_str(&text_field(name, value));
    }
    head.push_str(&format!("Message-ID: <{id}@{host}>\r\nDate: {}\r\nMIME-Version: 1.0\r\n", mail_date(at)));
    let message = match (&simple.text, &simple.html) {
        (Some(text), Some(html)) => {
            let mut random = [0u8; 12];
            let _ = getrandom::fill(&mut random);
            let boundary: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let boundary = format!("--_ff-local_{boundary}");
            format!(
                "{head}Content-Type: multipart/alternative;\r\n boundary=\"{boundary}\"\r\n\r\n--{boundary}\r\n{}\r\n--{boundary}\r\n{}\r\n--{boundary}--\r\n",
                part("text/plain", text),
                part("text/html", html)
            )
        }
        (Some(text), None) => format!("{head}{}\r\n", part("text/plain", text)),
        (None, Some(html)) => format!("{head}{}\r\n", part("text/html", html)),
        (None, None) => format!("{head}\r\n"),
    };
    message.into_bytes()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::dates::iso;

    /// The backend's table of SendEmail's cases.
    fn table() -> Value {
        serde_json::from_str(include_str!("../../../BE/src/email/send-email-examples.json")).unwrap()
    }

    fn cases<'a>(table: &'a Value, pointer: &str) -> &'a Vec<Value> {
        table.pointer(pointer).and_then(Value::as_array).unwrap()
    }

    /// A case's request as a client sends it: `manyTo` made that many recipients, a raw message's text in base64.
    fn sent(request: &Value) -> Value {
        let mut request = request.clone();
        if let Some(many) = request.pointer("/Destination/manyTo").and_then(Value::as_u64) {
            let to: Vec<String> = (1..=many).map(|at| format!("r{at}@example.tn")).collect();
            request["Destination"] = json!({ "ToAddresses": to });
        }
        if let Some(message) = request.pointer("/Content/Raw/message").and_then(Value::as_str) {
            request["Content"]["Raw"] = json!({ "Data": STANDARD.encode(message) });
        }
        request
    }

    /// A message as a reader shows it: its fields decoded, by their names in lower case, its type, and its parts'
    /// types and bodies, their line breaks `\n`, the last dropped.
    fn read_message(message: &[u8]) -> (BTreeMap<String, String>, String, Vec<(String, String)>) {
        let (fields, end) = header_of(message);
        let type_of = |fields: &[(String, String)]| {
            let value = fields.iter().find(|(name, _)| name == "content-type").map_or("text/plain", |(_, value)| value);
            value.split(';').next().unwrap_or_default().trim().to_lowercase()
        };
        let decoded_body = |fields: &[(String, String)], body: &[u8]| {
            let encoding = fields
                .iter()
                .find(|(name, _)| name == "content-transfer-encoding")
                .map(|(_, value)| value.to_lowercase());
            let bytes = match encoding.as_deref() {
                Some("quoted-printable") => quoted_printable_decode(&String::from_utf8_lossy(body)),
                Some("base64") => STANDARD.decode(String::from_utf8_lossy(body).replace(['\r', '\n'], "")).unwrap(),
                _ => body.to_vec(),
            };
            String::from_utf8(bytes).unwrap().replace("\r\n", "\n").trim_end_matches('\n').to_owned()
        };
        let shown = |value: &str| {
            let bytes: Vec<u8> = value.chars().map(|character| character as u32 as u8).collect();
            decoded_words(&String::from_utf8(bytes).unwrap())
        };
        let media_type = type_of(&fields);
        let parts = match fields
            .iter()
            .find(|(name, _)| name == "content-type")
            .and_then(|(_, value)| value.split_once("boundary=\""))
        {
            Some((_, boundary)) => {
                let boundary = format!("--{}", boundary.trim_end_matches('"'));
                let text = String::from_utf8_lossy(&message[end..]).into_owned();
                let pieces: Vec<&str> = text.split(&boundary).collect();
                pieces[1..pieces.len() - 1]
                    .iter()
                    .map(|piece| {
                        let piece = piece.trim_start_matches("\r\n").strip_suffix("\r\n").unwrap_or(piece);
                        let (part_fields, part_end) = header_of(piece.as_bytes());
                        (type_of(&part_fields), decoded_body(&part_fields, &piece.as_bytes()[part_end..]))
                    })
                    .collect()
            }
            None => vec![(media_type.clone(), decoded_body(&fields, &message[end..]))],
        };
        (fields.iter().map(|(name, value)| (name.clone(), shown(value))).collect(), media_type, parts)
    }

    struct Folder {
        mail: Mail,
        said: Arc<Mutex<Vec<String>>>,
        folder: tempfile::TempDir,
    }

    const NOW: Millis = 1_793_347_200_000;

    fn mail() -> Folder {
        let folder = tempfile::tempdir().unwrap();
        let said = Arc::new(Mutex::new(Vec::new()));
        let to_say = Arc::clone(&said);
        let mail = Mail::new(
            &folder.path().join("mail"),
            Arc::new(|| NOW),
            Arc::new(move |line: &str| to_say.lock().unwrap().push(line.to_owned())),
        );
        Folder { mail, said, folder }
    }

    fn key() -> Key {
        Key { id: "AKFFLOCAL0000000TEST".into(), secret: "local-secret".into() }
    }

    fn post(body: &Value) -> Request {
        Request {
            method: "POST".into(),
            target: "/v2/email/outbound-emails".into(),
            protocol: "HTTP/1.1".into(),
            headers: vec![("host".into(), "127.0.0.1:3700".into()), ("content-type".into(), "application/json".into())],
            body: body.to_string().into_bytes(),
        }
    }

    fn refusal(response: &Response) -> (u16, String, String) {
        let kind = response
            .headers
            .iter()
            .find(|(name, _)| name == "x-amzn-ErrorType")
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        (
            response.status,
            kind.split(':').next().unwrap_or_default().to_owned(),
            body["message"].as_str().unwrap_or_default().to_owned(),
        )
    }

    #[test]
    fn reads_address_lists_and_senders_as_ff_reads_them() {
        let table = table();
        for case in cases(&table, "/addresses") {
            let list = case["list"].as_str().unwrap();
            let expected: Vec<Option<String>> = serde_json::from_value(case["addresses"].clone()).unwrap();
            assert_eq!(addresses_of(list), expected, "{list}");
        }
        for case in cases(&table, "/senders") {
            let text = case["text"].as_str().unwrap();
            assert_eq!(sender_of(text), case["sender"].as_str().map(str::to_owned), "{text}");
        }
    }

    #[test]
    fn takes_a_requests_own_headers_not_those_ses_writes_itself() {
        let table = table();
        for case in cases(&table, "/headers") {
            let (name, value) = (case["name"].as_str().unwrap(), case["value"].as_str().unwrap());
            assert_eq!(header_problem(name, value), case["problem"].as_str().map(str::to_owned), "{name}");
        }
    }

    #[test]
    fn reads_a_raw_messages_parties_and_takes_its_bcc_out() {
        let table = table();
        for case in cases(&table, "/raw") {
            let message = case["message"].as_str().unwrap().as_bytes();
            let parties: Parties = serde_json::from_value(case["parties"].clone()).unwrap();
            assert_eq!(raw_parties(message), parties, "{}", case["title"]);
            assert_eq!(
                String::from_utf8(without_bcc(message)).unwrap(),
                case["withoutBcc"].as_str().unwrap(),
                "{}",
                case["title"]
            );
        }
    }

    #[test]
    fn makes_simple_content_the_message_a_reader_shows_as_ffs() {
        let table = table();
        for case in cases(&table, "/composed") {
            let content = &case["content"];
            let strings = |name: &str| -> Vec<String> { serde_json::from_value(content[name].clone()).unwrap() };
            let request = SendRequest {
                from: content["from"].as_str().map(str::to_owned),
                to: strings("to"),
                cc: strings("cc"),
                bcc: Vec::new(),
                reply_to: strings("replyTo"),
                content: Content::Raw(Vec::new()),
            };
            let simple = Simple {
                subject: content["subject"].as_str().unwrap().to_owned(),
                text: content["text"].as_str().map(str::to_owned),
                html: content["html"].as_str().map(str::to_owned),
                headers: content["headers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|header| {
                        (header["name"].as_str().unwrap().to_owned(), header["value"].as_str().unwrap().to_owned())
                    })
                    .collect(),
            };
            // Each case's time is the tests' own.
            assert_eq!(iso(NOW), case["at"].as_str().unwrap());
            let message = compose_simple(&request, &simple, "ID", "HOST", NOW);
            let (fields, media_type, parts) = read_message(&message);
            let title = case["title"].as_str().unwrap();
            for (name, value) in case["fields"].as_object().unwrap() {
                let expected = value.as_str().unwrap().replace("{id}", "ID").replace("{host}", "HOST");
                assert_eq!(fields.get(name), Some(&expected), "{title}: {name}");
            }
            for absent in case["absent"].as_array().unwrap() {
                assert!(!fields.contains_key(absent.as_str().unwrap()), "{title}: {absent}");
            }
            assert_eq!(media_type, case["type"].as_str().unwrap(), "{title}");
            let expected: Vec<(String, String)> = case["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|part| (part["type"].as_str().unwrap().to_owned(), part["body"].as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(parts, expected, "{title}");
            // Each line of 78 characters at most, as a mail server takes it, but where one word is longer.
            let text = String::from_utf8(message).unwrap();
            assert!(text.lines().all(|line| line.len() <= 78 || !line.contains(' ')), "{title}:\n{text}");
        }
    }

    #[test]
    fn routes_each_request_as_ff_does() {
        let table = table();
        for case in cases(&table, "/routes") {
            let (method, path) = (case["method"].as_str().unwrap(), case["path"].as_str().unwrap());
            let route = route_of(method, path);
            assert_eq!(route.as_ref().map(|(operation, _)| *operation), case["operation"].as_str(), "{method} {path}");
            assert_eq!(route.and_then(|(_, name)| name), case["name"].as_str().map(str::to_owned), "{method} {path}");
        }
    }

    #[test]
    fn refuses_a_request_at_the_first_of_ffs_checks_in_its_words_and_keeps_nothing() {
        let table = table();
        let mail = mail();
        for case in cases(&table, "/requests/refused") {
            let response = mail.mail.answer(&post(&sent(&case["request"])), &key(), |_| {});
            let expected = (
                case["status"].as_u64().unwrap() as u16,
                case["type"].as_str().unwrap().to_owned(),
                case["message"].as_str().unwrap().to_owned(),
            );
            assert_eq!(refusal(&response), expected, "{}", case["title"]);
        }
        assert!(kept_in(&mail.folder.path().join("mail")).unwrap().is_empty());
    }

    #[test]
    fn keeps_a_message_taken_with_its_envelope_and_says_it() {
        let table = table();
        for case in cases(&table, "/requests/taken") {
            let mail = mail();
            let response = mail.mail.answer(&post(&sent(&case["request"])), &key(), |_| {});
            assert_eq!(response.status, 200, "{}: {}", case["title"], String::from_utf8_lossy(&response.body));
            let id = serde_json::from_slice::<Value>(&response.body).unwrap()["MessageId"].as_str().unwrap().to_owned();
            let kept = kept_in(&mail.folder.path().join("mail")).unwrap();
            let [one] = kept.as_slice() else { panic!("{}: {kept:?}", case["title"]) };
            let recipients: Vec<String> = serde_json::from_value(case["recipients"].clone()).unwrap();
            assert_eq!(
                (&one.message_id, &one.from, &one.recipients),
                (&id, &case["from"].as_str().unwrap().to_owned(), &recipients),
                "{}",
                case["title"]
            );
            assert_eq!(one.sent_at, iso_millis(NOW));
            let message = std::fs::read(&one.file).unwrap();
            assert_eq!(one.bytes, message.len());
            // No recipient reads the Bcc: the envelope alone names them.
            assert!(header_of(&message).0.iter().all(|(name, _)| name != "bcc"), "{}", case["title"]);
            let said = mail.said.lock().unwrap();
            assert_eq!(said.len(), 1);
            assert!(
                said[0].starts_with(&format!("A message from {} to {}", one.from, recipients.join(", "))),
                "{}",
                said[0]
            );
            assert!(said[0].ends_with(&format!("kept in {}, not sent", one.file)), "{}", said[0]);
        }
    }

    #[test]
    fn a_simple_message_is_kept_as_a_reader_opens_it_and_a_raw_one_as_it_came_but_its_bcc() {
        let mail = mail();
        let simple = json!({
            "FromEmailAddress": "Boutique Ana <orders@shop.example.tn>",
            "Destination": { "ToAddresses": ["client@example.tn"], "BccAddresses": ["audit@example.tn"] },
            "Content": { "Simple": { "Subject": { "Data": "Votre reçu" }, "Body": { "Text": { "Data": "Merci" }, "Html": { "Data": "<p>Merci</p>" } } } }
        });
        assert_eq!(mail.mail.answer(&post(&simple), &key(), |_| {}).status, 200);
        let raw = "From: Shop <news@shop.example.tn>\r\nTo: orders@example.tn\r\nBcc: audit@example.tn\r\nSubject: =?UTF-8?Q?Re=C3=A7u?=\r\nMessage-ID: <raw@shop.example.tn>\r\n\r\nHello\r\n";
        let request = json!({ "Content": { "Raw": { "Data": STANDARD.encode(raw) } } });
        assert_eq!(mail.mail.answer(&post(&request), &key(), |_| {}).status, 200);

        let kept = kept_in(&mail.folder.path().join("mail")).unwrap();
        assert_eq!(kept.iter().map(|kept| kept.subject.as_str()).collect::<Vec<_>>(), ["Votre reçu", "Reçu"]);
        let (fields, media_type, parts) = read_message(&std::fs::read(&kept[0].file).unwrap());
        assert_eq!(
            (fields["subject"].as_str(), fields["to"].as_str(), media_type.as_str(), parts.len()),
            ("Votre reçu", "client@example.tn", "multipart/alternative", 2)
        );
        assert_eq!(fields["message-id"], format!("<{}@{MESSAGE_HOST}>", kept[0].message_id));
        assert_eq!(kept[0].recipients, ["client@example.tn", "audit@example.tn"]);
        assert_eq!(std::fs::read_to_string(&kept[1].file).unwrap(), raw.replace("Bcc: audit@example.tn\r\n", ""));
        // Its files are named by the time it was sent, then its ID, so that they list in that order.
        let name = Path::new(&kept[0].file).file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, format!("{}-{}.eml", iso_millis(NOW).replace(['-', ':', '.'], ""), kept[0].message_id));
    }

    #[test]
    fn a_signed_request_is_checked_against_the_local_key_and_ffs_other_operations_are_refused_saying_so() {
        let mail = mail();
        let signed = |key: &Key, target: &str, method: &str| {
            use crate::sigv4::{Credentials, Signable, amz_date, authorization, sha256_hex};
            let date = amz_date(std::time::UNIX_EPOCH + std::time::Duration::from_millis(NOW as u64));
            let headers =
                vec![("host".to_owned(), "127.0.0.1:3700".to_owned()), ("x-amz-date".to_owned(), date.clone())];
            let credentials = Credentials {
                access_key_id: key.id.clone(),
                secret_access_key: key.secret.clone(),
                region: "tn-tunis-1".into(),
            };
            let payload = sha256_hex(b"");
            let signable = Signable { method, path: target, query: &[], headers: &headers, payload_sha256: &payload };
            let mut headers = headers.clone();
            headers.push(("authorization".to_owned(), authorization(&credentials, &signable, &date, SERVICE)));
            Request {
                method: method.into(),
                target: target.into(),
                protocol: "HTTP/1.1".into(),
                headers,
                body: Vec::new(),
            }
        };
        let account = signed(&key(), "/v2/email/account", "GET");
        assert!(is_ses(&account));
        assert_eq!(
            refusal(&mail.mail.answer(&account, &key(), |_| {})),
            (501, "NotImplemented".into(), "ff local keeps the mail its functions send, and answers SendEmail alone: GetAccount is FF's, whose account has identities, quotas and a suppression list".into())
        );
        let other = Key { id: "AKFFOTHER00000000000".into(), secret: "other".into() };
        let others = Mutex::new(Vec::new());
        let answer = mail.mail.answer(&signed(&other, "/v2/email/account", "GET"), &key(), |id| {
            others.lock().unwrap().push(id.to_owned())
        });
        assert_eq!(refusal(&answer).1, "UnrecognizedClientException");
        assert_eq!(*others.lock().unwrap(), [other.id.as_str()]);
        let mut forged = signed(&key(), "/v2/email/account", "GET");
        forged.target = "/v2/email/identities".into();
        assert_eq!(refusal(&mail.mail.answer(&forged, &key(), |_| {})).1, "SignatureDoesNotMatch");
        let unknown = signed(&key(), "/v2/email/configuration-sets", "GET");
        assert_eq!(
            refusal(&mail.mail.answer(&unknown, &key(), |_| {})).2,
            "ff local's mail answers SES v2's SendEmail alone, POST /v2/email/outbound-emails, not GET /v2/email/configuration-sets"
        );
        let mut not_json = post(&json!({}));
        not_json.body = b"Hello".to_vec();
        assert_eq!(refusal(&mail.mail.answer(&not_json, &key(), |_| {})).2, "The request body is not JSON.");
        not_json.body = b"[]".to_vec();
        assert_eq!(refusal(&mail.mail.answer(&not_json, &key(), |_| {})).2, "The request body must be a JSON object.");
        assert_eq!(refusal(&unreadable(true)).0, 413);
    }
}

//! `ff url` and `ff domains`: a function's web address, as AWS Lambda's function URLs, and the
//! account's own domains for it, proved by DNS; `ff invoke --http`, a request through it.

use std::io::Read;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::Context;
use crate::api::types::{Function, function_named};
use crate::api::{Call, Client};
use crate::cli::{Format, UrlAuth};
use crate::config::Settings;
use crate::error::{Error, Kind};
use crate::table::{table, time};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionUrl {
    pub function_url: String,
    /// The alias whose calls it makes; none for `$LATEST`'s URL. Absent from an API before aliases.
    #[serde(default)]
    pub alias: Option<String>,
    pub auth_type: String,
    pub cors: Option<Value>,
    /// `BUFFERED`, or `RESPONSE_STREAM` for a URL that streams its answer.
    #[serde(default)]
    pub invoke_mode: Option<String>,
    pub created_at: String,
}

/// A domain of the account's, a function URL's or a site's, as the API answers it.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    pub domain: String,
    pub status: String,
    records: Records,
    pub checked_at: Option<String>,
    pub check_error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Records {
    cname: Vec<Record>,
    txt: Vec<Record>,
}

#[derive(Deserialize, Serialize)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    value: String,
}

fn auth_type(auth: UrlAuth) -> &'static str {
    match auth {
        UrlAuth::None => "NONE",
        UrlAuth::Key => "AWS_IAM",
    }
}

/// Who may call it, in words.
fn callers(auth_type: &str) -> &'static str {
    if auth_type == "NONE" {
        "anyone may call it"
    } else {
        "callers need an API key of the account with functions:invoke"
    }
}

/// The URL a command names: the function's, `$LATEST`'s, or with `--alias` an alias's, which every route of a URL
/// and of its domains takes as `?qualifier=`, as Lambda's take `Qualifier`.
struct UrlTarget<'a> {
    client: Client,
    function: Function,
    name: &'a str,
    alias: Option<&'a str>,
}

impl<'a> UrlTarget<'a> {
    fn open(name: &'a str, alias: Option<&'a str>, context: &Context) -> Result<Self, Error> {
        Self::open_with(&context.settings()?, name, alias)
    }

    fn open_with(settings: &Settings, name: &'a str, alias: Option<&'a str>) -> Result<Self, Error> {
        let client = Client::new(settings)?;
        let function = function_named(&client, name)?;
        Ok(UrlTarget { client, function, name, alias })
    }

    /// `/functions/<id>/url` and what follows, for the alias when there is one.
    fn call(&self, make: fn(String) -> Call, rest: &str) -> Call {
        let call = make(format!("/functions/{}/url{rest}", self.function.id));
        match self.alias {
            Some(alias) => call.query("qualifier", alias),
            None => call,
        }
    }

    fn call_with(&self, make: fn(String, Value) -> Call, rest: &str, body: Value) -> Call {
        let call = make(format!("/functions/{}/url{rest}", self.function.id), body);
        match self.alias {
            Some(alias) => call.query("qualifier", alias),
            None => call,
        }
    }

    /// `orders`, or `orders:live`, as Lambda writes a qualified name.
    fn label(&self) -> String {
        match self.alias {
            Some(alias) => format!("{}:{alias}", self.name),
            None => self.name.to_owned(),
        }
    }

    /// The flags that name it again in a hint: `orders`, or `orders --alias live`.
    fn args(&self) -> String {
        match self.alias {
            Some(alias) => format!("{} --alias {alias}", self.name),
            None => self.name.to_owned(),
        }
    }

    /// Its URL, or none: a 404 for it is the absence of one.
    fn url(&self) -> Result<Option<FunctionUrl>, Error> {
        self.client.json_if_any(&self.call(Call::get, ""))
    }

    fn no_url(&self) -> Error {
        Error::new(
            Kind::Failed,
            format!("{} has no URL: `ff url enable {} --auth none|key` gives it one", self.label(), self.args()),
        )
    }
}

/// CORS as the API takes it, Lambda's fields, from what the flags say.
pub fn cors(origins: &[String], methods: &[String], headers: &[String]) -> Option<Value> {
    if origins.is_empty() && methods.is_empty() && headers.is_empty() {
        return None;
    }
    let mut cors = Map::new();
    let list =
        |values: &[String]| Value::from(values.iter().map(|value| Value::from(value.as_str())).collect::<Vec<_>>());
    if !origins.is_empty() {
        cors.insert("allowOrigins".into(), list(origins));
    }
    if !methods.is_empty() {
        cors.insert(
            "allowMethods".into(),
            list(&methods.iter().map(|method| method.to_ascii_uppercase()).collect::<Vec<_>>()),
        );
    }
    if !headers.is_empty() {
        cors.insert("allowHeaders".into(), list(headers));
    }
    Some(Value::Object(cors))
}

pub fn show(name: &str, alias: Option<&str>, context: &Context) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    let url = target.url()?.ok_or_else(|| target.no_url())?;
    let domains: Vec<Domain> = target.client.json(&target.call(Call::get, "/domains"))?;
    let document = json!({ "url": url, "domains": domains });
    context.out.result(&document, || {
        let mut lines =
            vec![url.function_url.clone(), format!("{}; made {} UTC", callers(&url.auth_type), time(&url.created_at))];
        if let Some(cors) = &url.cors {
            lines.push(format!("CORS: {cors}"));
        }
        for domain in &domains {
            lines.push(format!("domain {}: {}", domain.domain, domain.status));
        }
        lines.join("\n")
    })
}

pub fn enable(
    name: &str,
    alias: Option<&str>,
    auth: Option<UrlAuth>,
    cors: Option<Value>,
    context: &Context,
) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    let (url, action) = match target.url()? {
        None => {
            let auth = auth.ok_or_else(|| {
                Error::usage("Say who may call the new address: --auth none (anyone), or --auth key (the account's API keys with functions:invoke)")
            })?;
            let mut body = json!({ "authType": auth_type(auth) });
            if let Some(cors) = cors {
                body["cors"] = cors;
            }
            (target.client.json::<FunctionUrl>(&target.call_with(Call::post, "", body))?, "has a URL")
        }
        Some(url) => {
            let mut body = Map::new();
            if let Some(auth) = auth {
                body.insert("authType".into(), auth_type(auth).into());
            }
            if let Some(cors) = cors {
                body.insert("cors".into(), cors);
            }
            if body.is_empty() {
                (url, "has its URL already")
            } else {
                (
                    target.client.json::<FunctionUrl>(&target.call_with(Call::put, "", Value::Object(body)))?,
                    "has its URL changed",
                )
            }
        }
    };
    context
        .out
        .result(&url, || format!("{} {action}: {}\n{}", target.label(), url.function_url, callers(&url.auth_type)))
}

pub fn disable(name: &str, alias: Option<&str>, yes: bool, context: &Context) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    let url = target.url()?.ok_or_else(|| target.no_url())?;
    if !super::functions::confirmed(
        "ff url disable",
        &format!("Delete {}? It stops answering at once, and a new URL would have another address", url.function_url),
        yes,
    )? {
        return context.out.result(&json!({ "deleted": false }), || "Nothing deleted".to_owned());
    }
    target.client.done(&target.call(Call::delete, ""))?;
    context.out.result(&json!({ "deleted": true, "functionUrl": url.function_url }), || {
        format!("{}'s URL deleted: {} answers 404", target.label(), url.function_url)
    })
}

/// The records to make at the domain's DNS provider: one way or the other.
pub fn records_text(domain: &Domain) -> String {
    let line = |record: &Record| format!("  {} {} {}", record.kind, record.name, record.value);
    let mut lines = vec![format!("{}: {}", domain.domain, domain.status)];
    if domain.status != "verified" {
        if !domain.records.cname.is_empty() {
            lines.push("make, for a subdomain:".to_owned());
            lines.extend(domain.records.cname.iter().map(line));
        }
        if !domain.records.txt.is_empty() {
            lines.push(
                if domain.records.cname.is_empty() { "make:" } else { "or, for any domain, an apex too:" }.to_owned(),
            );
            lines.extend(domain.records.txt.iter().map(line));
        }
        if let Some(error) = &domain.check_error {
            lines.push(format!("last check: {error}"));
        }
    }
    lines.join("\n")
}

pub fn domains_list(name: &str, alias: Option<&str>, context: &Context) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    let domains: Vec<Domain> = target.client.json(&target.call(Call::get, "/domains"))?;
    context.out.result(&domains, || {
        if domains.is_empty() {
            return format!(
                "{}'s URL has no domain of its own: `ff domains add {} <domain>` adds one",
                target.label(),
                target.args()
            );
        }
        let rows: Vec<Vec<String>> = domains
            .iter()
            .map(|domain| {
                vec![
                    domain.domain.clone(),
                    domain.status.clone(),
                    domain.checked_at.as_deref().map(time).unwrap_or_default(),
                    domain.check_error.clone().unwrap_or_default(),
                ]
            })
            .collect();
        table(&["DOMAIN", "STATUS", "CHECKED (UTC)", "LAST CHECK'S PROBLEM"], &rows)
    })
}

pub fn domains_add(name: &str, alias: Option<&str>, domain: &str, context: &Context) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    let added: Domain = target.client.json(&target.call_with(Call::post, "/domains", json!({ "domain": domain })))?;
    context.out.result(&added, || {
        format!("{}\nthen: ff domains verify {} {}", records_text(&added), target.args(), added.domain)
    })
}

pub fn domains_verify(name: &str, alias: Option<&str>, domain: &str, context: &Context) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    let checked: Domain =
        target.client.json(&target.call_with(Call::post, &format!("/domains/{}/verify", encode(domain)), json!({})))?;
    context.out.result(&checked, || records_text(&checked))
}

pub fn domains_remove(
    name: &str,
    alias: Option<&str>,
    domain: &str,
    yes: bool,
    context: &Context,
) -> Result<(), Error> {
    let target = UrlTarget::open(name, alias, context)?;
    if !super::functions::confirmed(
        "ff domains remove",
        &format!("Remove {domain} from {}'s URL? It stops answering there", target.label()),
        yes,
    )? {
        return context.out.result(&json!({ "removed": false }), || "Nothing removed".to_owned());
    }
    target.client.done(&target.call(Call::delete, &format!("/domains/{}", encode(domain))))?;
    context.out.result(&json!({ "removed": true, "domain": domain }), || {
        format!("{domain} removed from {}'s URL", target.label())
    })
}

/// A domain in a path: its letters, digits, dots and hyphens need no escaping; anything else is
/// percent-encoded, which the API then refuses as no domain.
pub fn encode(domain: &str) -> String {
    domain
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// A request through a function's URL: its method, its target, its headers.
pub type HttpRequest = (String, String, Vec<(String, String)>);

/// `METHOD /path?query`, and a header's `name: value`.
pub fn http_request(method: &str, target: &str, headers: &[String]) -> Result<HttpRequest, Error> {
    let method = method.to_ascii_uppercase();
    if !method.bytes().all(|byte| byte.is_ascii_uppercase()) || method.is_empty() {
        return Err(Error::usage(format!("--http takes a method, such as GET or POST: {method}")));
    }
    if !target.starts_with('/') {
        return Err(Error::usage(format!(
            "--http takes a path after the method, such as /orders?status=new: {target}"
        )));
    }
    let headers = headers
        .iter()
        .map(|header| match header.split_once(':') {
            Some((name, value)) if !name.trim().is_empty() => Ok((name.trim().to_owned(), value.trim().to_owned())),
            _ => Err(Error::usage(format!("--header takes \"name: value\": {header}"))),
        })
        .collect::<Result<_, _>>()?;
    Ok((method, target.to_owned(), headers))
}

/// A request to the function's URL, as a browser or a webhook would make it, and the answer as it
/// comes: any status is the function's answer. The account's API key goes with it when the URL
/// takes one. A host under `localhost` is this machine's, whatever the system's resolver says. An alias's call goes
/// through the alias's URL.
pub fn invoke_http(
    name: &str,
    alias: Option<&str>,
    method: &str,
    target: &str,
    headers: &[String],
    data: Option<&str>,
    context: &Context,
) -> Result<(), Error> {
    let (method, path, headers) = http_request(method, target, headers)?;
    let settings = context.settings()?;
    let target = UrlTarget::open_with(&settings, name, alias)?;
    let function = &target.function;
    let url = target.url()?.ok_or_else(|| target.no_url())?;
    let address = format!("{}{}", url.function_url.trim_end_matches('/'), path);
    let uri: ureq::http::Uri =
        address.parse().map_err(|_| Error::new(Kind::Failed, format!("The URL {address} doesn't parse")))?;
    let authority = uri.authority().map(|authority| authority.as_str().to_owned()).unwrap_or_default();
    let local = uri.host().is_some_and(|host| host.ends_with(".localhost"));
    let connect_to = if local {
        address.replacen(
            &authority,
            &format!("127.0.0.1{}", uri.port().map(|port| format!(":{port}")).unwrap_or_default()),
            1,
        )
    } else {
        address.clone()
    };

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(u64::from(function.timeout) * 2 + 100)))
        .user_agent(format!("ff-cli/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut request = ureq::http::Request::builder().method(method.as_str()).uri(&connect_to);
    if local {
        request = request.header("host", &authority);
    }
    if url.auth_type != "NONE"
        && let Some(token) = &settings.token
    {
        request = request.header("authorization", format!("Bearer {}", token.value.secret()));
    }
    for (header, value) in &headers {
        request = request.header(header.as_str(), value.as_str());
    }
    let body = data.map(super::invoke::raw_data).transpose()?.unwrap_or_default();
    let request = request.body(body).map_err(|error| Error::usage(format!("The request can't be made: {error}")))?;
    let mut response =
        agent.run(request).map_err(|error| Error::new(Kind::Failed, format!("Couldn't reach {address}: {error}")))?;

    let status = response.status().as_u16();
    let answer_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value.to_str().unwrap_or("").to_owned()))
        .collect();
    let mut text = String::new();
    response
        .body_mut()
        .as_reader()
        .read_to_string(&mut text)
        .map_err(|error| Error::new(Kind::Failed, format!("The answer was cut short: {error}")))?;
    let document = json!({ "status": status, "headers": answer_headers.iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(), "body": text });
    if context.out.format == Format::Json {
        return context.out.result(&document, String::new);
    }
    context.out.result(&document, || {
        let mut lines = vec![format!("HTTP {status}")];
        if context.out.verbose {
            lines.extend(answer_headers.iter().map(|(name, value)| format!("{name}: {value}")));
        }
        lines.push(String::new());
        lines.push(text.clone());
        lines.join("\n")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_comes_from_the_flags_in_lambdas_fields() {
        assert_eq!(cors(&[], &[], &[]), None);
        assert_eq!(
            cors(&["https://shop.example.tn".into()], &["get".into(), "POST".into()], &["content-type".into()]),
            Some(
                json!({ "allowOrigins": ["https://shop.example.tn"], "allowMethods": ["GET", "POST"], "allowHeaders": ["content-type"] })
            )
        );
    }

    #[test]
    fn a_request_is_a_method_a_path_and_headers() {
        let (method, target, headers) =
            http_request("post", "/orders?status=new", &["Content-Type: application/json".into()]).unwrap();

        assert_eq!((method.as_str(), target.as_str()), ("POST", "/orders?status=new"));
        assert_eq!(headers, [("Content-Type".to_owned(), "application/json".to_owned())]);
        assert_eq!(http_request("GET", "orders", &[]).unwrap_err().exit_code(), 2);
        assert_eq!(http_request("GET", "/", &["nocolon".into()]).unwrap_err().exit_code(), 2);
        assert_eq!(http_request("G3T", "/", &[]).unwrap_err().exit_code(), 2);
    }

    #[test]
    fn a_domain_in_a_path_is_escaped_beyond_its_usual_letters() {
        assert_eq!(encode("shop.example.tn"), "shop.example.tn");
        assert_eq!(encode("a/b"), "a%2Fb");
    }

    #[test]
    fn the_records_say_what_to_make_until_the_domain_is_verified() {
        let domain = |status: &str| Domain {
            domain: "shop.example.tn".into(),
            status: status.into(),
            records: Records {
                cname: vec![Record {
                    kind: "CNAME".into(),
                    name: "shop.example.tn".into(),
                    value: "abc.fn.ff.tn".into(),
                }],
                txt: vec![Record {
                    kind: "TXT".into(),
                    name: "_ff-verify.shop.example.tn".into(),
                    value: "ff-verify=t0k3n".into(),
                }],
            },
            checked_at: None,
            check_error: Some("no CNAME yet".into()),
        };

        assert_eq!(
            records_text(&domain("pending")),
            "shop.example.tn: pending\nmake, for a subdomain:\n  CNAME shop.example.tn abc.fn.ff.tn\n\
             or, for any domain, an apex too:\n  TXT _ff-verify.shop.example.tn ff-verify=t0k3n\nlast check: no CNAME yet"
        );
        assert_eq!(records_text(&domain("verified")), "shop.example.tn: verified");
    }
}

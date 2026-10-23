//! `ff url` and `ff domains`: a function's web address, as AWS Lambda's function URLs, and the
//! account's own domains for it, proved by DNS; `ff invoke --http`, a request through it.

use std::io::Read;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::Context;
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::cli::{Format, UrlAuth};
use crate::error::{Error, Kind};
use crate::table::{table, time};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionUrl {
    pub function_url: String,
    pub auth_type: String,
    pub cors: Option<Value>,
    pub created_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Domain {
    domain: String,
    status: String,
    records: Records,
    checked_at: Option<String>,
    check_error: Option<String>,
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

/// The function's URL, or none: a 404 for its URL is the absence of one.
fn url_of(client: &Client, id: &str) -> Result<Option<FunctionUrl>, Error> {
    match client.json::<FunctionUrl>(&Call::get(format!("/functions/{id}/url"))) {
        Ok(url) => Ok(Some(url)),
        Err(error) if error.status == Some(404) => Ok(None),
        Err(error) => Err(error),
    }
}

fn no_url(name: &str) -> Error {
    Error::new(Kind::Failed, format!("{name} has no URL: `ff url enable {name} --auth none|key` gives it one"))
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

pub fn show(name: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let url = url_of(&client, &function.id)?.ok_or_else(|| no_url(name))?;
    let domains: Vec<Domain> = client.json(&Call::get(format!("/functions/{}/url/domains", function.id)))?;
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

pub fn enable(name: &str, auth: Option<UrlAuth>, cors: Option<Value>, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let existing = url_of(&client, &function.id)?;
    let path = format!("/functions/{}/url", function.id);
    let (url, action) = match existing {
        None => {
            let auth = auth.ok_or_else(|| {
                Error::new(Kind::Usage, "Say who may call the new address: --auth none (anyone), or --auth key (the account's API keys with functions:invoke)")
            })?;
            let mut body = json!({ "authType": auth_type(auth) });
            if let Some(cors) = cors {
                body["cors"] = cors;
            }
            (client.json::<FunctionUrl>(&Call::post(path, body))?, "has a URL")
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
                (client.json::<FunctionUrl>(&Call::put(path, Value::Object(body)))?, "has its URL changed")
            }
        }
    };
    context.out.result(&url, || format!("{name} {action}: {}\n{}", url.function_url, callers(&url.auth_type)))
}

pub fn disable(name: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let url = url_of(&client, &function.id)?.ok_or_else(|| no_url(name))?;
    if !super::functions::confirmed(
        "ff url disable",
        &format!("Delete {}? It stops answering at once, and a new URL would have another address", url.function_url),
        yes,
    )? {
        return context.out.result(&json!({ "deleted": false }), || "Nothing deleted".to_owned());
    }
    client.done(&Call::delete(format!("/functions/{}/url", function.id)))?;
    context.out.result(&json!({ "deleted": true, "functionUrl": url.function_url }), || {
        format!("{name}'s URL deleted: {} answers 404", url.function_url)
    })
}

/// The records to make at the domain's DNS provider: one way or the other.
fn records_text(domain: &Domain) -> String {
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

pub fn domains_list(name: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let domains: Vec<Domain> = client.json(&Call::get(format!("/functions/{}/url/domains", function.id)))?;
    context.out.result(&domains, || {
        if domains.is_empty() {
            return format!("{name}'s URL has no domain of its own: `ff domains add {name} <domain>` adds one");
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

pub fn domains_add(name: &str, domain: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let added: Domain =
        client.json(&Call::post(format!("/functions/{}/url/domains", function.id), json!({ "domain": domain })))?;
    context.out.result(&added, || format!("{}\nthen: ff domains verify {name} {}", records_text(&added), added.domain))
}

pub fn domains_verify(name: &str, domain: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    let checked: Domain = client
        .json(&Call::post(format!("/functions/{}/url/domains/{}/verify", function.id, encode(domain)), json!({})))?;
    context.out.result(&checked, || records_text(&checked))
}

pub fn domains_remove(name: &str, domain: &str, yes: bool, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, name)?;
    if !super::functions::confirmed(
        "ff domains remove",
        &format!("Remove {domain} from {name}'s URL? It stops answering there"),
        yes,
    )? {
        return context.out.result(&json!({ "removed": false }), || "Nothing removed".to_owned());
    }
    client.done(&Call::delete(format!("/functions/{}/url/domains/{}", function.id, encode(domain))))?;
    context.out.result(&json!({ "removed": true, "domain": domain }), || format!("{domain} removed from {name}'s URL"))
}

/// A domain in a path: its letters, digits, dots and hyphens need no escaping; anything else is
/// percent-encoded, which the API then refuses as no domain.
fn encode(domain: &str) -> String {
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
        return Err(Error::new(Kind::Usage, format!("--http takes a method, such as GET or POST: {method}")));
    }
    if !target.starts_with('/') {
        return Err(Error::new(
            Kind::Usage,
            format!("--http takes a path after the method, such as /orders?status=new: {target}"),
        ));
    }
    let headers = headers
        .iter()
        .map(|header| match header.split_once(':') {
            Some((name, value)) if !name.trim().is_empty() => Ok((name.trim().to_owned(), value.trim().to_owned())),
            _ => Err(Error::new(Kind::Usage, format!("--header takes \"name: value\": {header}"))),
        })
        .collect::<Result<_, _>>()?;
    Ok((method, target.to_owned(), headers))
}

/// A request to the function's URL, as a browser or a webhook would make it, and the answer as it
/// comes: any status is the function's answer. The account's API key goes with it when the URL
/// takes one. A host under `localhost` is this machine's, whatever the system's resolver says.
pub fn invoke_http(
    name: &str,
    method: &str,
    target: &str,
    headers: &[String],
    data: Option<&str>,
    context: &Context,
) -> Result<(), Error> {
    let (method, target, headers) = http_request(method, target, headers)?;
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let function = function_named(&client, name)?;
    let url = url_of(&client, &function.id)?.ok_or_else(|| no_url(name))?;
    let address = format!("{}{}", url.function_url.trim_end_matches('/'), target);
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
    let request =
        request.body(body).map_err(|error| Error::new(Kind::Usage, format!("The request can't be made: {error}")))?;
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

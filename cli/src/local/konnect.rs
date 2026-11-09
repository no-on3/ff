//! Konnect's stand-in, `ff local konnect`: Konnect's API as its documentation describes it, the payer's page at each
//! payment's `payUrl`, and the merchant's webhook called, so that a shop is tried on this machine, nothing paid and no
//! merchant's onboarding needed. Its payments are kept in memory, gone when it stops.
//!
//! Each answer names, in `x-ff-konnect-source`, the page and section of Konnect's documentation it follows, or says
//! that the documentation is silent there and what the stand-in does instead: an error's body, the payer's page.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use serde_json::{Map, Value, json};
use ureq::tls::{RootCerts, TlsConfig};

use super::http::{self, Answers, Request, Response};

/// The stand-in's port on this machine, unless `--port` says.
pub const DEFAULT_PORT: u16 = 3800;
/// Konnect's API under the stand-in's address, as under Konnect's own, `https://api.konnect.network/api/v2`.
pub const API_PATH: &str = "/api/v2";
/// The key and the wallet unless `--key` and `--wallet` say: the same at each start, so that a project's settings
/// name them once. Nothing is paid, and the stand-in answers this machine alone.
pub const DEFAULT_KEY: &str = "ff-local-konnect";
pub const DEFAULT_WALLET: &str = "ff0000000000000000000001";
/// The header that names where an answer comes from.
pub const SOURCE_HEADER: &str = "x-ff-konnect-source";
const DOCS: &str = "https://docs.konnect.network/docs/en/api-integration/endpoints";
/// A payment's life when `lifespan` doesn't give it, which Konnect's documentation doesn't say: a day.
const DEFAULT_LIFESPAN_MINUTES: u64 = 24 * 60;
/// How long the merchant's webhook is given to answer.
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);
const CURRENCIES: [&str; 3] = ["TND", "EUR", "USD"];
const METHODS: [&str; 3] = ["wallet", "bank_card", "e-DINAR"];

/// Where an answer comes from: a section of one of Konnect's pages, or the stand-in's own choice where they are silent.
#[derive(Clone, Copy, Debug)]
enum Source {
    Initiate(&'static str),
    Details(&'static str),
    Webhook(&'static str),
    Own(&'static str),
}

impl Source {
    fn header(self) -> String {
        match self {
            Source::Initiate(section) => format!("{DOCS}/initiate-payment#{section}"),
            Source::Details(section) => format!("{DOCS}/get-payment-details#{section}"),
            Source::Webhook(section) => format!("{DOCS}/webhook#{section}"),
            Source::Own(why) => format!("none: {why}"),
        }
    }
}

/// Konnect's documentation gives no error's body; the stand-in's is one message.
const OWN_ERROR: Source = Source::Own("Konnect's documentation gives no error's body: the stand-in's is a message");
/// Nor the payer's page, which the stand-in makes two buttons of.
const OWN_PAGE: Source = Source::Own("the payer's page isn't in Konnect's documentation: two buttons stand for it");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    /// Not paid: failed, or not tried yet, which Konnect's documentation says alike.
    Pending,
    Completed,
}

#[derive(Clone, Debug)]
struct Transaction {
    id: String,
    succeeded: bool,
    at: SystemTime,
}

/// A payment as `init-payment` made it, and what its page did with it.
#[derive(Clone, Debug)]
struct Payment {
    id: String,
    short_id: String,
    amount: u64,
    token: String,
    kind: String,
    description: Option<String>,
    methods: Vec<String>,
    order_id: Option<String>,
    webhook: Option<String>,
    silent: bool,
    success_url: Option<String>,
    fail_url: Option<String>,
    expires: SystemTime,
    status: Status,
    transactions: Vec<Transaction>,
}

/// What calls the merchant's webhook: the status it answered, or why it didn't.
pub type Notifier = Box<dyn Fn(&str) -> Result<u16, String> + Send + Sync>;

/// The stand-in: its key, its wallet, its payments.
pub struct Konnect {
    key: String,
    wallet: String,
    /// Where the payer's browser reaches the stand-in, which each payment's `payUrl` starts with.
    address: String,
    payments: Mutex<BTreeMap<String, Payment>>,
    notify: Notifier,
    /// Each payment's events, a line each for the developer.
    say: Box<dyn Fn(&str) + Send + Sync>,
    now: Box<dyn Fn() -> SystemTime + Send + Sync>,
}

impl Konnect {
    /// The stand-in answering `key` for `wallet`, its pages at `address`, each event said through `say`.
    pub fn new(key: String, wallet: String, address: String, say: Box<dyn Fn(&str) + Send + Sync>) -> Konnect {
        Konnect {
            key,
            wallet,
            address,
            payments: Mutex::new(BTreeMap::new()),
            notify: Box::new(call_webhook),
            say,
            now: Box::new(SystemTime::now),
        }
    }

    fn pay_url(&self, id: &str) -> String {
        format!("{}/pay?payment_ref={id}", self.address)
    }

    /// The key Konnect's API needs in `x-api-key`, else 401.
    fn authorized(&self, request: &Request, source: Source) -> Result<(), Response> {
        match request.header("x-api-key") {
            Some(key) if key == self.key => Ok(()),
            Some(_) => Err(json_response(
                401,
                source,
                json!({ "message": "x-api-key isn't the stand-in's key: ff local konnect printed it" }),
            )),
            None => Err(json_response(
                401,
                source,
                json!({ "message": "x-api-key is missing: Konnect's API needs the key in it" }),
            )),
        }
    }

    /// `POST /payments/init-payment`: a payment made of the request's fields, its `payUrl` and its reference answered.
    fn init_payment(&self, request: &Request) -> Response {
        if let Err(refused) = self.authorized(request, Source::Initiate("headers")) {
            return refused;
        }
        let payment = match self.payment_of(&request.body) {
            Ok(payment) => payment,
            Err((status, message)) => {
                return json_response(
                    status,
                    Source::Initiate("request-body-parameters"),
                    json!({ "message": message }),
                );
            }
        };
        let answer = json!({ "payUrl": self.pay_url(&payment.id), "paymentRef": payment.id });
        (self.say)(&format!(
            "{}: {}{}, made; its page {}",
            payment.id,
            money(payment.amount, &payment.token),
            payment.order_id.as_ref().map(|order| format!(" for order {order}")).unwrap_or_default(),
            self.pay_url(&payment.id)
        ));
        self.payments.lock().unwrap_or_else(PoisonError::into_inner).insert(payment.id.clone(), payment);
        json_response(200, Source::Initiate("response-parameters"), answer)
    }

    /// The payment `init-payment`'s body asks for, each field as the documentation's table says; or the status and
    /// the message of a body that isn't one.
    fn payment_of(&self, body: &[u8]) -> Result<Payment, (u16, String)> {
        let bad = |message: String| (400, message);
        let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(body) else {
            return Err(bad("The body must be a JSON object, init-payment's fields".into()));
        };
        let wallet = text(&fields, "receiverWalletId")?
            .ok_or_else(|| bad("receiverWalletId is required: the wallet paid".into()))?;
        if wallet != self.wallet {
            return Err((
                404,
                format!("receiverWalletId {wallet} is no wallet of the stand-in's, whose wallet is {}", self.wallet),
            ));
        }
        let amount = match fields.get("amount") {
            None | Some(Value::Null) => {
                return Err(bad("amount is required: millimes for TND, centimes for EUR and USD".into()));
            }
            Some(value) => value.as_u64().filter(|amount| *amount > 0).ok_or_else(|| {
                bad(format!(
                    "amount must be a whole number above 0, millimes for TND, centimes for EUR and USD: {value} isn't"
                ))
            })?,
        };
        let token = one_of(&fields, "token", &CURRENCIES)?.unwrap_or_else(|| "TND".into());
        let kind = one_of(&fields, "type", &["immediate", "partial"])?.unwrap_or_else(|| "immediate".into());
        one_of(&fields, "theme", &["light", "dark"])?;
        let methods = match fields.get("acceptedPaymentMethods") {
            None | Some(Value::Null) => METHODS.map(str::to_owned).to_vec(),
            Some(Value::Array(methods)) if !methods.is_empty() => methods
                .iter()
                .map(|method| match method.as_str() {
                    Some(method) if METHODS.contains(&method) => Ok(method.to_owned()),
                    _ => Err(bad(format!("acceptedPaymentMethods takes {}: {method} isn't one", METHODS.join(", ")))),
                })
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(bad(format!("acceptedPaymentMethods must be a list of {}", METHODS.join(", ")))),
        };
        let lifespan = match fields.get("lifespan") {
            None | Some(Value::Null) => DEFAULT_LIFESPAN_MINUTES,
            Some(value) => value
                .as_u64()
                .filter(|minutes| *minutes > 0)
                .ok_or_else(|| bad(format!("lifespan must be a whole number of minutes above 0: {value} isn't")))?,
        };
        for name in ["checkoutForm", "addPaymentFeesToAmount"] {
            flag(&fields, name)?;
        }
        for name in ["firstName", "lastName", "phoneNumber", "email"] {
            text(&fields, name)?;
        }
        let address = |name: &str| -> Result<Option<String>, (u16, String)> {
            match text(&fields, name)? {
                Some(url) if !(url.starts_with("http://") || url.starts_with("https://")) => {
                    Err(bad(format!("{name} must be an address, http:// or https://: {url} isn't")))
                }
                url => Ok(url),
            }
        };
        Ok(Payment {
            id: random_hex(12),
            short_id: random_short_id(),
            amount,
            token,
            kind,
            description: text(&fields, "description")?,
            methods,
            order_id: text(&fields, "orderId")?,
            webhook: address("webhook")?,
            silent: flag(&fields, "silentWebhook")?,
            success_url: address("successUrl")?,
            fail_url: address("failUrl")?,
            expires: (self.now)() + Duration::from_secs(lifespan * 60),
            status: Status::Pending,
            transactions: Vec::new(),
        })
    }

    /// `GET /payments/:paymentId`: the payment as the stand-in has it, or 404.
    fn details(&self, request: &Request, id: &str) -> Response {
        if let Err(refused) = self.authorized(request, Source::Details("common-errors")) {
            return refused;
        }
        let payments = self.payments.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(payment) = payments.get(id) else {
            return json_response(
                404,
                Source::Details("common-errors"),
                json!({ "message": format!("Payment not found: {id}") }),
            );
        };
        let document = self.document(payment);
        drop(payments);
        (self.say)(&format!("{id}: asked, {}", status_name(document["payment"]["status"].as_str())));
        json_response(200, Source::Details("response"), document)
    }

    /// A payment as `GET /payments/:paymentId` answers it, its fields the documentation's example's.
    fn document(&self, payment: &Payment) -> Value {
        let reached = if payment.status == Status::Completed { payment.amount } else { 0 };
        let transactions: Vec<Value> = payment
            .transactions
            .iter()
            .map(|transaction| {
                json!({
                    "id": transaction.id,
                    "status": if transaction.succeeded { "success" } else { "failed" },
                    "amount": payment.amount,
                    "token": payment.token,
                    "createdAt": rfc3339(transaction.at),
                })
            })
            .collect();
        json!({ "payment": {
            "id": payment.id,
            "status": match payment.status { Status::Pending => "pending", Status::Completed => "completed" },
            "amountDue": payment.amount - reached,
            "reachedAmount": reached,
            "amount": payment.amount,
            "token": payment.token,
            // The stand-in converts nothing.
            "convertedAmount": payment.amount,
            "exchangeRate": 1,
            "expirationDate": rfc3339(payment.expires),
            "shortId": payment.short_id,
            "link": self.pay_url(&payment.id),
            "webhook": payment.webhook,
            "successUrl": payment.success_url,
            "failUrl": payment.fail_url,
            "orderId": payment.order_id,
            "type": payment.kind,
            "details": payment.description,
            "acceptedPaymentMethods": payment.methods,
            "receiverWallet": { "id": self.wallet },
            "transactions": transactions,
        } })
    }

    /// The payer's page, `GET /pay?payment_ref=…`: the payment and two buttons; with `outcome=paid` or `failed`, the
    /// payment paid or its try failed, the merchant's webhook called, and the browser sent on.
    fn page(&self, query: &str) -> Response {
        let parameters: Vec<(String, String)> = query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
                (http::percent_decode(name), http::percent_decode(value))
            })
            .collect();
        let parameter = |name: &str| parameters.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        let Some(payment) = parameter("payment_ref")
            .and_then(|id| self.payments.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned())
        else {
            return page_response(
                404,
                OWN_PAGE,
                "No such payment",
                "<p>The stand-in has no payment of that reference: its payments are gone when it stops.</p>",
            );
        };
        match parameter("outcome") {
            None => page_response(200, OWN_PAGE, "A payment", &self.form(&payment)),
            Some(outcome @ ("paid" | "failed")) => self.end(payment, outcome == "paid"),
            Some(other) => page_response(
                400,
                OWN_PAGE,
                "No such outcome",
                &format!("<p>outcome is paid or failed, not {}.</p>", escape(other)),
            ),
        }
    }

    /// The payer's choice: the payment paid, or a failed try that leaves it pending; then its webhook called, and the
    /// browser sent to the merchant's address.
    fn end(&self, payment: Payment, paid: bool) -> Response {
        let id = payment.id.clone();
        if payment.status == Status::Completed {
            return page_response(200, OWN_PAGE, "Paid already", "<p>This payment is paid: nothing more is done.</p>");
        }
        let now = (self.now)();
        if now > payment.expires {
            return page_response(
                410,
                Source::Details("common-errors"),
                "Expired",
                "<p>This payment has expired: the shop makes another.</p>",
            );
        }
        {
            let mut payments = self.payments.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(kept) = payments.get_mut(&id) else {
                return page_response(
                    404,
                    OWN_PAGE,
                    "No such payment",
                    "<p>The stand-in has no payment of that reference.</p>",
                );
            };
            if kept.status == Status::Completed {
                return page_response(
                    200,
                    OWN_PAGE,
                    "Paid already",
                    "<p>This payment is paid: nothing more is done.</p>",
                );
            }
            kept.transactions.push(Transaction { id: random_hex(12), succeeded: paid, at: now });
            if paid {
                kept.status = Status::Completed;
            }
        }
        let what = if paid { "paid at its page" } else { "failed at its page, pending still" };
        let Some(webhook) = &payment.webhook else {
            (self.say)(&format!("{id}: {what}; no webhook to call"));
            return self.sent_on(&payment, paid);
        };
        let notification = with_reference(webhook, &id);
        let answered = match (self.notify)(&notification) {
            Ok(status) => format!("its webhook answered {status}"),
            Err(why) => format!("its webhook didn't answer: {why}"),
        };
        (self.say)(&format!("{id}: {what}; {answered}"));
        if payment.silent {
            return self.sent_on(&payment, paid);
        }
        // The deprecated successUrl and failUrl are ignored while a webhook is active and not silent: the payer goes to
        // the webhook's address.
        redirect(&notification, Source::Initiate("request-body-parameters"))
    }

    /// The browser's way on without a webhook that takes it, or with a silent one: successUrl or failUrl, else a page.
    fn sent_on(&self, payment: &Payment, paid: bool) -> Response {
        match if paid { &payment.success_url } else { &payment.fail_url } {
            Some(address) => redirect(address, Source::Initiate("request-body-parameters")),
            None if paid => page_response(
                200,
                OWN_PAGE,
                "Paid",
                "<p>The payment is paid. The shop wasn't given an address to send you back to.</p>",
            ),
            None => page_response(
                200,
                OWN_PAGE,
                "Not paid",
                "<p>The payment failed, and stays pending. The shop wasn't given an address to send you back to.</p>",
            ),
        }
    }

    /// The page's form: what is paid, and the two buttons.
    fn form(&self, payment: &Payment) -> String {
        let mut html = format!("<p class=\"amount\">{}</p>", escape(&money(payment.amount, &payment.token)));
        if let Some(description) = &payment.description {
            let _ = write!(html, "<p>{}</p>", escape(description));
        }
        if let Some(order) = &payment.order_id {
            let _ = write!(html, "<p>Order {}</p>", escape(order));
        }
        if payment.status == Status::Completed {
            html.push_str("<p>Paid.</p>");
            return html;
        }
        let _ = write!(
            html,
            "<p>By {}. Nothing is paid: ff local konnect stands in for Konnect's page.</p>",
            escape(&payment.methods.join(", "))
        );
        for (outcome, label) in [("paid", "Pay"), ("failed", "Fail")] {
            let _ = write!(
                html,
                "<form method=\"get\" action=\"/pay\"><input type=\"hidden\" name=\"payment_ref\" value=\"{}\"><input type=\"hidden\" name=\"outcome\" value=\"{outcome}\"><button>{label}</button></form>",
                escape(&payment.id)
            );
        }
        html
    }
}

impl Answers for Konnect {
    fn answer(&self, request: &Request, _request_id: &str, _source_ip: &str) -> Response {
        let (path, query) = request.target.split_once('?').unwrap_or((&request.target, ""));
        let method = request.method.as_str();
        if path == "/pay" {
            return match method {
                "GET" | "HEAD" => self.page(query),
                _ => not_allowed("GET, HEAD"),
            };
        }
        let Some(route) = path.strip_prefix(API_PATH).and_then(|rest| rest.strip_prefix("/payments/")) else {
            return json_response(
                404,
                OWN_ERROR,
                json!({ "message": format!("No route {path}: Konnect's API is under {API_PATH}/payments") }),
            );
        };
        match (method, route) {
            ("POST", "init-payment") => self.init_payment(request),
            (_, "init-payment") => not_allowed("POST"),
            ("GET", id) if !id.is_empty() && !id.contains('/') => self.details(request, &http::percent_decode(id)),
            (_, id) if !id.is_empty() && !id.contains('/') => not_allowed("GET"),
            _ => json_response(
                404,
                OWN_ERROR,
                json!({ "message": format!("No route {path}: Konnect's API is under {API_PATH}/payments") }),
            ),
        }
    }

    fn unreadable(&self, too_large: bool, _head: Option<&Request>) -> Response {
        let message = if too_large { "The body is too large" } else { "The request isn't HTTP the stand-in reads" };
        json_response(if too_large { 413 } else { 400 }, OWN_ERROR, json!({ "message": message }))
    }
}

/// A string field, if given; another type refused.
fn text(fields: &Map<String, Value>, name: &str) -> Result<Option<String>, (u16, String)> {
    match fields.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(value) => Err((400, format!("{name} must be a string: {value} isn't"))),
    }
}

/// A string field that is one of `values`, if given.
fn one_of(fields: &Map<String, Value>, name: &str, values: &[&str]) -> Result<Option<String>, (u16, String)> {
    match text(fields, name)? {
        Some(value) if !values.contains(&value.as_str()) => {
            Err((400, format!("{name} takes {}: {value} isn't one", values.join(", "))))
        }
        value => Ok(value),
    }
}

/// A boolean field, false unless given.
fn flag(fields: &Map<String, Value>, name: &str) -> Result<bool, (u16, String)> {
    match fields.get(name) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(value) => Err((400, format!("{name} must be true or false: {value} isn't"))),
    }
}

/// The webhook's address with the payment's reference, as Konnect's documentation's example has it.
fn with_reference(webhook: &str, id: &str) -> String {
    let separator = if webhook.contains('?') { '&' } else { '?' };
    format!("{webhook}{separator}payment_ref={id}")
}

/// Calls the merchant's webhook as Konnect does, a GET, naming in its header the section that says so; a redirect it
/// answers, meant for the payer's browser, is not followed.
pub fn call_webhook(address: &str) -> Result<u16, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(WEBHOOK_TIMEOUT))
        .user_agent(format!("ff-cli/{} (Konnect's stand-in)", env!("CARGO_PKG_VERSION")))
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build()
        .into();
    let (connect, host) = match http::through_loopback(address) {
        Some((connect, host)) => (connect, Some(host)),
        None => (address.to_owned(), None),
    };
    let mut request = ureq::http::Request::builder()
        .method("GET")
        .uri(&connect)
        .header(SOURCE_HEADER, Source::Webhook("request-type").header());
    if let Some(host) = host {
        request = request.header("host", host);
    }
    let request = request.body(()).map_err(|error| error.to_string())?;
    agent.run(request).map(|response| response.status().as_u16()).map_err(|error| error.to_string())
}

fn json_response(status: u16, source: Source, body: Value) -> Response {
    Response {
        status,
        headers: vec![
            ("content-type".into(), "application/json; charset=utf-8".into()),
            (SOURCE_HEADER.into(), source.header()),
        ],
        body: serde_json::to_vec(&body).expect("a document serializes"),
    }
}

fn page_response(status: u16, source: Source, title: &str, content: &str) -> Response {
    let page = format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title}: Konnect's stand-in</title><style>body{{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}}\
         .amount{{font-size:2rem;font-weight:600}}form{{display:inline-block;margin-right:.5rem}}button{{font-size:1rem;padding:.5rem 1.5rem}}</style></head>\
         <body><h1>{title}</h1>{content}</body></html>\n"
    );
    Response {
        status,
        headers: vec![
            ("content-type".into(), "text/html; charset=utf-8".into()),
            (SOURCE_HEADER.into(), source.header()),
        ],
        body: page.into_bytes(),
    }
}

fn redirect(location: &str, source: Source) -> Response {
    Response {
        status: 303,
        headers: vec![("location".into(), location.to_owned()), (SOURCE_HEADER.into(), source.header())],
        body: Vec::new(),
    }
}

fn not_allowed(allow: &str) -> Response {
    let mut response = json_response(405, OWN_ERROR, json!({ "message": format!("This route takes {allow}") }));
    response.headers.push(("allow".into(), allow.to_owned()));
    response
}

/// An amount as the payer reads it: millimes as dinars with three decimals, centimes as euros or dollars with two.
fn money(amount: u64, token: &str) -> String {
    let (unit, decimals) = if token == "TND" { (1000, 3) } else { (100, 2) };
    format!("{}.{:0decimals$} {token}", amount / unit, amount % unit)
}

fn status_name(status: Option<&str>) -> &str {
    status.unwrap_or("?")
}

fn rfc3339(at: SystemTime) -> String {
    humantime::format_rfc3339_millis(at).to_string()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Random bytes as hex: a payment's reference is 12 of them, 24 digits, as Konnect's are.
pub fn random_hex(bytes: usize) -> String {
    let mut random = vec![0u8; bytes];
    getrandom::fill(&mut random).expect("the system's random numbers");
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A payment's short ID, nine characters as the documentation's example's.
fn random_short_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut random = [0u8; 9];
    getrandom::fill(&mut random).expect("the system's random numbers");
    random.iter().map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const KEY: &str = "k-test";
    const WALLET: &str = "5f9498735289e405fc7c18aa";

    /// Lines kept as they come: the webhook's calls, or what the stand-in said.
    type Lines = Arc<Mutex<Vec<String>>>;

    /// The stand-in, its webhook calls recorded and answered `status`, its clock `now`'s.
    fn stand_in(status: u16, now: Arc<Mutex<SystemTime>>) -> (Konnect, Lines, Lines) {
        let called = Arc::new(Mutex::new(Vec::new()));
        let said = Arc::new(Mutex::new(Vec::new()));
        let mut konnect = Konnect::new(KEY.into(), WALLET.into(), "http://127.0.0.1:3800".into(), {
            let said = Arc::clone(&said);
            Box::new(move |line: &str| said.lock().unwrap().push(line.to_owned()))
        });
        konnect.notify = {
            let called = Arc::clone(&called);
            Box::new(move |address: &str| {
                called.lock().unwrap().push(address.to_owned());
                Ok(status)
            })
        };
        konnect.now = Box::new(move || *now.lock().unwrap());
        (konnect, called, said)
    }

    fn request(method: &str, target: &str, key: Option<&str>, body: Value) -> Request {
        Request {
            method: method.into(),
            target: target.into(),
            protocol: "HTTP/1.1".into(),
            headers: key.map(|key| vec![("x-api-key".to_owned(), key.to_owned())]).unwrap_or_default(),
            body: if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() },
        }
    }

    fn call(konnect: &Konnect, method: &str, target: &str, key: Option<&str>, body: Value) -> Response {
        konnect.answer(&request(method, target, key, body), "r", "127.0.0.1")
    }

    fn json_of(response: &Response) -> Value {
        serde_json::from_slice(&response.body).unwrap()
    }

    fn header<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
        response.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    fn made(konnect: &Konnect, body: Value) -> String {
        let response = call(konnect, "POST", "/api/v2/payments/init-payment", Some(KEY), body);
        assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
        json_of(&response)["paymentRef"].as_str().unwrap().to_owned()
    }

    fn now() -> Arc<Mutex<SystemTime>> {
        Arc::new(Mutex::new(humantime::parse_rfc3339("2026-11-09T10:00:00Z").unwrap()))
    }

    #[test]
    fn a_payment_made_paid_at_its_page_its_webhook_called_and_the_browser_sent_there_then_completed() {
        let (konnect, called, said) = stand_in(200, now());
        let order = json!({ "receiverWalletId": WALLET, "amount": 12500, "token": "TND", "type": "immediate",
                            "description": "2 jars of harissa", "orderId": "o-1", "webhook": "http://shop.fn.localhost:3700/webhooks/konnect" });
        let response = call(&konnect, "POST", "/api/v2/payments/init-payment", Some(KEY), order);
        assert_eq!(response.status, 200);
        assert_eq!(
            header(&response, SOURCE_HEADER),
            Some(format!("{DOCS}/initiate-payment#response-parameters").as_str())
        );
        let made = json_of(&response);
        let id = made["paymentRef"].as_str().unwrap();
        assert_eq!(id.len(), 24);
        assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(made["payUrl"], format!("http://127.0.0.1:3800/pay?payment_ref={id}"));

        let asked = call(&konnect, "GET", &format!("/api/v2/payments/{id}"), Some(KEY), Value::Null);
        assert_eq!(asked.status, 200);
        assert_eq!(header(&asked, SOURCE_HEADER), Some(format!("{DOCS}/get-payment-details#response").as_str()));
        let payment = &json_of(&asked)["payment"];
        assert_eq!(
            [
                &payment["status"],
                &payment["amount"],
                &payment["token"],
                &payment["orderId"],
                &payment["details"],
                &payment["amountDue"],
                &payment["reachedAmount"]
            ],
            [
                &json!("pending"),
                &json!(12500),
                &json!("TND"),
                &json!("o-1"),
                &json!("2 jars of harissa"),
                &json!(12500),
                &json!(0)
            ]
        );
        assert_eq!(payment["expirationDate"], "2026-11-10T10:00:00.000Z", "a day, as lifespan wasn't given");
        assert_eq!(payment["acceptedPaymentMethods"], json!(["wallet", "bank_card", "e-DINAR"]));

        let page = call(&konnect, "GET", &format!("/pay?payment_ref={id}"), None, Value::Null);
        let html = String::from_utf8(page.body.clone()).unwrap();
        assert_eq!(page.status, 200);
        assert!(
            html.contains("12.500 TND") && html.contains("2 jars of harissa") && html.contains("Order o-1"),
            "{html}"
        );
        assert!(
            html.contains("name=\"outcome\" value=\"paid\"><button>Pay</button>")
                && html.contains("value=\"failed\"><button>Fail</button>"),
            "{html}"
        );
        assert!(header(&page, SOURCE_HEADER).unwrap().starts_with("none: the payer's page"));

        let paid = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=paid"), None, Value::Null);
        let notification = format!("http://shop.fn.localhost:3700/webhooks/konnect?payment_ref={id}");
        assert_eq!((paid.status, header(&paid, "location")), (303, Some(notification.as_str())));
        assert_eq!(
            header(&paid, SOURCE_HEADER),
            Some(format!("{DOCS}/initiate-payment#request-body-parameters").as_str())
        );
        assert_eq!(*called.lock().unwrap(), [notification]);

        let payment =
            &json_of(&call(&konnect, "GET", &format!("/api/v2/payments/{id}"), Some(KEY), Value::Null))["payment"];
        assert_eq!(
            [&payment["status"], &payment["amountDue"], &payment["reachedAmount"]],
            [&json!("completed"), &json!(0), &json!(12500)]
        );
        assert_eq!(payment["transactions"][0]["status"], "success");
        assert_eq!(
            said.lock().unwrap()[..3],
            [
                format!("{id}: 12.500 TND for order o-1, made; its page http://127.0.0.1:3800/pay?payment_ref={id}"),
                format!("{id}: asked, pending"),
                format!("{id}: paid at its page; its webhook answered 200"),
            ]
        );

        let again = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=paid"), None, Value::Null);
        assert!(String::from_utf8_lossy(&again.body).contains("Paid already"));
        assert_eq!(called.lock().unwrap().len(), 1, "a payment paid isn't notified again from its page");
    }

    #[test]
    fn a_failed_try_leaves_the_payment_pending_as_the_documentation_says_a_failed_one_is() {
        let (konnect, called, _) = stand_in(200, now());
        let id = made(
            &konnect,
            json!({ "receiverWalletId": WALLET, "amount": 900, "webhook": "https://shop.example.tn/konnect?shop=1" }),
        );

        let failed = call(&konnect, "GET", &format!("/pay?outcome=failed&payment_ref={id}"), None, Value::Null);

        let notification = format!("https://shop.example.tn/konnect?shop=1&payment_ref={id}");
        assert_eq!((failed.status, header(&failed, "location")), (303, Some(notification.as_str())));
        assert_eq!(*called.lock().unwrap(), [notification]);
        let payment =
            &json_of(&call(&konnect, "GET", &format!("/api/v2/payments/{id}"), Some(KEY), Value::Null))["payment"];
        assert_eq!([&payment["status"], &payment["transactions"][0]["status"]], [&json!("pending"), &json!("failed")]);
        let paid = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=paid"), None, Value::Null);
        assert_eq!(paid.status, 303, "a failed try may be followed by one that pays");
    }

    #[test]
    fn a_silent_webhook_is_called_and_the_browser_goes_to_success_or_fail_url_or_a_page_without_one() {
        let (konnect, called, said) = stand_in(500, now());
        let silent = json!({ "receiverWalletId": WALLET, "amount": 5000, "webhook": "https://shop.example.tn/hook", "silentWebhook": true,
                             "successUrl": "https://shop.example.tn/thanks", "failUrl": "https://shop.example.tn/sorry" });
        let id = made(&konnect, silent);
        let paid = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=paid"), None, Value::Null);
        assert_eq!(header(&paid, "location"), Some("https://shop.example.tn/thanks"));
        assert_eq!(called.lock().unwrap().len(), 1);
        assert_eq!(said.lock().unwrap().last().unwrap(), &format!("{id}: paid at its page; its webhook answered 500"));

        let id = made(
            &konnect,
            json!({ "receiverWalletId": WALLET, "amount": 5000, "failUrl": "https://shop.example.tn/sorry" }),
        );
        let failed = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=failed"), None, Value::Null);
        assert_eq!(header(&failed, "location"), Some("https://shop.example.tn/sorry"));
        let paid = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=paid"), None, Value::Null);
        assert_eq!(paid.status, 200);
        assert!(String::from_utf8_lossy(&paid.body).contains("wasn't given an address"));
        assert_eq!(called.lock().unwrap().len(), 1, "no webhook, no call");
        assert_eq!(said.lock().unwrap().last().unwrap(), &format!("{id}: paid at its page; no webhook to call"));
    }

    #[test]
    fn the_key_is_needed_and_checked_and_an_unknown_payment_is_404_as_the_documentation_says() {
        let (konnect, _, _) = stand_in(200, now());
        let body = json!({ "receiverWalletId": WALLET, "amount": 1000 });
        for key in [None, Some("another")] {
            let refused = call(&konnect, "POST", "/api/v2/payments/init-payment", key, body.clone());
            assert_eq!(refused.status, 401);
            assert_eq!(header(&refused, SOURCE_HEADER), Some(format!("{DOCS}/initiate-payment#headers").as_str()));
            let refused = call(&konnect, "GET", "/api/v2/payments/5e68ed190a43a43998c6eeba", key, Value::Null);
            assert_eq!(refused.status, 401);
            assert_eq!(
                header(&refused, SOURCE_HEADER),
                Some(format!("{DOCS}/get-payment-details#common-errors").as_str())
            );
        }
        let missing = call(&konnect, "GET", "/api/v2/payments/5e68ed190a43a43998c6eeba", Some(KEY), Value::Null);
        assert_eq!(
            (missing.status, json_of(&missing)["message"].as_str()),
            (404, Some("Payment not found: 5e68ed190a43a43998c6eeba"))
        );
        let page = call(&konnect, "GET", "/pay?payment_ref=5e68ed190a43a43998c6eeba&outcome=paid", None, Value::Null);
        assert_eq!(page.status, 404);
    }

    #[test]
    fn init_payment_takes_its_fields_as_the_documentation_s_table_says() {
        let (konnect, _, _) = stand_in(200, now());
        let refused = |body: Value| {
            let response = call(&konnect, "POST", "/api/v2/payments/init-payment", Some(KEY), body);
            assert_eq!(
                header(&response, SOURCE_HEADER),
                Some(format!("{DOCS}/initiate-payment#request-body-parameters").as_str())
            );
            (response.status, json_of(&response)["message"].as_str().unwrap().to_owned())
        };
        let with = |extra: Value| {
            let mut body = json!({ "receiverWalletId": WALLET, "amount": 1000 });
            body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            body
        };
        assert_eq!(refused(json!([1])), (400, "The body must be a JSON object, init-payment's fields".to_owned()));
        assert_eq!(refused(json!({ "amount": 1000 })).1, "receiverWalletId is required: the wallet paid");
        assert_eq!(
            refused(with(json!({ "receiverWalletId": "another" }))),
            (404, format!("receiverWalletId another is no wallet of the stand-in's, whose wallet is {WALLET}"))
        );
        assert_eq!(
            refused(json!({ "receiverWalletId": WALLET })).1,
            "amount is required: millimes for TND, centimes for EUR and USD"
        );
        for amount in [json!(0), json!(12.5), json!(-3), json!("1000")] {
            assert!(
                refused(with(json!({ "amount": amount }))).1.starts_with("amount must be a whole number above 0"),
                "{amount}"
            );
        }
        assert_eq!(refused(with(json!({ "token": "GBP" }))).1, "token takes TND, EUR, USD: GBP isn't one");
        assert_eq!(refused(with(json!({ "type": "later" }))).1, "type takes immediate, partial: later isn't one");
        assert_eq!(
            refused(with(json!({ "acceptedPaymentMethods": ["cash"] }))).1,
            "acceptedPaymentMethods takes wallet, bank_card, e-DINAR: \"cash\" isn't one"
        );
        assert_eq!(
            refused(with(json!({ "acceptedPaymentMethods": [] }))).1,
            "acceptedPaymentMethods must be a list of wallet, bank_card, e-DINAR"
        );
        assert_eq!(
            refused(with(json!({ "lifespan": 0 }))).1,
            "lifespan must be a whole number of minutes above 0: 0 isn't"
        );
        assert_eq!(
            refused(with(json!({ "webhook": "shop.tn/hook" }))).1,
            "webhook must be an address, http:// or https://: shop.tn/hook isn't"
        );
        assert_eq!(
            refused(with(json!({ "silentWebhook": "yes" }))).1,
            "silentWebhook must be true or false: \"yes\" isn't"
        );
        assert_eq!(refused(with(json!({ "email": 3 }))).1, "email must be a string: 3 isn't");
        assert_eq!(refused(with(json!({ "theme": "blue" }))).1, "theme takes light, dark: blue isn't one");

        let id = made(
            &konnect,
            with(
                json!({ "token": "EUR", "acceptedPaymentMethods": ["bank_card"], "lifespan": 30, "unknown": "let be" }),
            ),
        );
        let payment =
            &json_of(&call(&konnect, "GET", &format!("/api/v2/payments/{id}"), Some(KEY), Value::Null))["payment"];
        assert_eq!(
            [&payment["token"], &payment["acceptedPaymentMethods"], &payment["expirationDate"]],
            [&json!("EUR"), &json!(["bank_card"]), &json!("2026-11-09T10:30:00.000Z")]
        );
        let page = String::from_utf8(call(&konnect, "GET", &format!("/pay?payment_ref={id}"), None, Value::Null).body)
            .unwrap();
        assert!(page.contains("10.00 EUR") && page.contains("By bank_card."), "{page}");
    }

    #[test]
    fn a_payment_past_its_lifespan_is_not_paid_at_its_page() {
        let clock = now();
        let (konnect, called, _) = stand_in(200, Arc::clone(&clock));
        let id = made(
            &konnect,
            json!({ "receiverWalletId": WALLET, "amount": 1000, "lifespan": 10, "webhook": "https://shop.example.tn/hook" }),
        );
        *clock.lock().unwrap() += Duration::from_secs(11 * 60);

        let late = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=paid"), None, Value::Null);

        assert_eq!(late.status, 410);
        assert_eq!(header(&late, SOURCE_HEADER), Some(format!("{DOCS}/get-payment-details#common-errors").as_str()));
        assert!(called.lock().unwrap().is_empty());
        let payment =
            &json_of(&call(&konnect, "GET", &format!("/api/v2/payments/{id}"), Some(KEY), Value::Null))["payment"];
        assert_eq!(payment["status"], "pending");
    }

    #[test]
    fn routes_methods_and_the_page_s_markup() {
        let (konnect, _, _) = stand_in(200, now());
        let get = call(&konnect, "GET", "/api/v2/payments/init-payment", Some(KEY), Value::Null);
        assert_eq!((get.status, header(&get, "allow")), (405, Some("POST")));
        let delete = call(&konnect, "DELETE", "/api/v2/payments/5e68ed190a43a43998c6eeba", Some(KEY), Value::Null);
        assert_eq!((delete.status, header(&delete, "allow")), (405, Some("GET")));
        let post = call(&konnect, "POST", "/pay", None, Value::Null);
        assert_eq!((post.status, header(&post, "allow")), (405, Some("GET, HEAD")));
        let elsewhere = call(&konnect, "GET", "/api/v1/payments", Some(KEY), Value::Null);
        assert_eq!(elsewhere.status, 404);
        assert_eq!(header(&elsewhere, SOURCE_HEADER), Some(OWN_ERROR.header().as_str()));

        let id = made(
            &konnect,
            json!({ "receiverWalletId": WALLET, "amount": 1, "description": "<script>alert(1)</script>" }),
        );
        let page = String::from_utf8(call(&konnect, "GET", &format!("/pay?payment_ref={id}"), None, Value::Null).body)
            .unwrap();
        assert!(page.contains("&lt;script&gt;alert(1)&lt;/script&gt;") && !page.contains("<script>"), "{page}");
        assert!(page.contains("0.001 TND"));
        let odd = call(&konnect, "GET", &format!("/pay?payment_ref={id}&outcome=maybe"), None, Value::Null);
        assert_eq!(odd.status, 400);
        assert_eq!(money(12500, "TND"), "12.500 TND");
        assert_eq!(money(1999, "USD"), "19.99 USD");
    }

    #[test]
    fn the_webhook_is_called_over_http_its_redirect_not_followed_a_host_under_localhost_at_127_0_0_1() {
        struct Shop(Arc<Mutex<Vec<Request>>>);
        impl Answers for Shop {
            fn answer(&self, request: &Request, _: &str, _: &str) -> Response {
                self.0.lock().unwrap().push(request.clone());
                Response {
                    status: 303,
                    headers: vec![("location".into(), "https://shop.example.tn/thanks".into())],
                    body: Vec::new(),
                }
            }
            fn unreadable(&self, _: bool, _: Option<&Request>) -> Response {
                Response { status: 400, headers: Vec::new(), body: Vec::new() }
            }
        }
        let received = Arc::new(Mutex::new(Vec::new()));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        http::serve(listener, Arc::new(Shop(Arc::clone(&received))));

        let status = call_webhook(&format!(
            "http://shop.fn.localhost:{port}/webhooks/konnect?payment_ref=5f9498735289e405fc7c18ac"
        ));

        assert_eq!(status, Ok(303));
        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(
            (received[0].method.as_str(), received[0].target.as_str()),
            ("GET", "/webhooks/konnect?payment_ref=5f9498735289e405fc7c18ac")
        );
        assert_eq!(received[0].header("host"), Some(format!("shop.fn.localhost:{port}").as_str()));
        assert_eq!(received[0].header(SOURCE_HEADER), Some(format!("{DOCS}/webhook#request-type").as_str()));
        let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(call_webhook(&format!("http://127.0.0.1:{gone}/hook")).is_err());
    }
}

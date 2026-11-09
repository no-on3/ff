//! A request's signature as S3 reads and checks it (`BE/src/storage/s3-signature.ts`): in its Authorization header,
//! or presigned, in its query; its problems in S3's words. Its tests read AWS's examples from the backend's table.

use super::error::{
    S3Error, access_denied, invalid_argument, invalid_request, malformed_authorization, malformed_query_authorization,
    signature_mismatch,
};
use crate::sigv4::{
    ALGORITHM, Chain, HeaderSignature, MAX_CLOCK_SKEW_SECONDS, Paths, Problem, SignedRequest, check_skew, header,
    match_signature, read_authorization, read_credential, require_signed, signed_at,
};

/// The payload of a request that doesn't sign its body, as presigned URLs never do.
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
/// A presigned URL lives from 1 second to 7 days.
const MAX_PRESIGNED_SECONDS: i64 = 604_800;
/// The service S3's signatures are scoped to.
const SERVICE: &str = "s3";

/// What a request's signature says, from its Authorization header or, presigned, from its query.
#[derive(Clone, Debug)]
pub struct RequestSignature {
    pub presigned: bool,
    pub signed: HeaderSignature,
    /// The body as signed: its SHA-256 in hex, UNSIGNED-PAYLOAD, or one of aws-chunked's forms.
    pub payload: String,
    /// A presigned URL's life, in seconds.
    pub expires: Option<i64>,
}

/// S3's words for a signature's problem: what is wrong with the header, or with a presigned URL's query.
fn s3_words(problem: Problem, presigned: bool) -> S3Error {
    let malformed = |detail: &str| match presigned {
        true => malformed_query_authorization(detail),
        false => malformed_authorization(detail),
    };
    let credential = |detail: &str| match presigned {
        true => malformed_query_authorization(&format!("Error parsing the X-Amz-Credential parameter; {detail}")),
        false => malformed_authorization(detail),
    };
    match problem {
        Problem::Token => S3Error::new(400, "InvalidToken", "The provided token is malformed or otherwise invalid."),
        Problem::Algorithm => invalid_request(
            "The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.",
        ),
        Problem::Parts => malformed("it needs a Credential, SignedHeaders and a Signature"),
        Problem::Credential { part: "date", value } => credential(&format!("incorrect date \"{value}\"")),
        Problem::Credential { part: "terminal", value } => {
            credential(&format!("incorrect terminal \"{value}\". This endpoint uses \"aws4_request\"."))
        }
        Problem::Credential { .. } => credential("the Credential is not <key>/<date>/<region>/s3/aws4_request"),
        Problem::Service { named } => {
            credential(&format!("incorrect service \"{named}\". This endpoint belongs to \"s3\"."))
        }
        Problem::NoDate => malformed("the request has no x-amz-date header"),
        Problem::Date { amz_date } => malformed(&format!("the date \"{amz_date}\" is not YYYYMMDDTHHMMSSZ")),
        Problem::OtherDay { date, .. } => malformed(&format!("the credential's date \"{date}\" is not the request's")),
        Problem::Skewed { .. } => S3Error::new(
            403,
            "RequestTimeTooSkewed",
            "The difference between the request time and the current time is too large.",
        ),
        Problem::Unsigned { header } => malformed(&format!("the {header} header must be signed")),
        Problem::Mismatch => signature_mismatch(),
    }
}

const QUERY_PARAMETERS: [&str; 6] =
    ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Signature", "X-Amz-Date", "X-Amz-SignedHeaders", "X-Amz-Expires"];

/// A request's signature, read but not yet checked; None for an anonymous request. FF's keys have no session token: a
/// request that carries one is refused, as a token FF never issued.
pub fn read_signature(
    headers: &[(String, String)],
    query: &[(String, String)],
) -> Result<Option<RequestSignature>, S3Error> {
    let parameter = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
    let has_header = header(headers, "authorization").is_some();
    let presigned =
        ["X-Amz-Algorithm", "X-Amz-Signature", "X-Amz-Credential"].iter().any(|name| parameter(name).is_some());
    if has_header && presigned {
        return Err(invalid_argument(
            "Only one auth mechanism allowed; only the X-Amz-Algorithm query parameter or the Authorization header should be specified",
        ));
    }
    if header(headers, "x-amz-security-token").is_some() || parameter("X-Amz-Security-Token").is_some() {
        return Err(s3_words(Problem::Token, false));
    }
    if has_header {
        let signed = read_authorization(headers, SERVICE).map_err(|problem| s3_words(problem, false))?;
        let signed = signed.expect("an Authorization header, read");
        let Some(payload) = header(headers, "x-amz-content-sha256").filter(|payload| !payload.is_empty()) else {
            return Err(invalid_request("Missing required header for this request: x-amz-content-sha256"));
        };
        return Ok(Some(RequestSignature { presigned: false, signed, payload: payload.to_owned(), expires: None }));
    }
    if !presigned {
        return Ok(None);
    }
    if parameter("X-Amz-Algorithm") != Some(ALGORITHM) {
        return Err(malformed_query_authorization("X-Amz-Algorithm only supports \"AWS4-HMAC-SHA256\""));
    }
    if QUERY_PARAMETERS.iter().any(|name| parameter(name).is_none_or(str::is_empty)) {
        return Err(malformed_query_authorization(
            "Query-string authentication version 4 requires the X-Amz-Algorithm, X-Amz-Credential, X-Amz-Signature, X-Amz-Date, X-Amz-SignedHeaders, and X-Amz-Expires parameters.",
        ));
    }
    let given = |name: &str| parameter(name).unwrap_or_default().to_owned();
    let expires = given("X-Amz-Expires").parse::<i64>().ok().filter(|seconds| *seconds >= 1);
    let Some(expires) = expires else {
        return Err(malformed_query_authorization("X-Amz-Expires must be a whole number of seconds, 1 at least"));
    };
    if expires > MAX_PRESIGNED_SECONDS {
        return Err(malformed_query_authorization(
            "X-Amz-Expires must be less than a week (in seconds) that is 604800",
        ));
    }
    let (access_key_id, date, region) =
        read_credential(&given("X-Amz-Credential"), SERVICE).map_err(|problem| s3_words(problem, true))?;
    Ok(Some(RequestSignature {
        presigned: true,
        signed: HeaderSignature {
            access_key_id,
            date,
            region,
            signed_headers: given("X-Amz-SignedHeaders").split(';').map(String::from).collect(),
            signature: given("X-Amz-Signature"),
            amz_date: given("X-Amz-Date"),
        },
        payload: parameter("X-Amz-Content-Sha256").unwrap_or(UNSIGNED_PAYLOAD).to_owned(),
        expires: Some(expires),
    }))
}

/// Checks a signature with the key's secret at `now` (Unix milliseconds), as S3 does: its time (within 15 minutes of
/// now in a header; a presigned URL until it expires), the signed headers (host, and for a header the body's hash),
/// then the signature itself. The path is tried as S3 signs it, then as the client sent it, which some clients sign.
/// Answers what an aws-chunked body's chunks chain from.
pub fn check_signature(
    request: &SignedRequest,
    signature: &RequestSignature,
    secret: &str,
    now: i64,
) -> Result<Chain, S3Error> {
    let presigned = signature.presigned;
    let words = |problem| s3_words(problem, presigned);
    let signed = &signature.signed;
    let at = signed_at(&signed.date, &signed.amz_date).map_err(words)?;
    match signature.expires {
        Some(expires) if presigned => {
            if at * 1000 - now > MAX_CLOCK_SKEW_SECONDS * 1000 {
                return Err(access_denied("Request is not valid yet"));
            }
            if now > (at + expires) * 1000 {
                return Err(access_denied("Request has expired"));
            }
        }
        _ => check_skew(at, &signed.amz_date, now.div_euclid(1000)).map_err(words)?,
    }
    require_signed(&signed.signed_headers, "host").map_err(words)?;
    if !presigned {
        require_signed(&signed.signed_headers, "x-amz-content-sha256").map_err(words)?;
    }
    let unsigned_query = presigned.then_some("X-Amz-Signature");
    match_signature(request, signed, &signature.payload, secret, SERVICE, Paths::Once, unsigned_query).map_err(words)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::local::s3::requests::parse_query;

    /// AWS's documented examples of Signature Version 4 for S3, made with the table's key and secret on 2013-05-24 at
    /// midnight, UTC, for the bucket examplebucket, as the backend's tests read them.
    fn signatures() -> Value {
        let table: Value = serde_json::from_str(include_str!("../../../../BE/src/storage/s3-examples.json")).unwrap();
        table["signatures"].clone()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    fn millis(at: &str) -> i64 {
        let at = humantime::parse_rfc3339(at).unwrap();
        at.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }

    struct Sent {
        method: String,
        raw_path: String,
        raw_query: String,
        headers: Vec<(String, String)>,
    }

    impl Sent {
        fn request(&self) -> SignedRequest<'_> {
            SignedRequest {
                method: &self.method,
                raw_path: &self.raw_path,
                raw_query: &self.raw_query,
                headers: &self.headers,
            }
        }
    }

    fn pairs(value: &Value) -> Vec<(String, String)> {
        let pairs = value.as_array().unwrap().iter();
        pairs.map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned())).collect()
    }

    /// A header-signed request as a client would send it, and its signature as the front door reads it.
    fn signed(signatures: &Value, example: &Value) -> (Sent, RequestSignature) {
        let mut headers = pairs(&example["headers"]);
        let mut names: Vec<String> = headers.iter().map(|(name, _)| name.to_ascii_lowercase()).collect();
        names.sort();
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/20130524/us-east-1/s3/aws4_request,SignedHeaders={},Signature={}",
            text(&signatures["key"]),
            names.join(";"),
            text(&example["signature"])
        );
        headers.push(("Authorization".into(), authorization));
        let target = text(&example["target"]);
        let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
        let read = read_signature(&headers, &parse_query(raw_query)).unwrap().unwrap();
        let sent = Sent {
            method: text(&example["method"]).into(),
            raw_path: raw_path.into(),
            raw_query: raw_query.into(),
            headers,
        };
        (sent, read)
    }

    fn outcome<T>(result: Result<T, S3Error>) -> String {
        match result {
            Ok(_) => "accepted".into(),
            Err(error) => format!("{} {}", error.status, error.code),
        }
    }

    /// The example, signed, checked against the table's secret at its time.
    fn checked(name: &str) -> String {
        let signatures = signatures();
        let (sent, read) = signed(&signatures, &signatures["examples"][name]);
        outcome(check_signature(&sent.request(), &read, text(&signatures["secret"]), millis(text(&signatures["at"]))))
    }

    /// Each case of the group: its example changed as it says, checked.
    fn changed_answers(group: &str) {
        let signatures = signatures();
        let cases = signatures["changed"][group].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let (mut sent, mut read) = signed(&signatures, &signatures["examples"][text(&case["example"])]);
            if let Some(header) = case.get("header") {
                for (name, value) in &mut sent.headers {
                    if name == text(&header[0]) {
                        *value = text(&header[1]).to_owned();
                    }
                }
            }
            if let Some(target) = case.get("target") {
                sent.raw_path = text(target).to_owned();
            }
            if let Some(names) = case.get("signedHeaders") {
                read.signed.signed_headers =
                    names.as_array().unwrap().iter().map(|name| text(name).to_owned()).collect();
            }
            let secret = case.get("secret").unwrap_or(&signatures["secret"]);
            let at = case.get("at").unwrap_or(&signatures["at"]);
            let answer = outcome(check_signature(&sent.request(), &read, text(secret), millis(text(at))));
            let title = text(&case["title"]);
            assert_eq!(format!("{title}: {answer}"), format!("{title}: {}", text(&case["answer"])));
        }
    }

    /// Each case of the group, read: no signature, one read, or its refusal.
    fn read_answers(group: &str) {
        let signatures = signatures();
        let cases = signatures["read"][group].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let object_pairs = |value: Option<&Value>| -> Vec<(String, String)> {
                let fields = value.and_then(Value::as_object).into_iter().flatten();
                fields.map(|(name, value)| (name.clone(), text(value).to_owned())).collect()
            };
            let read = read_signature(&object_pairs(case.get("headers")), &object_pairs(case.get("query")));
            let answer = match read {
                Ok(None) => "none".into(),
                other => outcome(other),
            };
            let title = text(&case["title"]);
            assert_eq!(format!("{title}: {answer}"), format!("{title}: {}", text(&case["answer"])));
        }
    }

    #[test]
    fn awss_example_get_object_a_range_the_empty_body_signed_answering_its_chain() {
        let signatures = signatures();
        let example = &signatures["examples"]["getObject"];
        let (sent, read) = signed(&signatures, example);

        let chain =
            check_signature(&sent.request(), &read, text(&signatures["secret"]), millis(text(&signatures["at"])))
                .unwrap();

        assert_eq!(
            (chain.scope.as_str(), chain.amz_date.as_str(), chain.seed.as_str()),
            (text(&example["scope"]), "20130524T000000Z", read.signed.signature.as_str())
        );
    }

    #[test]
    fn awss_examples_a_key_that_needs_encoding_a_parameter_without_a_value_and_two_sorted() {
        for name in ["putObject", "lifecycle", "listObjects"] {
            assert_eq!(format!("{name}: {}", checked(name)), format!("{name}: accepted"));
        }
    }

    #[test]
    fn a_presigned_get_for_a_day_good_until_it_expires_refused_after() {
        let signatures = signatures();
        let presigned = &signatures["presignedGet"];
        let target = text(&presigned["target"]);
        let (raw_path, raw_query) = target.split_once('?').unwrap();
        let sent = Sent {
            method: text(&presigned["method"]).into(),
            raw_path: raw_path.into(),
            raw_query: raw_query.into(),
            headers: pairs(&presigned["headers"]),
        };
        let read = read_signature(&sent.headers, &parse_query(raw_query)).unwrap().unwrap();
        let expected = &presigned["read"];
        assert_eq!(
            (
                read.presigned,
                read.signed.access_key_id.as_str(),
                read.signed.region.as_str(),
                read.expires,
                read.payload.as_str()
            ),
            (
                text(&expected["kind"]) == "presigned",
                text(&expected["accessKeyId"]),
                text(&expected["region"]),
                expected["expires"].as_i64(),
                text(&expected["payload"])
            )
        );
        for answer in presigned["answers"].as_array().unwrap() {
            let at = text(&answer["at"]);
            let checked = outcome(check_signature(&sent.request(), &read, text(&signatures["secret"]), millis(at)));
            assert_eq!(format!("{at}: {checked}"), format!("{at}: {}", text(&answer["answer"])));
        }
    }

    #[test]
    fn another_secret_a_header_changed_the_path_changed_the_signature_does_not_match() {
        changed_answers("mismatched");
    }

    #[test]
    fn a_request_signed_more_than_15_minutes_from_now_either_way() {
        changed_answers("skewed");
    }

    #[test]
    fn a_signature_that_doesnt_sign_the_host_or_the_bodys_hash() {
        changed_answers("unsigned");
    }

    #[test]
    fn what_isnt_signature_version_4_or_is_malformed_before_any_secret_is_looked_for() {
        read_answers("malformed");
    }

    #[test]
    fn a_presigned_url_without_its_parameters_or_for_longer_than_a_week() {
        read_answers("presigned");
    }
}

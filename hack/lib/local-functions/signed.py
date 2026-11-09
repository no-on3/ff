"""A request signed with Signature Version 4 by hand, as the ff suite's functions on ff local start send one: the
runtime images have no SDK, and a function needs no setting, as FF gives it the endpoint, the region and the key.
Copied beside a function's app.py, which imports it."""

import datetime
import hashlib
import hmac
import os
import urllib.parse
import urllib.request


def send(service, method, url, body, headers):
    """The answer to `method url` with `body`, signed for `service` with the function's key; `headers`, in lower
    case, signed too. A URL without a query, its path as it is sent."""
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload = hashlib.sha256(body).hexdigest()
    headers = {**headers, "host": urllib.parse.urlsplit(url).netloc, "x-amz-content-sha256": payload,
               "x-amz-date": amz_date}
    names = ";".join(sorted(headers))
    lines = [f"{name}:{headers[name]}" for name in sorted(headers)]
    canonical = "\n".join([method, urllib.parse.urlsplit(url).path or "/", "", *lines, "", names, payload])
    region = os.environ["AWS_REGION"]
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + os.environ["AWS_SECRET_ACCESS_KEY"]).encode()
    for part in (day, region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={os.environ['AWS_ACCESS_KEY_ID']}/{scope}, "
                                f"SignedHeaders={names}, Signature={signature}")
    return urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=10)

"""Each request Terraform's AWS provider sent, from its log at DEBUG (TF_LOG=DEBUG): one tab-separated line a request,
in the order sent: the time it was answered, the step's RPC (PlanResourceChange, ApplyResourceChange, ReadResource, ImportResourceState), the
resource's type, the service and operation, the attempt, the answer's status and, when refused, the error's code.

    python3 provider_log.py <debug.log>

A record of the log spans several lines when a field holds one (a body): each starts with its timestamp."""

import re
import sys

RECORD = re.compile(r"\n(?=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)")


def field(record, name):
    found = re.search(r"(?:^|\s)" + re.escape(name) + r'=("(?:[^"\\]|\\.)*"|\S*)', record)
    return found.group(1).strip('"') if found else ""


def error_code(record):
    """S3's <Code> in its XML, SQS's __type in its JSON (after the #), or the query error's header."""
    for pattern in (r"<Code>([^<]+)</Code>", r'\\?"__type\\?"\s*:\s*\\?"(?:[^"#\\]*#)?([^"\\]+)', r"x_amzn_query_error=\"?([^;\" ]+)"):
        found = re.search(pattern, record)
        if found:
            return found.group(1)
    return ""


def main(path):
    sent = {}
    for record in RECORD.split(open(path, encoding="utf-8", errors="replace").read()):
        if "HTTP Request Sent" in record:
            # A request's attempt, matched to its answer by the provider's request and the operation.
            key = (field(record, "tf_req_id"), field(record, "rpc.method"))
            sent[key] = re.sub(r"^attempt=(\d+).*", r"\1", field(record, "http.request.header.amz_sdk_request"))
        elif "HTTP Response Received" in record:
            status = field(record, "http.status_code")
            key = (field(record, "tf_req_id"), field(record, "rpc.method"))
            print("\t".join([
                record[11:23],
                field(record, "tf_rpc"),
                field(record, "tf_resource_type"),
                field(record, "rpc.method"),
                sent.get(key, ""),
                status,
                error_code(record) if status and not status.startswith("2") else "",
            ]))


if __name__ == "__main__":
    main(sys.argv[1])

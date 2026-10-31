"""boto3 against the spike's SES v2 endpoint, its endpoint from AWS_ENDPOINT_URL_SESV2 alone: one JSON line a check.

    AWS_ENDPOINT_URL_SESV2=... KEY=... SECRET=... python ses_boto3_check.py
"""
import datetime
import json
import os

import boto3

KEY, SECRET = os.environ["KEY"], os.environ["SECRET"]


def client(secret=SECRET):
    return boto3.client("sesv2", region_name="tn-tunis-1", aws_access_key_id=KEY, aws_secret_access_key=secret)


ses = client()


def check(want, what, run):
    try:
        detail, got = json.dumps(run(), default=str)[:200], "ok"
    except Exception as error:  # noqa: BLE001 - the spike reports whatever the client raises
        got = getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__)
        detail = str(error)[:200]
    print(json.dumps({"client": "boto3", "want": want, "got": got, "what": what, "detail": detail}))


def expect(value, condition, problem):
    if not condition:
        raise ValueError(f"{problem}: {value}")
    return value


check("ok", "CreateEmailIdentity of a domain answers its DKIM tokens",
      lambda: expect(out := ses.create_email_identity(EmailIdentity="b-shop.example"), out["DkimAttributes"]["Tokens"] == ["ff1"], "no token"))
check("ok", "CreateEmailIdentity of a verified domain, and of an address",
      lambda: (ses.create_email_identity(EmailIdentity="verified-b.example"), ses.create_email_identity(EmailIdentity="eya@client.example"))[1]["IdentityType"])
check("AlreadyExistsException", "CreateEmailIdentity of one already there", lambda: ses.create_email_identity(EmailIdentity="b-shop.example"))
check("ok", "GetEmailIdentity of an address, whose @ is escaped in the path, and its key's time read as a date",
      lambda: expect(ses.get_email_identity(EmailIdentity="b-shop.example")["DkimAttributes"]["LastKeyGenerationTimestamp"],
                     isinstance(ses.get_email_identity(EmailIdentity="eya@client.example")["IdentityType"], str)
                     and isinstance(ses.get_email_identity(EmailIdentity="b-shop.example")["DkimAttributes"]["LastKeyGenerationTimestamp"], datetime.datetime), "not a date"))
check("NotFoundException", "GetEmailIdentity of one not there", lambda: ses.get_email_identity(EmailIdentity="nowhere.example"))
check("ok", "ListEmailIdentities", lambda: [one["IdentityName"] for one in ses.list_email_identities()["EmailIdentities"]])
check("ok", "SendEmail, simple, from a verified domain", lambda: ses.send_email(
    FromEmailAddress="orders@verified-b.example", Destination={"ToAddresses": ["eya@client.example"]},
    Content={"Simple": {"Subject": {"Data": "Your receipt"}, "Body": {"Text": {"Data": "Thanks"}}}})["MessageId"])
check("ok", "SendEmail, raw", lambda: ses.send_email(Content={"Raw": {"Data": b"From: orders@verified-b.example\r\nTo: eya@client.example\r\nSubject: raw\r\n\r\nhi\r\n"}})["MessageId"])
check("MessageRejected", "SendEmail from a domain not verified", lambda: ses.send_email(
    FromEmailAddress="x@b-shop.example", Destination={"ToAddresses": ["a@b.example"]},
    Content={"Simple": {"Subject": {"Data": "s"}, "Body": {"Text": {"Data": "b"}}}}))
check("ok", "GetAccount: the quotas and the sandbox", lambda: expect(out := ses.get_account(), out["SendQuota"]["Max24HourSend"] == 200, "no quota")["SendQuota"])
check("ok", "PutSuppressedDestination, then GetSuppressedDestination, its time a date",
      lambda: (ses.put_suppressed_destination(EmailAddress="gone-b@client.example", Reason="COMPLAINT"),
               expect(t := ses.get_suppressed_destination(EmailAddress="gone-b@client.example")["SuppressedDestination"]["LastUpdateTime"],
                      isinstance(t, datetime.datetime), "not a date"))[1])
check("ok", "ListSuppressedDestinations by reason", lambda: len(ses.list_suppressed_destinations(Reasons=["COMPLAINT"])["SuppressedDestinationSummaries"]))
check("ok", "DeleteSuppressedDestination, then DeleteEmailIdentity",
      lambda: (ses.delete_suppressed_destination(EmailAddress="gone-b@client.example"), ses.delete_email_identity(EmailIdentity="b-shop.example"))[1]["ResponseMetadata"]["HTTPStatusCode"])
check("SignatureDoesNotMatch", "a wrong secret", lambda: client("wrong-secret-wrong-secret-wrong-secret00").get_account())

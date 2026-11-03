#!/usr/bin/env python3
# boto3 against FF's Lambda endpoint, with its defaults, as a customer's code has them: only the endpoint, the region
# and the key are given. A function through its life: made, waited for, listed, its code and its settings changed,
# each change waited for, tagged, invoked, a version and an alias, refused as Lambda refuses, deleted; an operation FF doesn't offer yet refused once, by
# its name, though boto3 retries by default. One JSON line per check, {client, want, got, what}, for hack/e2e.sh.
#   ENDPOINT=http://localhost:<port> KEY=… SECRET=… ROLE=<an IAM role's ARN> CODE=<zip> CODE_SHA=<its CodeSha256> \
#   NEW_CODE=<zip> NEW_CODE_SHA=… OTHER_FUNCTION=<another function's name> python boto3_checks.py
import base64
import json
import os

import boto3

env = os.environ
client = boto3.client("lambda", endpoint_url=env["ENDPOINT"], region_name="tn-tunis-1", aws_access_key_id=env["KEY"], aws_secret_access_key=env["SECRET"])
NAME = "e2e-boto3"
# The waiters as boto3 has them, every second for up to two minutes.
WAITING = {"Delay": 1, "MaxAttempts": 120}
state = {}


def check(want, what, run):
    got, detail = "ok", ""
    try:
        detail = str(run() or "")
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        got = "refused"
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        detail = f"{type(error).__name__}{f' ({code})' if code else ''}: {error}"
    print(json.dumps({"client": "boto3", "want": want, "got": got, "what": what, "detail": detail[:200]}), flush=True)


def expect(actual, wanted):
    if actual != wanted:
        raise AssertionError(f"got {actual!r}, not {wanted!r}")
    return repr(actual)[:120]


def refused_as(run, code):
    """Refused, as the error Lambda names, which boto3 reads as the error's code."""
    try:
        run()
    except Exception as error:  # noqa: BLE001 - the refusal is the result
        return expect(getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__), code)
    raise AssertionError("accepted")


def zip_of(path):
    with open(path, "rb") as file:
        return file.read()


def create():
    made = client.create_function(FunctionName=NAME, Runtime="nodejs24.x", Role=env["ROLE"], Handler="index.handler", Code={"ZipFile": zip_of(env["CODE"])},
                                  Environment={"Variables": {"STAGE": "boto3"}}, Tags={"client": "boto3"})
    return expect([made["State"], made["CodeSha256"]], ["Pending", env["CODE_SHA"]])


def active():
    client.get_waiter("function_active_v2").wait(FunctionName=NAME, WaiterConfig=WAITING)
    read = client.get_function(FunctionName=NAME)
    configuration = read["Configuration"]
    state["revision"] = configuration["RevisionId"]
    return expect([configuration["State"], configuration["LastUpdateStatus"], configuration["Environment"]["Variables"], read["Tags"]],
                  ["Active", "Successful", {"STAGE": "boto3"}, {"client": "boto3"}])


def listed():
    pages = list(client.get_paginator("list_functions").paginate(PaginationConfig={"PageSize": 1}))
    names = sorted(function["FunctionName"] for page in pages for function in page["Functions"])
    return expect([len(pages), names], [2, sorted([NAME, env["OTHER_FUNCTION"]])])


def new_code():
    answer = client.update_function_code(FunctionName=NAME, ZipFile=zip_of(env["NEW_CODE"]))
    expect([answer["LastUpdateStatus"], answer["CodeSha256"]], ["InProgress", env["NEW_CODE_SHA"]])
    client.get_waiter("function_updated_v2").wait(FunctionName=NAME, WaiterConfig=WAITING)
    read = client.get_function_configuration(FunctionName=NAME)
    return expect([read["LastUpdateStatus"], read["CodeSha256"]], ["Successful", env["NEW_CODE_SHA"]])


def new_settings():
    answer = client.update_function_configuration(FunctionName=NAME, Timeout=10, Environment={"Variables": {"STAGE": "boto3-2"}})
    expect([answer["LastUpdateStatus"], answer["Timeout"]], ["InProgress", 10])
    refused_as(lambda: client.update_function_configuration(FunctionName=NAME, Timeout=11), "ResourceConflictException")
    client.get_waiter("function_updated_v2").wait(FunctionName=NAME, WaiterConfig=WAITING)
    read = client.get_function_configuration(FunctionName=NAME)
    return expect([read["LastUpdateStatus"], read["Timeout"], read["Environment"]["Variables"]], ["Successful", 10, {"STAGE": "boto3-2"}])


def invoked():
    called = client.invoke(FunctionName=NAME, Payload=json.dumps({"n": 1}).encode(), LogType="Tail",
                           ClientContext=base64.b64encode(json.dumps({"custom": {"cart": "7"}}).encode()).decode())
    log = base64.b64decode(called["LogResult"]).decode()
    lines = log.splitlines()
    return expect([called["StatusCode"], called["ExecutedVersion"], called.get("FunctionError", "none"), json.loads(called["Payload"].read()),
                   lines[0].startswith("START RequestId: "), 'invoked with {"n":1}' in lines, lines[-1].startswith("REPORT RequestId: ")],
                  [200, "$LATEST", "none", {"code": "v2", "event": {"n": 1}, "clientContext": {"custom": {"cart": "7"}}}, True, True, True])


def invoked_otherwise():
    failed = client.invoke(FunctionName=NAME, Payload=json.dumps({"fail": True}).encode())
    queued = client.invoke(FunctionName=NAME, InvocationType="Event", Payload=b"{}")
    dry = client.invoke(FunctionName=NAME, InvocationType="DryRun")
    return expect([failed["StatusCode"], failed.get("FunctionError"), json.loads(failed["Payload"].read()), queued["StatusCode"], dry["StatusCode"]],
                  [200, "Unhandled", {"errorType": "TypeError", "errorMessage": "bad input"}, 202, 204])


def versions_and_aliases():
    version = client.publish_version(FunctionName=NAME, Description="boto3")["Version"]
    made = client.create_alias(FunctionName=NAME, Name="live", FunctionVersion=version)
    expect([client.get_alias(FunctionName=NAME, Name="live")["RevisionId"], made["FunctionVersion"]], [made["RevisionId"], version])
    changed = client.update_alias(FunctionName=NAME, Name="live", FunctionVersion="$LATEST", RevisionId=made["RevisionId"])
    listed = [f"{alias['Name']}:{alias['FunctionVersion']}" for alias in client.list_aliases(FunctionName=NAME)["Aliases"]]
    client.delete_alias(FunctionName=NAME, Name="live")
    refused_as(lambda: client.get_alias(FunctionName=NAME, Name="live"), "ResourceNotFoundException")
    versions = [entry["Version"] for entry in client.list_versions_by_function(FunctionName=NAME)["Versions"]]
    return expect([version, changed["FunctionVersion"], listed, versions], ["1", "$LATEST", ["live:$LATEST"], ["$LATEST", "1"]])


def tags():
    arn = client.get_function_configuration(FunctionName=NAME)["FunctionArn"]
    client.tag_resource(Resource=arn, Tags={"team": "shop"})
    expect(client.list_tags(Resource=arn)["Tags"], {"client": "boto3", "team": "shop"})
    client.untag_resource(Resource=arn, TagKeys=["client"])
    return expect(client.list_tags(Resource=arn)["Tags"], {"team": "shop"})


def refusals():
    refused_as(lambda: client.create_function(FunctionName="e2e-boto3-22", Runtime="nodejs22.x", Role=env["ROLE"], Handler="index.handler",
                                              Code={"ZipFile": zip_of(env["CODE"])}), "InvalidParameterValueException")
    return refused_as(lambda: client.get_function(FunctionName="e2e-boto3-missing"), "ResourceNotFoundException")


def not_offered():
    """boto3's own retries, up to four more of an error it retries: none of these."""
    refused = []
    for run in (lambda: client.list_layers(),
                lambda: client.get_layer_version_by_arn(Arn="arn:aws:lambda:tn-tunis-1:000000000000:layer:shared:1"),
                lambda: client.put_provisioned_concurrency_config(FunctionName=NAME, Qualifier="1", ProvisionedConcurrentExecutions=1)):
        try:
            run()
            refused.append("accepted")
        except Exception as error:  # noqa: BLE001 - the refusal is the result
            response = getattr(error, "response", {})
            refused.append(f"{response.get('Error', {}).get('Code')} {response.get('ResponseMetadata', {}).get('RetryAttempts')} "
                           f"{response.get('Error', {}).get('Message', '').split('.')[0]}")
    return expect(refused, ["UnknownOperationException 0 FF doesn't offer ListLayers of Lambda's API yet",
                            "UnknownOperationException 0 FF doesn't offer GetLayerVersionByArn of Lambda's API yet",
                            "UnknownOperationException 0 FF doesn't offer PutProvisionedConcurrencyConfig of Lambda's API yet"])


def deleted():
    client.delete_function(FunctionName=NAME)
    return refused_as(lambda: client.get_function(FunctionName=NAME), "ResourceNotFoundException")


check("ok", "CreateFunction answers at once, Pending, with the zip's CodeSha256", create)
check("ok", "the waiter function_active_v2 waits for it to be Active; GetFunction reads it so, with its tags", active)
check("ok", "the paginator of ListFunctions follows NextMarker a function a page: the account's two functions, each once", listed)
check("ok", "UpdateFunctionCode answers InProgress; the waiter function_updated_v2 waits for it to be Successful, with the new CodeSha256", new_code)
check("ok", "UpdateFunctionConfiguration answers InProgress; another change meanwhile is ResourceConflictException; the first is live once Successful", new_settings)
check("ok", "a RevisionId read before those changes is PreconditionFailedException",
      lambda: refused_as(lambda: client.update_function_configuration(FunctionName=NAME, Timeout=12, RevisionId=state.get("revision")), "PreconditionFailedException"))
check("ok", "Invoke waits for the call: $LATEST ran it, the function's answer as it returned it, the ClientContext in its context, its log with LogType Tail", invoked)
check("ok", "a function that throws: 200, FunctionError Unhandled and Lambda's error document; Event 202; DryRun 204", invoked_otherwise)
check("ok", "PublishVersion, then CreateAlias, GetAlias, UpdateAlias, ListAliases and DeleteAlias on it; ListVersionsByFunction", versions_and_aliases)
check("ok", "TagResource, ListTags and UntagResource on its ARN", tags)
check("ok", "refused as boto3 names Lambda's errors: a runtime FF lacks, a function the account hasn't", refusals)
check("ok", "operations FF doesn't offer yet are UnknownOperationException, named, sent once by a client that retries by default", not_offered)
check("ok", "DeleteFunction deletes it: GetFunction then ResourceNotFoundException", deleted)

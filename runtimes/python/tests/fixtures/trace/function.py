"""Gives back the trace the runtime set for the call, as Lambda sets _X_AMZN_TRACE_ID for each."""
import os


def handler(event, context):
    return {"trace": os.environ.get("_X_AMZN_TRACE_ID")}

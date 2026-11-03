"""Gives back what the caller said of itself, as Lambda's Python runtime hands a synchronous call's ClientContext on:
objects whose attributes are its fields, None for those it left out."""
CLIENT_FIELDS = ("installation_id", "app_title", "app_version_name", "app_version_code", "app_package_name")


def handler(event, context):
    said = context.client_context
    if said is None:
        return None
    return {
        "custom": said.custom,
        "env": said.env,
        "client": None if said.client is None else {name: getattr(said.client, name) for name in CLIENT_FIELDS},
        "slots": hasattr(said, "__dict__") or hasattr(said.client, "__dict__"),
    }

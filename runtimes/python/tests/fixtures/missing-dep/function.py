import ff_missing_dependency  # noqa: F401 - not installed, as when a package forgets to vendor it


def handler(event, context):
    return "unreachable"

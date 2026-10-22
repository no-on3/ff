def handler(event, context):
    # With spin=true the handler never returns: only killing the worker stops it.
    if event.get("spin"):
        while True:
            pass
    return "ok"

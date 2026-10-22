def handler(event, context):
    if event.get("kind") == "nan":
        return {"value": float("nan")}
    return {"items": {1, 2, 3}}

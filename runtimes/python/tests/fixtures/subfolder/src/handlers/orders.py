# A handler in a folder of the package, src/handlers/orders.create, as AWS Lambda's Python runtime imports it:
# the module src.handlers.orders, its folders packages without an __init__.py.


def create(event, context):
    return {"created": event["id"], "module": __name__}

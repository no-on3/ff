from decimal import Decimal


def handler(event, context):
    # boto3 returns DynamoDB numbers as Decimal; text stays UTF-8 rather than \u escapes.
    return {"price": Decimal("9.99"), "count": Decimal("3"), "city": "تونس"}

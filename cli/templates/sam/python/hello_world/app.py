import json


def lambda_handler(event, context):
    """Sample pure Lambda function

    Parameters
    ----------
    event: dict, required
        A function URL's request, Lambda's payload of version 2.0, as FF's URLs send it

        Event doc: https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html

    context: object, required
        Lambda Context runtime methods and attributes

        Context doc: https://docs.aws.amazon.com/lambda/latest/dg/python-context-object.html

    Returns
    ------
    A function URL's response: dict

        Return doc: https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
    """

    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "hello world",
        }),
    }

/**
 *
 * Event doc: https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 * @param {Object} event - a function URL's request, Lambda's payload of version 2.0, as FF's URLs send it
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 * @param {Object} context
 *
 * Return doc: https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 * @returns {Object} object - a function URL's response
 *
 */

export const lambdaHandler = async (event, context) => {
    const response = {
      statusCode: 200,
      body: JSON.stringify({
        message: 'hello world',
      })
    };

    return response;
  };

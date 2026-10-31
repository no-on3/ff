"""boto3 through a function's whole life against the spike's Lambda endpoint, with only the endpoint, the region and a
key, as a customer's code would have them: one JSON line a step, with the error as boto3 shows it. The steps are
run.sh's, the same for every client.
  ENDPOINT=http://... CODE=<zip> BIG=<zip> NAME=<function> python boto3_flow.py"""
import json
import os
import time

import boto3
from botocore.config import Config

name = os.environ['NAME']
region = os.environ['AWS_REGION']
client = boto3.client('lambda', endpoint_url=os.environ['ENDPOINT'], region_name=region, config=Config(retries={'mode': 'standard'}))
arn = f'arn:aws:lambda:{region}:123456789012:function:{name}'
state = {}


def step(label, run):
    started = time.monotonic()
    try:
        result = run()
        print(json.dumps({'step': label, 'ok': True, 'ms': round((time.monotonic() - started) * 1000), 'result': result}, default=str), flush=True)
    except Exception as error:  # the error as boto3 shows it, whatever it is
        meta = getattr(error, 'response', {}).get('ResponseMetadata', {})
        print(json.dumps({'step': label, 'ok': False, 'ms': round((time.monotonic() - started) * 1000), 'shown': f'{type(error).__name__}: {error}',
                          'status': meta.get('HTTPStatusCode'), 'attempts': meta.get('RetryAttempts')}), flush=True)


def read(path):
    with open(path, 'rb') as file:
        return file.read()


def reads():
    got = client.get_function(FunctionName=name)
    client.get_function_configuration(FunctionName=name, Qualifier='1')
    client.list_functions()
    client.list_versions_by_function(FunctionName=name)
    client.list_aliases(FunctionName=name)
    client.get_alias(FunctionName=name, Name='live')
    client.get_policy(FunctionName=name)
    client.get_function_url_config(FunctionName=name)
    client.list_function_url_configs(FunctionName=name)
    client.list_event_source_mappings(FunctionName=name)
    client.get_event_source_mapping(UUID=state['mapping'])
    client.get_function_event_invoke_config(FunctionName=name)
    client.list_function_event_invoke_configs(FunctionName=name)
    client.get_function_concurrency(FunctionName=name)
    client.get_function_code_signing_config(FunctionName=name)
    client.get_account_settings()
    return got['Configuration']['State']


def deletes():
    client.delete_function_concurrency(FunctionName=name)
    client.delete_function_event_invoke_config(FunctionName=name)
    client.delete_event_source_mapping(UUID=state['mapping'])
    client.remove_permission(FunctionName=name, StatementId='url')
    client.delete_function_url_config(FunctionName=name)
    client.delete_alias(FunctionName=name, Name='live')
    client.delete_function(FunctionName=name)
    return 'deleted'


def mapping():
    made = client.create_event_source_mapping(FunctionName=name, EventSourceArn=f'arn:aws:sqs:{region}:123456789012:spike', BatchSize=5)
    state['mapping'] = made['UUID']
    return made['State']


def invoke_tail():
    answer = client.invoke(FunctionName=name, Payload=json.dumps({'hello': 'spike'}), LogType='Tail')
    import base64
    return {'status': answer['StatusCode'], 'payload': answer['Payload'].read().decode(), 'logLines': base64.b64decode(answer.get('LogResult', '')).decode().count('\n')}


step('create-function', lambda: client.create_function(FunctionName=name, Runtime='nodejs22.x', Role='arn:aws:iam::123456789012:role/spike', Handler='index.handler',
                                                       Code={'ZipFile': read(os.environ['CODE'])})['State'])
step('invoke while pending', lambda: client.invoke(FunctionName=name, Payload=json.dumps({'early': True}))['StatusCode'])
step('wait function-active-v2', lambda: client.get_waiter('function_active_v2').wait(FunctionName=name))
step('invoke, with the log tail', invoke_tail)
step('invoke, asynchronously', lambda: client.invoke(FunctionName=name, InvocationType='Event', Payload='{}')['StatusCode'])
step('update-function-code, 6 MB', lambda: client.update_function_code(FunctionName=name, ZipFile=read(os.environ['BIG']))['LastUpdateStatus'])
step('update-function-configuration during the update', lambda: client.update_function_configuration(FunctionName=name, Timeout=10)['LastUpdateStatus'])
step('wait function-updated-v2', lambda: client.get_waiter('function_updated_v2').wait(FunctionName=name))
step('update-function-configuration', lambda: client.update_function_configuration(FunctionName=name, Timeout=10, Environment={'Variables': {'STAGE': 'spike'}})['LastUpdateStatus'])
step('wait function-updated-v2, again', lambda: client.get_waiter('function_updated_v2').wait(FunctionName=name))
step('publish-version', lambda: client.publish_version(FunctionName=name)['Version'])
step('create-alias', lambda: client.create_alias(FunctionName=name, Name='live', FunctionVersion='1')['AliasArn'])
step('invoke the alias', lambda: client.invoke(FunctionName=name, Qualifier='live', Payload='{}')['ExecutedVersion'])
step('invoke by the alias ARN', lambda: client.invoke(FunctionName=f'{arn}:live', Payload='{}')['ExecutedVersion'])
step('create-function-url-config', lambda: client.create_function_url_config(FunctionName=name, AuthType='NONE')['FunctionUrl'])
step('add-permission', lambda: client.add_permission(FunctionName=name, StatementId='url', Action='lambda:InvokeFunctionUrl', Principal='*', FunctionUrlAuthType='NONE') and 'added')
step('create-event-source-mapping', mapping)
step('put-function-event-invoke-config', lambda: client.put_function_event_invoke_config(FunctionName=name, MaximumRetryAttempts=1)['MaximumRetryAttempts'])
step('put-function-concurrency', lambda: client.put_function_concurrency(FunctionName=name, ReservedConcurrentExecutions=5)['ReservedConcurrentExecutions'])
step('tag-resource', lambda: client.tag_resource(Resource=arn, Tags={'team': 'spike', 'stage': 'x'}) and 'tagged')
step('untag-resource', lambda: client.untag_resource(Resource=arn, TagKeys=['stage']) and 'untagged')
step('list-tags', lambda: client.list_tags(Resource=arn)['Tags'])
step('reads', reads)
step('update-alias, weighted', lambda: client.update_alias(FunctionName=name, Name='live', FunctionVersion='1', RoutingConfig={'AdditionalVersionWeights': {}})['FunctionVersion'])
step('update-event-source-mapping while creating', lambda: client.update_event_source_mapping(UUID=state['mapping'], BatchSize=7)['State'])
step('update-function-url-config', lambda: client.update_function_url_config(FunctionName=name, AuthType='AWS_IAM')['AuthType'])
step('update-function-event-invoke-config', lambda: client.update_function_event_invoke_config(FunctionName=name, MaximumEventAgeInSeconds=600)['MaximumEventAgeInSeconds'])
step('a later operation: list-layers', lambda: client.list_layers() and 'answered')
step('a missing function: get-function', lambda: client.get_function(FunctionName='no-such-function') and 'found')
step('deletes', deletes)

import React from 'react';
import { Link } from 'react-router-dom';
import { lambdaCommands, lambdaExports } from '../lib/function-cli';
import { type Function } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import { Panel } from './Panel';

/** A function's commands for the AWS CLI at FF's Lambda endpoint, to copy, with the account's region and endpoint. */
export const FunctionAwsCli: React.FC<{ func: Pick<Function, 'name'> }> = ({ func }) => {
  const { account } = useSession();
  if (!account) return null;
  const { aws } = account;
  return (
    <Panel
      title="The AWS CLI"
      description={
        <>
          Lambda&apos;s API over this function, with one of the account&apos;s{' '}
          <Link to="/account/access-keys" className="font-medium text-ink underline">
            access keys
          </Link>{' '}
          that reaches it.
        </>
      }
    >
      {aws.lambdaEndpoint ? (
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-gray-700">Where FF&apos;s Lambda is</p>
            <Copyable value={lambdaExports(aws)} label="the region and Lambda's endpoint" testId="lambda-exports" />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-gray-700">Read it, call it with its log, give it new code, publish a version</p>
            <Copyable value={lambdaCommands(func)} label="the commands" testId="lambda-commands" />
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-gray-600">This FF has no Lambda endpoint: FF&apos;s API and ff reach the function.</p>
      )}
    </Panel>
  );
};

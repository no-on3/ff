import { Injectable } from '@nestjs/common';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { invalidParameterValue } from './lambda-error';
import { LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok } from './lambda-operations';

/**
 * Lambda's tags on a function (ADR 0014, 2): TagResource, UntagResource and
 * ListTags, the function named by its ARN, never a version's or an alias's,
 * as Lambda's tags are the function's.
 */
@Injectable()
export class LambdaTags implements LambdaHandlers {
  constructor(private readonly tags: ResourceTagsService) {}

  readonly handlers: Record<string, LambdaHandler> = {
    TagResource: async ({ input }, caller) => {
      await this.tags.tagFunction(caller.accountId, tagged(caller), tagsOf(input.Tags));
      return { status: 204 };
    },
    UntagResource: async ({ query }, caller) => {
      const keys = query.getAll('tagKeys');
      if (keys.length === 0) throw invalidParameterValue('tagKeys is required: the keys of the tags to remove.');
      await this.tags.untagFunction(caller.accountId, tagged(caller), keys);
      return { status: 204 };
    },
    ListTags: async (_call, caller) => ok({ Tags: await this.tags.ofFunction(tagged(caller)) }),
  };
}

/** The ID of the function whose tags a request names: its ARN's, unqualified. */
function tagged(caller: LambdaCaller): string {
  const function_ = namedFunction(caller);
  if (caller.named?.qualifier !== undefined) {
    throw invalidParameterValue(`Tags are a function's, not its version's or its alias's: name the function's ARN, without :${caller.named.qualifier}.`);
  }
  return function_.id;
}

/** TagResource's Tags: an object of strings, each a tag's value by its key. */
function tagsOf(sent: unknown): Record<string, string> {
  if (sent === undefined) throw invalidParameterValue('Tags is required: the tags to put on the function, each value by its key.');
  if (!sent || typeof sent !== 'object' || Array.isArray(sent) || Object.values(sent).some((value) => typeof value !== 'string')) {
    throw invalidParameterValue("Tags must be an object of strings, each tag's value by its key.");
  }
  return sent as Record<string, string>;
}

import { ApiProperty } from '@nestjs/swagger';
import { AwsEndpoint } from '../../common/aws-endpoint';

/** One thing a function's keys used, by one of the service's operations. */
export class KeyUseView {
  @ApiProperty({ enum: AwsEndpoint, description: "The service, as AWS's configuration names its endpoint" }) service: AwsEndpoint;
  @ApiProperty({ example: 'photos', description: "The bucket's or the queue's name, the e-mail identity or a message's sender; '' for the account's own, such as ListBuckets" })
  resource: string;
  @ApiProperty({ example: 'GetObject', description: "The service's operation, as the service names it" }) operation: string;
  @ApiProperty({ example: '2026-10-31', description: 'The first day the keys used it, UTC' }) firstDay: string;
  @ApiProperty({ example: '2026-11-02', description: 'The last day, UTC' }) lastDay: string;
}

/** GET /functions/:id/key-uses: what the function's keys used of the account's buckets, queues and mail. */
export class FunctionKeyUsesView {
  @ApiProperty({ type: [KeyUseView], description: 'By service, resource and operation' }) uses: KeyUseView[];
}

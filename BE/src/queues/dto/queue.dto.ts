import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** SQS's redrive policy: after maxReceiveCount receives, a message goes to the dead-letter queue its ARN names. */
export class RedrivePolicyDto {
  @ApiProperty({ example: 'arn:aws:sqs:tn-tunis-1:000000000001:orders-dlq', description: "The dead-letter queue: another queue of the account's, by its ARN" })
  @IsString()
  @MaxLength(256)
  deadLetterTargetArn: string;

  @ApiProperty({ example: 5, minimum: 1, maximum: 1000, description: 'How many times a message is received before it goes there' })
  @IsInt()
  @Min(1)
  @Max(1000)
  maxReceiveCount: number;
}

/** A queue's attributes, as SQS's are named, each left as it is when not given. */
export class QueueAttributesDto {
  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: 43_200, description: 'SQS\'s VisibilityTimeout, in seconds: how long a message received is hidden; 30 by default' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(43_200)
  visibilityTimeout?: number;

  @ApiPropertyOptional({ example: 345_600, minimum: 60, maximum: 1_209_600, description: "SQS's MessageRetentionPeriod, in seconds: how long a message is kept; 4 days by default" })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(1_209_600)
  messageRetentionPeriod?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 900, description: "SQS's DelaySeconds: how long a new message waits before it can be received" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(900)
  delaySeconds?: number;

  @ApiPropertyOptional({ example: 1_048_576, minimum: 1024, maximum: 1_048_576, description: "SQS's MaximumMessageSize, in bytes: a message's body and attributes together" })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(1_048_576)
  maximumMessageSize?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 20, description: "SQS's ReceiveMessageWaitTimeSeconds: how long a receive that names no wait waits for a message" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  receiveMessageWaitTimeSeconds?: number;

  @ApiPropertyOptional({ type: RedrivePolicyDto, nullable: true, description: "SQS's RedrivePolicy; null removes it" })
  @IsOptional()
  @ValidateNested()
  @Type(() => RedrivePolicyDto)
  redrivePolicy?: RedrivePolicyDto | null;
}

/** POST /queues. */
export class CreateQueueDto extends QueueAttributesDto {
  @ApiProperty({ example: 'orders', description: "The queue's name, SQS's rule: 1 to 80 letters, digits, hyphens or underscores, the account's own" })
  @IsString()
  @Length(1, 80)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'name must be 1 to 80 letters, digits, hyphens or underscores, as an SQS queue\'s name' })
  name: string;
}

/** PATCH /queues/:name: the attributes given change, the others stay, as SQS's SetQueueAttributes. */
export class UpdateQueueDto extends QueueAttributesDto {}

/** A queue's messages, as SQS counts them, roughly. */
export class QueueMessagesView {
  @ApiProperty({ example: 3, description: "That can be received now: SQS's ApproximateNumberOfMessages" })
  available: number;

  @ApiProperty({ example: 1, description: "Received and hidden for their visibility timeout: ApproximateNumberOfMessagesNotVisible" })
  inFlight: number;

  @ApiProperty({ example: 0, description: 'Waiting for their delay: ApproximateNumberOfMessagesDelayed' })
  delayed: number;
}

/** A queue, as the API shows it. */
export class QueueView {
  @ApiProperty({ example: 'orders' })
  name: string;

  @ApiProperty({ example: 'https://sqs.ffunc.tn/000000000001/orders', description: "Its URL, which SQS's requests name, under the SQS endpoint" })
  url: string;

  @ApiProperty({ example: 'arn:aws:sqs:tn-tunis-1:000000000001:orders', description: 'Its ARN, as a redrive policy or a destination names it' })
  arn: string;

  @ApiProperty({ example: 30 })
  visibilityTimeout: number;

  @ApiProperty({ example: 345_600 })
  messageRetentionPeriod: number;

  @ApiProperty({ example: 0 })
  delaySeconds: number;

  @ApiProperty({ example: 1_048_576 })
  maximumMessageSize: number;

  @ApiProperty({ example: 0 })
  receiveMessageWaitTimeSeconds: number;

  @ApiProperty({ type: RedrivePolicyDto, nullable: true })
  redrivePolicy: RedrivePolicyDto | null;

  @ApiProperty({ type: QueueMessagesView })
  messages: QueueMessagesView;

  @ApiProperty({ example: 2_048, description: 'What its messages hold together, in bytes, as the plan counts them' })
  sizeBytes: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** A message attribute, as SQS's: its type, and a string, or binary in base64. */
export class MessageAttributeDto {
  @ApiProperty({ example: 'String', description: 'String, Number or Binary, with a custom part if any, as String.json' })
  @IsString()
  dataType: string;

  @ApiPropertyOptional({ example: 'harissa' })
  @IsOptional()
  @IsString()
  stringValue?: string;

  @ApiPropertyOptional({ example: 'iVBORw==', description: 'For a Binary type: its bytes, in base64' })
  @IsOptional()
  @IsString()
  binaryValue?: string;
}

/** POST /queues/:name/messages: a message to send, as SQS's SendMessage takes one. */
export class SendMessageDto {
  @ApiProperty({ example: '{"order": 42}', description: "Its body: text of at least a character, up to the queue's maximum message size with its attributes" })
  @IsString()
  body: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { $ref: '#/components/schemas/MessageAttributeDto' }, description: 'Its attributes, ten at most, by name' })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, MessageAttributeDto>;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 900, description: "How long it waits before it can be received; the queue's delay without it" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(900)
  delaySeconds?: number;
}

/** A message sent: its ID, and the MD5 sums SQS answers. */
export class SentMessageView {
  @ApiProperty({ example: '6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77' })
  messageId: string;

  @ApiProperty({ example: '0f4a0b7c3c2d5f0e1a9b8c7d6e5f4a3b' })
  md5OfBody: string;
}

/** POST /queues/:name/receive: as SQS's ReceiveMessage. */
export class ReceiveMessagesDto {
  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 10, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxMessages?: number;

  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: 43_200, description: "How long each is hidden from other receives; the queue's visibility timeout without it" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(43_200)
  visibilityTimeout?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 20, description: "A long poll: how long to wait for a message when there is none; the queue's wait without it" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  waitTimeSeconds?: number;
}

/** A message received: as it was sent, with the receipt handle that deletes it. */
export class ReceivedMessageView {
  @ApiProperty({ example: '6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77' })
  messageId: string;

  @ApiProperty({ description: 'This receive\'s handle: DELETE /queues/:name/messages/:receiptHandle deletes the message with it, until it is received again' })
  receiptHandle: string;

  @ApiProperty({ example: '{"order": 42}' })
  body: string;

  @ApiProperty({ type: 'object', additionalProperties: { $ref: '#/components/schemas/MessageAttributeDto' } })
  attributes: Record<string, MessageAttributeDto>;

  @ApiProperty({ example: 1, description: 'How many times it was received, this time included' })
  receiveCount: number;

  @ApiProperty({ example: 'AKFF7Q2MLKX4RTZB3W5N', description: 'Who sent it: an access key, an API key or a user, or a function\'s ARN for its destination records' })
  senderId: string;

  @ApiProperty()
  sentAt: Date;
}

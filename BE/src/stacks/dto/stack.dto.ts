import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length, Matches, ValidateIf, ValidateNested, ValidationOptions, registerDecorator } from 'class-validator';

/** A stack's name, as CloudFormation's: letters, digits and hyphens, a letter first. */
export const STACK_NAME = /^[A-Za-z][-A-Za-z0-9]*$/;
export const STACK_NAME_LENGTH = 128;
/** A template's logical ID, and a parameter's name: letters and digits, as CloudFormation's. */
export const LOGICAL_ID = /^[A-Za-z0-9]+$/;
/** A resource's type, as AWS::Serverless::Function. */
export const RESOURCE_TYPE = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/;
/** CloudFormation's most: resources in a template, parameters, a parameter's value in bytes. */
export const MAX_STACK_RESOURCES = 500;
export const MAX_STACK_PARAMETERS = 200;
export const MAX_PARAMETER_VALUE = 4096;

/** What is wrong with a stack's parameters: names to strings, as CloudFormation takes them. */
export function parametersProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ["parameters maps a parameter's name to its value"];
  const entries = Object.entries(value);
  const problems = entries.length > MAX_STACK_PARAMETERS ? [`parameters has ${entries.length} parameters, past CloudFormation's ${MAX_STACK_PARAMETERS}`] : [];
  for (const [name, given] of entries) {
    if (!LOGICAL_ID.test(name) || name.length > 255) problems.push(`parameters: ${JSON.stringify(name).slice(0, 80)} isn't a parameter's name, letters and digits, 255 at most`);
    else if (typeof given !== 'string') problems.push(`parameters: ${name}'s value is a string`);
    else if (Buffer.byteLength(given) > MAX_PARAMETER_VALUE) problems.push(`parameters: ${name}'s value is past CloudFormation's ${MAX_PARAMETER_VALUE} bytes`);
  }
  return problems;
}

const IsParameters = (options?: ValidationOptions): PropertyDecorator => (target, propertyName) =>
  registerDecorator({
    name: 'isParameters',
    target: target.constructor,
    propertyName: propertyName as string,
    options,
    validator: { validate: (value: unknown) => parametersProblems(value).length === 0, defaultMessage: (args) => parametersProblems(args?.value).join('; ') },
  });

/** A resource of a stack, as PUT /stacks/{name} takes it. */
export class StackResourceDto {
  @ApiProperty({ example: 'HelloFunction', maxLength: 255, description: "Its logical ID in the template: letters and digits, as CloudFormation's" })
  @IsString()
  @Length(1, 255)
  @Matches(LOGICAL_ID, { message: "logicalId is letters and digits, as CloudFormation's" })
  logicalId: string;

  @ApiProperty({ example: 'AWS::Serverless::Function', maxLength: 256 })
  @IsString()
  @Length(1, 256)
  @Matches(RESOURCE_TYPE, { message: 'type is a resource type, as AWS::Serverless::Function' })
  type: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'hello',
    maxLength: 1024,
    description:
      "The FF resource it made, as CloudFormation's physical ID: a function's, a queue's or a bucket's name, which must be the account's, " +
      "with a version's number or an alias's name after a colon for what is a version's or an alias's; null for what FF keeps without effect",
  })
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  @Length(1, 1024)
  physicalId: string | null;
}

/** PUT /stacks/{name}: the stack as a deploy left it, whole. */
export class PutStackDto {
  @ApiProperty({ example: 'b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c', description: "The template's SHA-256, in lowercase hexadecimal" })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'templateSha256 is a SHA-256, 64 lowercase hexadecimal characters' })
  templateSha256: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { Stage: 'prod' },
    description: "The parameters' values it was deployed with, by name, which the next deploy takes as their previous values; a NoEcho one's left out",
  })
  @IsOptional()
  @IsParameters()
  parameters?: Record<string, string>;

  @ApiProperty({ type: [StackResourceDto], maxItems: MAX_STACK_RESOURCES, description: 'Each resource the template made, by its logical ID' })
  @IsArray()
  @ArrayMaxSize(MAX_STACK_RESOURCES)
  @ValidateNested({ each: true })
  @Type(() => StackResourceDto)
  resources: StackResourceDto[];
}

export class StackResourceView {
  @ApiProperty({ example: 'HelloFunction' }) logicalId: string;
  @ApiProperty({ example: 'AWS::Serverless::Function' }) type: string;
  @ApiProperty({ nullable: true, type: String, example: 'hello', description: 'The FF resource it made; null for what FF keeps without effect' }) physicalId: string | null;
}

/** A stack, as GET and PUT /stacks/{name} answer it. */
export class StackView {
  @ApiProperty({ example: 'orders' }) name: string;
  @ApiProperty() templateSha256: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, example: { Stage: 'prod' } }) parameters: Record<string, string>;
  @ApiProperty({ type: [StackResourceView], description: 'By logical ID' }) resources: StackResourceView[];
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

/** A stack, as GET /stacks lists it: its resources counted. */
export class StackSummary {
  @ApiProperty({ example: 'orders' }) name: string;
  @ApiProperty() templateSha256: string;
  @ApiProperty({ example: 4 }) resources: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

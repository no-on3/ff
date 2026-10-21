import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { UrlAuthType, UrlCors, UrlInvokeMode } from '../../functions/entities/function-url.entity';
import { TOKEN } from '../url-response';

/** The methods a URL's CORS may allow, as AWS Lambda's console offers them; "*" is any. */
export const CORS_METHODS = ['GET', 'PUT', 'HEAD', 'POST', 'PATCH', 'DELETE', '*'] as const;
/** An origin as a browser sends it: a scheme, "://", and a host with its port if any; nothing after. Or "*", any. */
const ORIGIN = /^(\*|[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)$/i;

/** A function URL's CORS, as AWS Lambda's Cors, with its limits. */
export class CorsDto implements UrlCors {
  @ApiPropertyOptional({ description: 'Whether a browser may send cookies and credentials with its requests' })
  @IsOptional()
  @IsBoolean()
  allowCredentials?: boolean;

  @ApiPropertyOptional({ type: [String], maxItems: 100, example: ['content-type', 'x-custom-header'], description: 'The headers a browser may send; "*" is any' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  @Matches(TOKEN, { each: true, message: 'each of allowHeaders must be a header name, or *' })
  allowHeaders?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 6, enum: CORS_METHODS, example: ['GET', 'POST'], description: 'The methods a browser may use; "*" is any' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(CORS_METHODS, { each: true, message: `each of allowMethods must be one of ${CORS_METHODS.join(', ')}` })
  allowMethods?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 100, example: ['https://www.example.tn'], description: 'The origins that may call the URL from a browser; "*" is any' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  @Matches(ORIGIN, { each: true, message: 'each of allowOrigins must be an origin, such as https://www.example.tn, or *' })
  allowOrigins?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 100, example: ['x-total-count'], description: "The answer's headers a browser's script may read" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  @Matches(TOKEN, { each: true, message: 'each of exposeHeaders must be a header name' })
  exposeHeaders?: string[];

  @ApiPropertyOptional({ minimum: 0, maximum: 86400, description: 'How many seconds a browser may keep the answer to its preflight' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  maxAge?: number;
}

const AUTH_TYPE_DESCRIPTION =
  'NONE: anyone may call the URL. AWS_IAM: only a caller with an API key of the account with functions:invoke, sent as ' +
  '"Authorization: Bearer ffk_…", which the function never sees; AWS signs these calls with SigV4 instead.';
const CORS_DESCRIPTION =
  'With it, the URL answers browsers\' preflights itself and adds its CORS headers to every answer, in place of any the ' +
  'function sends; without it, the function answers them.';

/** POST /functions/{id}/url: the URL's configuration, as AWS Lambda's CreateFunctionUrlConfig takes it. */
export class CreateFunctionUrlDto {
  @ApiProperty({ enum: UrlAuthType, description: AUTH_TYPE_DESCRIPTION })
  @IsEnum(UrlAuthType, { message: 'authType must be NONE or AWS_IAM' })
  authType: UrlAuthType;

  @ApiPropertyOptional({ type: CorsDto, nullable: true, description: CORS_DESCRIPTION })
  @IsOptional()
  @ValidateNested()
  @Type(() => CorsDto)
  cors?: CorsDto | null;

  @ApiPropertyOptional({ enum: UrlInvokeMode, description: 'BUFFERED: the answer is sent whole, once the function returns. Streaming isn\'t offered' })
  @IsOptional()
  @IsEnum(UrlInvokeMode, { message: "invokeMode must be BUFFERED: FF doesn't stream answers" })
  invokeMode?: UrlInvokeMode;
}

/** PUT /functions/{id}/url: what changes, as AWS Lambda's UpdateFunctionUrlConfig takes it; what is left out stays, and cors null removes it. */
export class UpdateFunctionUrlDto {
  @ApiPropertyOptional({ enum: UrlAuthType, description: AUTH_TYPE_DESCRIPTION })
  @IsOptional()
  @IsEnum(UrlAuthType, { message: 'authType must be NONE or AWS_IAM' })
  authType?: UrlAuthType;

  @ApiPropertyOptional({ type: CorsDto, nullable: true, description: `${CORS_DESCRIPTION} null removes it.` })
  @IsOptional()
  @ValidateNested()
  @Type(() => CorsDto)
  cors?: CorsDto | null;

  @ApiPropertyOptional({ enum: UrlInvokeMode })
  @IsOptional()
  @IsEnum(UrlInvokeMode, { message: "invokeMode must be BUFFERED: FF doesn't stream answers" })
  invokeMode?: UrlInvokeMode;
}

/** A function's URL, as the API answers it. */
export class FunctionUrlView {
  @ApiProperty({ example: 'https://0123456789abcdefghijklmnopqrstuv.fn.example.tn/', description: 'Its address, fixed for its life' })
  functionUrl: string;

  @ApiProperty()
  functionId: string;

  @ApiProperty({ enum: UrlAuthType })
  authType: UrlAuthType;

  @ApiProperty({ type: CorsDto, nullable: true })
  cors: UrlCors | null;

  @ApiProperty({ enum: UrlInvokeMode })
  invokeMode: UrlInvokeMode;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

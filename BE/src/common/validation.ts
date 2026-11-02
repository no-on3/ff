import { ValidationPipeOptions } from '@nestjs/common';

/**
 * How FF's API checks a request's body against its DTO: the DTO's properties
 * alone, each other one refused, the values turned into the DTO's types.
 * Lambda's CreateFunction checks the create it makes of its request the same way.
 */
export const DTO_VALIDATION: ValidationPipeOptions = { whitelist: true, transform: true, forbidNonWhitelisted: true };

import { ApiProperty } from '@nestjs/swagger';
import { IsSecretChanges } from '../environment';

/** PATCH /functions/{id}/secrets: secrets to set, and to remove. */
export class UpdateSecretsDto {
  @ApiProperty({
    description:
      'Secrets to set, each name to its value, and to remove, each name to null; the others stay. The same name rule as ' +
      "variables, a name being one or the other, and the 4 KB counts them together. A change rolls out a new version, and " +
      'the answer comes once it is live. Values are never answered, nor logged.',
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    example: { DB_PASSWORD: 'correct-horse-battery-staple', OLD_TOKEN: null },
  })
  @IsSecretChanges()
  secrets: Record<string, string | null>;
}

/** A secret, as the API says it: its name, and when its value was set. Never the value. */
export class SecretView {
  @ApiProperty({ example: 'DB_PASSWORD' })
  name: string;

  @ApiProperty({ description: 'When its value was set: RFC 3339, UTC', example: '2026-10-21T08:00:00.000Z' })
  updatedAt: string;
}

export class SecretsView {
  @ApiProperty({ type: [SecretView], description: 'By name' })
  secrets: SecretView[];
}

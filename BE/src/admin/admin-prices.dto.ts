import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PlanSummary } from '../plans/plan.dto';
import { AdminChange } from './admin.dto';

/** past: an earlier book replaced it; active: it prices usage now; scheduled: it starts later, and can still go. */
export type BookStatus = 'past' | 'active' | 'scheduled';

export class PriceBookView {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ description: "From this instant until the next book's" }) validFrom: Date;
  @ApiProperty({ enum: ['past', 'active', 'scheduled'] }) status: BookStatus;
  @ApiProperty({ example: 'system', description: 'system for the first book, operator:<id> for the next ones' }) createdBy: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Its source, free tier and prices (D8)' }) document: Record<string, unknown>;
}

/** POST /admin/price-books: a new book, which starts later. */
export class CreatePriceBookDto extends AdminChange {
  @ApiProperty({ example: '2026-11-01T00:00:00Z', description: 'A whole hour (UTC), from the next one on' })
  @IsISO8601({ strict: true })
  validFrom: string;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The book: currency, source, freeTier and prices, as GET /admin/price-books shows them' })
  @IsObject()
  document: Record<string, unknown>;
}

/** POST /admin/price-books/preview: a draft, to price last month with. */
export class PreviewPriceBookDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  document: Record<string, unknown>;
}

export class PreviewAccountView {
  @ApiProperty({ example: '000000000001' }) accountId: string;
  @ApiProperty({ example: 'Tunis Labs' }) name: string;
  @ApiProperty({ nullable: true, type: String, example: '8.222', description: 'At the books valid then; null where none was' }) current: string | null;
  @ApiProperty({ example: '9.104', description: 'At the draft, for the whole month' }) draft: string;
}

/** Last month, priced with the draft, next to what the books valid then give. Nothing was charged yet (P-31). */
export class PriceBookPreviewView {
  @ApiProperty({ example: '2026-10', description: 'Last month, by the UTC calendar' }) month: string;
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ type: [PreviewAccountView], description: 'Each account that used something in the month' }) accounts: PreviewAccountView[];
  @ApiProperty({ example: { current: '8.222', draft: '9.104' }, description: 'All of them: the exact sums, rounded once' })
  totals: { current: string; draft: string };
}

/** A plan's ID, as plans name them: "beta". */
const PLAN_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** PUT /admin/plans/:id: new limits, every one of D5, and maybe a new name. */
export class UpdatePlanDto extends AdminChange {
  @ApiPropertyOptional({ example: 'Beta' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @ApiProperty({ type: 'object', additionalProperties: true, description: "Every limit, as GET /admin/plans shows a plan's" })
  @IsObject()
  limits: Record<string, unknown>;
}

/** POST /admin/plans: a plan accounts can be moved to. */
export class CreatePlanDto extends AdminChange {
  @ApiProperty({ example: 'pro' })
  @Matches(PLAN_ID, { message: 'id must be a plan ID: lowercase letters, digits, - and _, such as pro' })
  id: string;

  @ApiProperty({ example: 'Pro' })
  @IsString()
  @Length(1, 60)
  name: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  limits: Record<string, unknown>;
}

/** A changed plan, and its new quota's way to the accounts on it. */
export class PlanChangeView {
  @ApiProperty({ type: PlanSummary }) plan: PlanSummary;
  @ApiProperty({
    example: { applied: 3, failed: 0 },
    description: "Accounts whose namespace got the new quota, and those whose couldn't (their next deploy writes it)",
  })
  quota: { applied: number; failed: number };
}

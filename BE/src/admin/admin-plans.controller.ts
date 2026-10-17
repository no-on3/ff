import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { PlanSummary } from '../plans/plan.dto';
import { PlansService } from '../plans/plans.service';
import { CreatePlanDto, PlanChangeView, UpdatePlanDto } from './admin-prices.dto';
import { AdminRoutes } from './operator';

class PlanIdParam {
  @Matches(/^[a-z0-9][a-z0-9_-]{0,39}$/, { message: 'id must be a plan ID, such as beta' })
  id: string;
}

/** Plans and their limits (D5): the ones an account can be moved to (P-71), and their edits (P-73). */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({ summary: 'Every plan, with its limits (operators only)' })
  @ApiResponse({ status: 200, type: [PlanSummary] })
  list(): Promise<PlanSummary[]> {
    return this.plans.list();
  }

  @Post()
  @ApiOperation({ summary: 'A new plan, with every limit of D5 (operators only)' })
  @ApiResponse({ status: 201, type: PlanSummary })
  create(@Body() body: CreatePlanDto): Promise<PlanSummary> {
    return this.plans.create(body.id, body.name, body.limits, body.reason);
  }

  @Put(':id')
  @ApiOperation({ summary: "A plan's new limits: they apply at once, and a new quota goes to every account on the plan (operators only)" })
  @ApiResponse({ status: 200, type: PlanChangeView })
  update(@Param() { id }: PlanIdParam, @Body() body: UpdatePlanDto): Promise<PlanChangeView> {
    return this.plans.update(id, { name: body.name, limits: body.limits }, body.reason);
  }
}

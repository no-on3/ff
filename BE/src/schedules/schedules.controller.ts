import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CreateScheduleDto, NextRunsQuery, NextRunsView, ScheduleView, UpdateScheduleDto } from './dto/schedule.dto';
import { SchedulesService } from './schedules.service';

const EXPRESSIONS =
  "Expressions are EventBridge's, in UTC: rate(1 minute), rate(5 minutes), rate(1 hour), rate(2 days)… whose first run comes one interval " +
  'after the schedule starts; or cron(minutes hours day-of-month month day-of-week year), such as cron(0 8 * * ? *), every day at 08:00 UTC, ' +
  'with , - * / ? L W # and the names JAN-DEC and SUN-SAT, one of the two days "?".';

/**
 * A function's schedules, as SAM's Schedule events declare them: every member
 * reads them; owners and developers make, change and delete them. Deleting
 * needs no active account.
 */
@ApiTags('functions')
@Controller('functions/:id/schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's schedules, each with its next run and how its last one went" })
  @ApiResponse({ status: 200, type: [ScheduleView] })
  list(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<ScheduleView[]> {
    return this.schedules.list(principal.accountId, id);
  }

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Run the function on a schedule',
    description:
      `${EXPRESSIONS} Each run calls the function with EventBridge's Scheduled Event, or the schedule's input, as a call like any other: it counts ` +
      "against the plan's invocations per second, needs credit, and is in the history as the schedule's. A run happens at most once, and isn't retried.",
  })
  @ApiResponse({ status: 201, type: ScheduleView })
  @ApiResponse({ status: 400, description: "An expression EventBridge wouldn't take, the plan's limit, or a function that takes FF's original wrapped event" })
  @ApiResponse({ status: 409, description: 'Another of the function\'s schedules has the name' })
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateScheduleDto, @Principal() principal: Principal): Promise<ScheduleView> {
    return this.schedules.create(principal.accountId, id, dto);
  }

  @Get(':scheduleId')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'A schedule' })
  @ApiResponse({ status: 200, type: ScheduleView })
  get(@Param('id', ParseUUIDPipe) id: string, @Param('scheduleId', ParseUUIDPipe) scheduleId: string, @Principal() principal: Principal): Promise<ScheduleView> {
    return this.schedules.get(principal.accountId, id, scheduleId);
  }

  @Put(':scheduleId')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Change a schedule',
    description: 'What is left out stays. A new expression, or being enabled again, starts its runs anew from now; disabled, it has none.',
  })
  @ApiResponse({ status: 200, type: ScheduleView })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: UpdateScheduleDto,
    @Principal() principal: Principal,
  ): Promise<ScheduleView> {
    return this.schedules.update(principal.accountId, id, scheduleId, dto);
  }

  @Delete(':scheduleId')
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a schedule: it runs no more' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Param('scheduleId', ParseUUIDPipe) scheduleId: string, @Principal() principal: Principal): Promise<void> {
    await this.schedules.remove(principal.accountId, id, scheduleId);
  }
}

/** An expression's next runs, for the console's preview as it is typed. */
@ApiTags('functions')
@Controller('schedules')
export class ScheduleRunsController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get('next-runs')
  @RequireScope('functions:read')
  @ApiOperation({ summary: "An expression's next five runs, in UTC", description: EXPRESSIONS })
  @ApiResponse({ status: 200, type: NextRunsView })
  @ApiResponse({ status: 400, description: "An expression EventBridge wouldn't take, and what is wrong in it" })
  nextRuns(@Query() query: NextRunsQuery): NextRunsView {
    return { runs: this.schedules.previewRuns(query.expression) };
  }
}

import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, WRITERS } from '../auth/route-rules';
import { CreateFunctionDto } from './dto/create-function.dto';
import { InvokeFunctionDto } from './dto/invoke-function.dto';
import { ListInvocationsQuery } from './dto/list-invocations.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { ScalingConfig, UpdateScalingConfigDto } from './dto/update-scaling-config.dto';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { FunctionsService } from './functions.service';

/**
 * Every route acts for the caller's account (D4): without a principal it
 * answers 401, and another account's function answers 404, exactly like one
 * that doesn't exist. The service scopes every query to the account. Viewers
 * only read; deploying and invoking need an active account (P-12).
 */
@ApiTags('functions')
@Controller('functions')
export class FunctionsController {
  constructor(private readonly functionsService: FunctionsService) {}

  @Post()
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Create a new function' })
  @ApiResponse({ status: 201, description: 'Function created successfully', type: Function })
  async create(@Body() createFunctionDto: CreateFunctionDto, @Principal() principal: Principal): Promise<Function> {
    return this.functionsService.create(principal.accountId, createFunctionDto);
  }

  @Get()
  @ApiOperation({ summary: "List the account's functions" })
  @ApiResponse({ status: 200, description: 'List of functions', type: [Function] })
  async findAll(@Principal() principal: Principal): Promise<Function[]> {
    return this.functionsService.findAll(principal.accountId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a function by ID' })
  @ApiResponse({ status: 200, description: 'Function details', type: Function })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<Function> {
    return this.functionsService.findOne(principal.accountId, id);
  }

  @Put(':id')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Update a function' })
  @ApiResponse({ status: 200, description: 'Function updated successfully', type: Function })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateFunctionDto: UpdateFunctionDto,
    @Principal() principal: Principal,
  ): Promise<Function> {
    return this.functionsService.update(principal.accountId, id, updateFunctionDto);
  }

  @Delete(':id')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a function' })
  @ApiResponse({ status: 200, description: 'Function deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<void> {
    await this.functionsService.remove(principal.accountId, id);
  }

  @Post(':id/invoke')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Invoke a function' })
  @ApiResponse({ status: 201, description: 'Function invoked successfully', type: FunctionInvocation })
  async invoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() invokeFunctionDto: InvokeFunctionDto,
    @Principal() principal: Principal,
  ): Promise<FunctionInvocation> {
    return this.functionsService.invoke(principal.accountId, id, invokeFunctionDto.input);
  }

  @Get(':id/invocations')
  @ApiOperation({ summary: 'Get function invocations, newest first' })
  @ApiResponse({ status: 200, description: 'List of function invocations', type: [FunctionInvocation] })
  async getInvocations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: ListInvocationsQuery,
    @Principal() principal: Principal,
  ): Promise<{ invocations: FunctionInvocation[]; total: number }> {
    return this.functionsService.getInvocations(principal.accountId, id, page);
  }

  @Get(':id/scaling-config')
  @ApiOperation({ summary: 'Get function scaling configuration' })
  @ApiResponse({ status: 200, description: 'Scaling configuration details', type: ScalingConfig })
  async getScalingConfig(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<ScalingConfig> {
    return this.functionsService.scalingConfig(await this.functionsService.findOne(principal.accountId, id));
  }

  @Put(':id/scaling-config')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Change how many instances a function may have' })
  @ApiResponse({ status: 200, description: 'The new scaling configuration', type: ScalingConfig })
  async updateScalingConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateScalingConfigDto: UpdateScalingConfigDto,
    @Principal() principal: Principal,
  ): Promise<ScalingConfig> {
    return this.functionsService.updateScalingConfig(principal.accountId, id, updateScalingConfigDto);
  }
}

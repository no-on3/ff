import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../auth/decorators/user.decorator';
import { CreateFunctionDto } from './dto/create-function.dto';
import { InvokeFunctionDto } from './dto/invoke-function.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { ScalingConfig, UpdateScalingConfigDto } from './dto/update-scaling-config.dto';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { FunctionsService } from './functions.service';

/**
 * Every endpoint needs a tenant (@User: 401 without one). Ownership is checked
 * on update and delete only; tenant-scoped reads and invokes come with
 * authentication (parent plan F-01).
 */
@ApiTags('functions')
@Controller('functions')
export class FunctionsController {
  constructor(private readonly functionsService: FunctionsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new function' })
  @ApiResponse({ status: 201, description: 'Function created successfully', type: Function })
  async create(@Body() createFunctionDto: CreateFunctionDto, @User() userId: string): Promise<Function> {
    return this.functionsService.create(createFunctionDto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'Get all functions for the user' })
  @ApiResponse({ status: 200, description: 'List of functions', type: [Function] })
  async findAll(@User() userId: string): Promise<Function[]> {
    return this.functionsService.findAllByUser(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a function by ID' })
  @ApiResponse({ status: 200, description: 'Function details', type: Function })
  async findOne(@Param('id') id: string, @User() userId: string): Promise<Function> {
    return this.functionsService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a function' })
  @ApiResponse({ status: 200, description: 'Function updated successfully', type: Function })
  async update(
    @Param('id') id: string,
    @Body() updateFunctionDto: UpdateFunctionDto,
    @User() userId: string,
  ): Promise<Function> {
    const func = await this.functionsService.findOne(id);
    if (func.userId !== userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    return this.functionsService.update(id, updateFunctionDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a function' })
  @ApiResponse({ status: 200, description: 'Function deleted successfully' })
  async remove(@Param('id') id: string, @User() userId: string): Promise<void> {
    const func = await this.functionsService.findOne(id);
    if (func.userId !== userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    await this.functionsService.remove(id);
  }

  @Post(':id/invoke')
  @ApiOperation({ summary: 'Invoke a function' })
  @ApiResponse({ status: 200, description: 'Function invoked successfully', type: FunctionInvocation })
  async invoke(
    @Param('id') id: string,
    @Body() invokeFunctionDto: InvokeFunctionDto,
    @User() userId: string,
  ): Promise<FunctionInvocation> {
    return this.functionsService.invoke(id, invokeFunctionDto.input);
  }

  @Get(':id/invocations')
  @ApiOperation({ summary: 'Get function invocations' })
  @ApiResponse({ status: 200, description: 'List of function invocations', type: [FunctionInvocation] })
  async getInvocations(
    @Param('id') id: string,
    @Query('limit') limit = 10,
    @Query('offset') offset = 0,
    @User() userId: string,
  ): Promise<{ invocations: FunctionInvocation[]; total: number }> {
    await this.functionsService.findOne(id); // 404 for an unknown function
    return this.functionsService.getInvocations(id, limit, offset);
  }

  @Get(':id/scaling-config')
  @ApiOperation({ summary: 'Get function scaling configuration' })
  @ApiResponse({ status: 200, description: 'Scaling configuration details', type: ScalingConfig })
  async getScalingConfig(@Param('id') id: string, @User() userId: string): Promise<ScalingConfig> {
    return this.functionsService.scalingConfig(await this.functionsService.findOne(id));
  }

  @Put(':id/scaling-config')
  @ApiOperation({ summary: 'Change how many instances a function may have' })
  @ApiResponse({ status: 200, description: 'The new scaling configuration', type: ScalingConfig })
  async updateScalingConfig(
    @Param('id') id: string,
    @Body() updateScalingConfigDto: UpdateScalingConfigDto,
    @User() userId: string,
  ): Promise<ScalingConfig> {
    const func = await this.functionsService.findOne(id);
    if (func.userId !== userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    return this.functionsService.updateScalingConfig(id, updateScalingConfigDto);
  }
}

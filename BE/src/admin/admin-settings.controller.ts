import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SettingsView, UpdateSettingsDto } from './admin.dto';
import { AdminRoutes } from './operator';
import { DEFAULT_SETTINGS } from './platform-settings';
import { PlatformSettingsService } from './platform-settings.service';

/** The platform's settings (P-70, D12): billing and platform values, changed from the admin dashboard. */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: "The platform's settings, with their defaults (operators only)" })
  @ApiResponse({ status: 200, type: SettingsView })
  async get(): Promise<SettingsView> {
    return { settings: await this.settings.get(), defaults: DEFAULT_SETTINGS };
  }

  @Put()
  @ApiOperation({ summary: 'Change some settings, with a reason that the audit log keeps (operators only)' })
  @ApiResponse({ status: 200, type: SettingsView })
  async update(@Body() body: UpdateSettingsDto): Promise<SettingsView> {
    return { settings: await this.settings.update(body.settings, body.reason), defaults: DEFAULT_SETTINGS };
  }
}

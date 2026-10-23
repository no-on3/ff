import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditModule } from '../audit/audit.module';
import { DataDbSettings } from '../config/configuration';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { DATA_SERVER, DataServer, PostgresDataServer } from './data-server';
import { DatabaseSamplesService } from './database-samples.service';
import { Database } from './database.entity';
import { DatabasesController } from './databases.controller';
import { DatabasesService } from './databases.service';

/** Customers' databases (ADR 0008): their routes, their hourly samples, and the server they live on, none without FF_DATA_DB_HOST. */
@Module({
  imports: [TypeOrmModule.forFeature([Database, Account]), AuditModule, NotificationsModule, OrchestratorModule, PlansModule],
  controllers: [DatabasesController],
  providers: [
    DatabasesService,
    DatabaseSamplesService,
    {
      provide: DATA_SERVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DataServer | null => {
        const settings = config.get<DataDbSettings | null>('dataDb');
        return settings ? new PostgresDataServer(settings) : null;
      },
    },
  ],
  exports: [DatabasesService],
})
export class DatabasesModule implements OnModuleDestroy {
  constructor(@Inject(DATA_SERVER) private readonly server: DataServer | null) {}

  async onModuleDestroy(): Promise<void> {
    if (this.server instanceof PostgresDataServer) await this.server.close();
  }
}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailModule } from '../mail/mail.module';
import { PlansModule } from '../plans/plans.module';
import { AuditModule } from '../audit/audit.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { Invitation } from './entities/invitation.entity';
import { Account } from './entities/account.entity';
import { Membership } from './entities/membership.entity';
import { Plan } from './entities/plan.entity';
import { User } from './entities/user.entity';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [TypeOrmModule.forFeature([Plan, Account, User, Membership, Invitation]), MailModule, PlansModule, AuditModule],
  controllers: [AccountsController, MembersController],
  providers: [AccountsService, MembersService],
  exports: [AccountsService, MembersService],
})
export class AccountsModule {}

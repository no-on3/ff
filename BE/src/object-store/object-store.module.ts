import { Module } from '@nestjs/common';
import { ObjectStoreService } from './object-store.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [ObjectStoreService],
  exports: [ObjectStoreService],
})
export class ObjectStoreModule {}

import { Module } from '@nestjs/common';
import { EmailPreferencesController } from './email-preferences.controller';
import { EmailPreferencesService } from './email-preferences.service';

@Module({
  controllers: [EmailPreferencesController],
  providers: [EmailPreferencesService],
  exports: [EmailPreferencesService],
})
export class EmailPreferencesModule {}

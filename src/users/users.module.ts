import { Global, Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MailService } from '../common/services/mail.service';

@Global()
@Module({
  controllers: [UsersController],
  providers: [UsersService, MailService],
  exports: [UsersService, MailService],
})
export class UsersModule {}

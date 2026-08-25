import { Global, Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MailService } from '../common/services/mail.service';
import { WalletsModule } from '../wallets/wallets.module';

@Global()
@Module({
  imports: [WalletsModule],
  controllers: [UsersController],
  providers: [UsersService, MailService],
  exports: [UsersService, MailService],
})
export class UsersModule {}

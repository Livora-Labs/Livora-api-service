import { Global, Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MailService } from '../common/services/mail.service';
import { WalletsModule } from '../wallets/wallets.module';
import { UsersRepository } from './repositories/users.repository';
import { UserCacheProxy } from './proxies/user-cache.proxy';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [WalletsModule, RedisModule, PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, MailService, UsersRepository, UserCacheProxy],
  exports: [UsersService, MailService, UsersRepository, UserCacheProxy],
})
export class UsersModule {}

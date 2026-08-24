import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketsGateway } from './websockets.gateway';
import { WebsocketsService } from './websockets.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [WebsocketsGateway, WebsocketsService],
  exports: [WebsocketsGateway, WebsocketsService],
})
export class WebsocketsModule {}

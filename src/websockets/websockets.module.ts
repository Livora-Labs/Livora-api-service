import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebsocketsGateway } from './websockets.gateway';
import { WebsocketsService } from './websockets.service';

@Module({
  imports: [ConfigModule],
  providers: [WebsocketsGateway, WebsocketsService],
  exports: [WebsocketsGateway, WebsocketsService],
})
export class WebsocketsModule {}

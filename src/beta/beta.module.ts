import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { BetaController } from './beta.controller';
import { BetaService } from './beta.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [BetaController],
  providers: [BetaService],
})
export class BetaModule {}

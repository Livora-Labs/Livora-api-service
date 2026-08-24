import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

// SupabaseService (Storage) y UsersService (usado por el guard) son módulos
// @Global, por lo que no requieren imports explícitos aquí.
@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}

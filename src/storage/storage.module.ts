import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { R2StorageService } from './r2-storage.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    R2StorageService,
    {
      provide: 'IStorageProvider',
      useExisting: R2StorageService,
    },
  ],
  exports: [R2StorageService, 'IStorageProvider'],
})
export class StorageModule {}

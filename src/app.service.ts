import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppService {
  constructor(private readonly configService: ConfigService) {}

  getHello(): string {
    return 'Hello World!';
  }

  getAppVersion() {
    const minBuild = parseInt(
      this.configService.get<string>('MIN_ANDROID_BUILD') || '14',
      10,
    );
    const latestBuild = parseInt(
      this.configService.get<string>('LATEST_ANDROID_BUILD') || '14',
      10,
    );
    const minVersionName =
      this.configService.get<string>('MIN_ANDROID_VERSION') || '1.0.13';
    const latestVersionName =
      this.configService.get<string>('LATEST_ANDROID_VERSION') || '1.0.13';
    const forceUpdate =
      this.configService.get<string>('FORCE_UPDATE_ACTIVE') === 'true';
    const playStoreUrl =
      this.configService.get<string>('PLAY_STORE_URL') ||
      'https://play.google.com/store/apps/details?id=com.grupolivoralabs.livora';
    const updateMessage =
      this.configService.get<string>('APP_UPDATE_MESSAGE') ||
      'Existe una versión más reciente de Livora en Google Play Store. Para garantizar la seguridad operativa y el correcto funcionamiento, es necesario actualizar.';

    return {
      minBuild,
      latestBuild,
      minVersionName,
      latestVersionName,
      forceUpdate,
      playStoreUrl,
      updateMessage,
      serverTime: new Date().toISOString(),
    };
  }
}

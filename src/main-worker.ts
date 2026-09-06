import './instrument';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerAppModule } from './worker-app.module';

async function bootstrapWorker() {
  process.env.APP_MODE = 'WORKER';
  const logger = new Logger('LivoraWorkerMain');

  logger.log('Iniciando Livora Worker en modo Headless (sin servidor HTTP)...');

  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.enableShutdownHooks();

  logger.log(
    'Livora Background Worker iniciado exitosamente. Procesadores de BullMQ y Stellar activos.',
  );

  const shutdown = async (signal: string) => {
    logger.log(`Recibida señal ${signal}. Deteniendo worker limpiamente...`);
    try {
      await app.close();
      logger.log('Worker detenido con éxito.');
      process.exit(0);
    } catch (err: any) {
      logger.error(`Error durante el apagado del worker: ${err.message}`, err.stack);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void bootstrapWorker();

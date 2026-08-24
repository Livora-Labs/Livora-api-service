import * as Sentry from '@sentry/nestjs';

const sentryDsn = process.env.SENTRY_DSN_BACKEND || process.env.SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    tracesSampleRate: 1.0,
  });
  console.log('Sentry inicializado con éxito desde instrument.ts');
} else {
  console.warn(
    'Sentry DSN no configurado en instrument.ts. Monitoreo de errores desactivado.',
  );
}

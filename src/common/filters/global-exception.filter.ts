import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/nestjs';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'Ha ocurrido un error interno en el servidor';
    let details: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Convertir el código de estado HTTP a un string de código de error (ej. 400 -> BAD_REQUEST)
      errorCode = HttpStatus[status] || 'HTTP_ERROR';

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resObj = exceptionResponse as Record<string, any>;

        if (resObj.error && typeof resObj.error === 'string') {
          errorCode = resObj.error.toUpperCase().replace(/\s+/g, '_');
        }

        if (Array.isArray(resObj.message)) {
          message = 'Error de validación en los parámetros de entrada';
          details = resObj.message;
        } else if (typeof resObj.message === 'string') {
          message = resObj.message;
          if (resObj.details) {
            details = resObj.details;
          }
        } else {
          details = resObj;
        }
      }
    } else {
      this.logger.error(
        'Excepción no controlada capturada en GlobalExceptionFilter:',
        exception,
      );
      if (exception instanceof Error) {
        details = {
          errorName: exception.name,
          detailMessage: exception.message,
        };
      }
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      Sentry.captureException(exception);
      if (process.env.NODE_ENV === 'production') {
        details = undefined;
        message = 'Ha ocurrido un error interno en el servidor';
      }
    }

    response.status(status).json({
      error: {
        code: errorCode,
        message,
        ...(details !== undefined && { details }),
      },
    });
  }
}

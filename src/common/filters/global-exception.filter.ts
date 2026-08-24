import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as Sentry from '@sentry/nestjs';

const HTTP_STATUS_TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.PAYMENT_REQUIRED]: 'Payment Required',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method Not Allowed',
  [HttpStatus.NOT_ACCEPTABLE]: 'Not Acceptable',
  [HttpStatus.PROXY_AUTHENTICATION_REQUIRED]: 'Proxy Authentication Required',
  [HttpStatus.REQUEST_TIMEOUT]: 'Request Timeout',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.GONE]: 'Gone',
  [HttpStatus.LENGTH_REQUIRED]: 'Length Required',
  [HttpStatus.PRECONDITION_FAILED]: 'Precondition Failed',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.URI_TOO_LONG]: 'URI Too Long',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported Media Type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.NOT_IMPLEMENTED]: 'Not Implemented',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  invalid_params?: Array<{ name: string; reason: string }>;
  [key: string]: any;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'internal_server_error';
    let title = 'Internal Server Error';
    let detail = 'Ha ocurrido un error interno en el servidor';
    let invalidParams: Array<{ name: string; reason: string }> | undefined =
      undefined;

    const instance =
      (request && (request.url || (request.raw && request.raw.url))) || '/';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = HTTP_STATUS_TITLES[status] || HttpStatus[status] || 'Error';
      errorCode = (HttpStatus[status] || 'error').toLowerCase();

      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        detail = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resObj = exceptionResponse as Record<string, any>;

        if (resObj.error && typeof resObj.error === 'string') {
          errorCode = resObj.error.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        }

        if (resObj.title && typeof resObj.title === 'string') {
          title = resObj.title;
        }

        if (Array.isArray(resObj.message)) {
          detail = 'Error de validación en los parámetros de entrada';
          if (!resObj.error) {
            errorCode = 'validation_error';
          }
          invalidParams = resObj.message.map((msg: unknown) => {
            if (typeof msg === 'string') {
              const firstSpace = msg.indexOf(' ');
              const name =
                firstSpace > 0 ? msg.substring(0, firstSpace) : 'field';
              return { name, reason: msg };
            }
            if (typeof msg === 'object' && msg !== null) {
              const msgObj = msg as Record<string, unknown>;
              const name =
                (typeof msgObj.property === 'string'
                  ? msgObj.property
                  : undefined) ||
                (typeof msgObj.field === 'string' ? msgObj.field : undefined) ||
                (typeof msgObj.name === 'string' ? msgObj.name : undefined) ||
                'field';
              let reason = 'Invalid value';
              if (
                msgObj.constraints &&
                typeof msgObj.constraints === 'object' &&
                msgObj.constraints !== null
              ) {
                const constraintValues = Object.values(
                  msgObj.constraints as Record<string, string>,
                );
                reason = constraintValues.join(', ');
              } else if (typeof msgObj.reason === 'string') {
                reason = msgObj.reason;
              } else if (typeof msgObj.message === 'string') {
                reason = msgObj.message;
              }
              return { name, reason };
            }
            return { name: 'field', reason: String(msg) };
          });
        } else if (typeof resObj.message === 'string') {
          detail = resObj.message;
        } else if (typeof resObj.detail === 'string') {
          detail = resObj.detail;
        }

        if (Array.isArray(resObj.invalid_params)) {
          invalidParams = resObj.invalid_params as Array<{
            name: string;
            reason: string;
          }>;
        }
      }
    } else {
      this.logger.error(
        'Excepción no controlada capturada en GlobalExceptionFilter:',
        exception,
      );
      if (exception instanceof Error) {
        detail = exception.message;
      }
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      Sentry.captureException(exception);
      if (process.env.NODE_ENV === 'production') {
        detail = 'Ha ocurrido un error interno en el servidor';
      }
    }

    const cleanErrorCode = errorCode
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const type = `https://api.livora.org/errors/${cleanErrorCode || 'unknown_error'}`;

    const problemDetails: ProblemDetails = {
      type,
      title,
      status,
      detail,
      instance,
    };

    if (invalidParams && invalidParams.length > 0) {
      problemDetails.invalid_params = invalidParams;
    }

    response
      .header('Content-Type', 'application/problem+json; charset=utf-8')
      .status(status)
      .send(problemDetails);
  }
}

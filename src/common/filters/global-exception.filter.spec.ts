import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common/interfaces';
import {
  GlobalExceptionFilter,
  ProblemDetails,
} from './global-exception.filter';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

interface MockReply {
  header: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
}

interface MockRequest {
  url?: string;
  raw?: { url?: string };
}

function getSentPayload(mockReply: MockReply): ProblemDetails {
  const calls = mockReply.send.mock.calls as unknown as Array<[ProblemDetails]>;
  return calls[0][0];
}

describe('GlobalExceptionFilter (RFC 9457 Problem Details)', () => {
  let filter: GlobalExceptionFilter;
  let mockReply: MockReply;
  let mockRequest: MockRequest;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.clearAllMocks();

    mockReply = {
      header: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    mockRequest = {
      url: '/api/v1/auth/register',
      raw: {
        url: '/api/v1/auth/register',
      },
    };

    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockReply,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  describe('RFC 9457 Content-Type Header & Status', () => {
    it('should set Content-Type header to application/problem+json', () => {
      const exception = new NotFoundException('User not found');

      filter.catch(exception, mockHost);

      expect(mockReply.header).toHaveBeenCalledWith(
        'Content-Type',
        'application/problem+json; charset=utf-8',
      );
      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(mockReply.send).toHaveBeenCalled();
    });
  });

  describe('Standard HTTP Exceptions', () => {
    it('should format NotFoundException (404) correctly', () => {
      const exception = new NotFoundException('Recurso no encontrado');

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      const sentPayload = getSentPayload(mockReply);

      expect(sentPayload).toEqual({
        type: 'https://api.livora.org/errors/not_found',
        title: 'Not Found',
        status: 404,
        detail: 'Recurso no encontrado',
        instance: '/api/v1/auth/register',
      });
      expect(sentPayload.invalid_params).toBeUndefined();
    });

    it('should format UnauthorizedException (401) correctly', () => {
      const exception = new UnauthorizedException('Token inválido o expirado');

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      const sentPayload = getSentPayload(mockReply);

      expect(sentPayload).toEqual({
        type: 'https://api.livora.org/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Token inválido o expirado',
        instance: '/api/v1/auth/register',
      });
    });

    it('should format ForbiddenException (403) correctly', () => {
      const exception = new ForbiddenException(
        'No tienes permisos suficientes',
      );

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      const sentPayload = getSentPayload(mockReply);

      expect(sentPayload).toEqual({
        type: 'https://api.livora.org/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'No tienes permisos suficientes',
        instance: '/api/v1/auth/register',
      });
    });

    it('should format ConflictException (409) correctly', () => {
      const exception = new ConflictException('El correo ya está registrado');

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      const sentPayload = getSentPayload(mockReply);

      expect(sentPayload).toEqual({
        type: 'https://api.livora.org/errors/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'El correo ya está registrado',
        instance: '/api/v1/auth/register',
      });
    });
  });

  describe('ValidationPipe BadRequestException (RFC 9457 Extension invalid_params)', () => {
    it('should format string array validation errors with invalid_params breakdown', () => {
      const exception = new BadRequestException([
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ]);

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const sentPayload = getSentPayload(mockReply);

      expect(sentPayload.type).toBe(
        'https://api.livora.org/errors/bad_request',
      );
      expect(sentPayload.title).toBe('Bad Request');
      expect(sentPayload.status).toBe(400);
      expect(sentPayload.detail).toBe(
        'Error de validación en los parámetros de entrada',
      );
      expect(sentPayload.instance).toBe('/api/v1/auth/register');
      expect(sentPayload.invalid_params).toEqual([
        { name: 'email', reason: 'email must be an email' },
        {
          name: 'password',
          reason: 'password must be longer than or equal to 8 characters',
        },
      ]);
    });

    it('should format structured object validation errors with constraints', () => {
      const exception = new HttpException(
        {
          statusCode: 400,
          error: 'Bad Request',
          message: [
            {
              property: 'latitude',
              constraints: {
                isNumber:
                  'latitude must be a number conforming to the specified constraints',
              },
            },
            {
              property: 'verificationPin',
              constraints: {
                isLength: 'verificationPin must be exactly 4 characters',
              },
            },
          ],
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const sentPayload = getSentPayload(mockReply);

      expect(sentPayload.invalid_params).toEqual([
        {
          name: 'latitude',
          reason:
            'latitude must be a number conforming to the specified constraints',
        },
        {
          name: 'verificationPin',
          reason: 'verificationPin must be exactly 4 characters',
        },
      ]);
    });

    it('should pass through explicit invalid_params if provided in response object', () => {
      const exception = new HttpException(
        {
          statusCode: 400,
          message: 'Parámetros inválidos',
          invalid_params: [
            { name: 'phone', reason: 'Invalid international phone format' },
          ],
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sentPayload = getSentPayload(mockReply);
      expect(sentPayload.invalid_params).toEqual([
        { name: 'phone', reason: 'Invalid international phone format' },
      ]);
    });
  });

  describe('Custom Error Codes and Titles', () => {
    it('should extract custom error code into type URI and preserve custom title', () => {
      const exception = new HttpException(
        {
          error: 'INSUFFICIENT_FUNDS',
          title: 'Insufficient Balance',
          message:
            'El saldo de tokens es insuficiente para realizar la transacción',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sentPayload = getSentPayload(mockReply);
      expect(sentPayload.type).toBe(
        'https://api.livora.org/errors/insufficient_funds',
      );
      expect(sentPayload.title).toBe('Insufficient Balance');
      expect(sentPayload.detail).toBe(
        'El saldo de tokens es insuficiente para realizar la transacción',
      );
    });
  });

  describe('Unhandled 500 Internal Server Errors & Sentry', () => {
    it('should handle unhandled Error exception and capture in Sentry', () => {
      const unhandledError = new Error('Database connection timeout');

      filter.catch(unhandledError, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(unhandledError);

      const sentPayload = getSentPayload(mockReply);
      expect(sentPayload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(sentPayload.title).toBe('Internal Server Error');
      expect(sentPayload.status).toBe(500);
      expect(sentPayload.detail).toBe('Database connection timeout');
    });

    it('should sanitize error details in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const unhandledError = new Error(
          'Sensitive database credentials leak in stack trace',
        );
        filter.catch(unhandledError, mockHost);

        const sentPayload = getSentPayload(mockReply);
        expect(sentPayload.detail).toBe(
          'Ha ocurrido un error interno en el servidor',
        );
        expect(Sentry.captureException).toHaveBeenCalledWith(unhandledError);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should sanitize 500 HttpException details in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const http500 = new HttpException(
          'Internal database pool failure',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
        filter.catch(http500, mockHost);

        const sentPayload = getSentPayload(mockReply);
        expect(sentPayload.detail).toBe(
          'Ha ocurrido un error interno en el servidor',
        );
        expect(Sentry.captureException).toHaveBeenCalledWith(http500);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('Fallback request instance path', () => {
    it('should fallback to root "/" if request url is missing', () => {
      mockRequest = {};
      const exception = new NotFoundException('Not found');

      filter.catch(exception, mockHost);

      const sentPayload = getSentPayload(mockReply);
      expect(sentPayload.instance).toBe('/');
    });
  });
});

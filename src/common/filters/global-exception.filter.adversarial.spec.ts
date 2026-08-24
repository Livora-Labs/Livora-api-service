import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnprocessableEntityException,
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
  if (!calls || calls.length === 0) {
    throw new Error('reply.send was not called');
  }
  return calls[0][0];
}

describe('Adversarial Stress Test: GlobalExceptionFilter (RFC 9457)', () => {
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
      url: '/api/v1/adversarial-endpoint',
      raw: {
        url: '/api/v1/adversarial-endpoint',
      },
    };

    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockReply,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  describe('1. Non-HttpExceptions & Bizarre Thrown Values', () => {
    it('handles TypeError without crashing and returns 500 problem details', () => {
      const typeError = new TypeError(
        'Cannot read properties of undefined (reading "execute")',
      );
      filter.catch(typeError, mockHost);

      expect(mockReply.header).toHaveBeenCalledWith(
        'Content-Type',
        'application/problem+json; charset=utf-8',
      );
      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(payload.status).toBe(500);
      expect(payload.title).toBe('Internal Server Error');
      expect(payload.detail).toBe(
        'Cannot read properties of undefined (reading "execute")',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(typeError);
    });

    it('handles RangeError (stack overflow) without crashing', () => {
      const rangeError = new RangeError('Maximum call stack size exceeded');
      filter.catch(rangeError, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(payload.detail).toBe('Maximum call stack size exceeded');
      expect(Sentry.captureException).toHaveBeenCalledWith(rangeError);
    });

    it('handles custom Error class with extra metadata', () => {
      class DatabaseConnectionError extends Error {
        public code = 'PG_CONN_REFUSED';
        constructor() {
          super('Database connection refused at 10.0.0.5:5432');
          this.name = 'DatabaseConnectionError';
        }
      }

      const customError = new DatabaseConnectionError();
      filter.catch(customError, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.detail).toBe(
        'Database connection refused at 10.0.0.5:5432',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(customError);
    });

    it('handles string literal thrown (throw "Fatal crash")', () => {
      filter.catch('Fatal crash', mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(payload.title).toBe('Internal Server Error');
      expect(payload.status).toBe(500);
      expect(payload.detail).toBe(
        'Ha ocurrido un error interno en el servidor',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith('Fatal crash');
    });

    it('handles null thrown (throw null)', () => {
      filter.catch(null, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(payload.detail).toBe(
        'Ha ocurrido un error interno en el servidor',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(null);
    });

    it('handles undefined thrown (throw undefined)', () => {
      filter.catch(undefined, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(undefined);
    });

    it('handles number thrown (throw 500)', () => {
      filter.catch(500, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(500);
    });

    it('handles circular object thrown without infinite loop or JSON serialization blowup', () => {
      const circular: Record<string, unknown> = { message: 'Circular error' };
      circular.self = circular;

      filter.catch(circular, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/internal_server_error',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(circular);
    });
  });

  describe('2. Validation Trees & Complex Parameters', () => {
    it('handles mixed array in validation response (strings, objects, numbers, booleans)', () => {
      const exception = new HttpException(
        {
          statusCode: 400,
          error: 'Bad Request',
          message: [
            'username must not be empty',
            {
              property: 'email',
              constraints: {
                isEmail: 'email must be valid',
                isNotEmpty: 'email is required',
              },
            },
            { field: 'age', reason: 'age must be at least 18' },
            { name: 'terms', message: 'terms must be accepted' },
            12345,
            true,
          ],
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe('https://api.livora.org/errors/bad_request');
      expect(payload.invalid_params).toEqual([
        { name: 'username', reason: 'username must not be empty' },
        { name: 'email', reason: 'email must be valid, email is required' },
        { name: 'age', reason: 'age must be at least 18' },
        { name: 'terms', reason: 'terms must be accepted' },
        { name: 'field', reason: '12345' },
        { name: 'field', reason: 'true' },
      ]);
    });

    it('handles string without space in validation array', () => {
      const exception = new BadRequestException(['SingleWordError']);
      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.invalid_params).toEqual([
        { name: 'field', reason: 'SingleWordError' },
      ]);
    });

    it('handles empty validation message array', () => {
      const exception = new BadRequestException([]);
      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.invalid_params).toBeUndefined();
    });

    it('handles empty constraints object in validation item', () => {
      const exception = new HttpException(
        {
          statusCode: 400,
          message: [{ property: 'avatar', constraints: {} }],
        },
        HttpStatus.BAD_REQUEST,
      );
      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.invalid_params).toEqual([{ name: 'avatar', reason: '' }]);
    });
  });

  describe('3. HttpException Edge Cases & Custom Status Codes', () => {
    it('handles string response in HttpException', () => {
      const exception = new HttpException(
        'Plain string error message',
        HttpStatus.NOT_FOUND,
      );
      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.status).toBe(404);
      expect(payload.title).toBe('Not Found');
      expect(payload.detail).toBe('Plain string error message');
      expect(payload.type).toBe('https://api.livora.org/errors/not_found');
    });

    it('handles custom status codes not in standard enum (e.g. 418 Teapot, 422, 429)', () => {
      const unprocessable = new UnprocessableEntityException(
        'Semantic validation failed',
      );
      filter.catch(unprocessable, mockHost);

      let payload = getSentPayload(mockReply);
      expect(payload.status).toBe(422);
      expect(payload.title).toBe('Unprocessable Entity');
      expect(payload.type).toBe(
        'https://api.livora.org/errors/unprocessable_entity',
      );

      mockReply.send.mockClear();
      const payloadTooLarge = new PayloadTooLargeException(
        'File exceeds 10MB limit',
      );
      filter.catch(payloadTooLarge, mockHost);

      payload = getSentPayload(mockReply);
      expect(payload.status).toBe(413);
      expect(payload.title).toBe('Payload Too Large');
      expect(payload.type).toBe(
        'https://api.livora.org/errors/payload_too_large',
      );
    });

    it('handles custom error codes with weird formatting, punctuation, spaces', () => {
      const exception = new HttpException(
        {
          error: '  --- INVALID_BLOCKCHAIN_NONCE #999! ---  ',
          message: 'Nonce is out of order',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe(
        'https://api.livora.org/errors/invalid_blockchain_nonce_999',
      );
      expect(payload.detail).toBe('Nonce is out of order');
    });

    it('handles empty error code gracefully', () => {
      const exception = new HttpException(
        {
          error: '   ',
          message: 'Some error',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.type).toBe('https://api.livora.org/errors/unknown_error');
    });
  });

  describe('4. Sentry & Production Sanitization Matrix', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('does NOT capture 4xx client errors in Sentry in production or development', () => {
      process.env.NODE_ENV = 'production';
      const clientErrors = [
        new BadRequestException('Invalid payload'),
        new UnauthorizedException('Unauthorized'),
        new ForbiddenException('Forbidden'),
        new NotFoundException('Not found'),
        new ConflictException('Conflict'),
      ];

      for (const err of clientErrors) {
        mockReply.send.mockClear();
        jest.clearAllMocks();
        filter.catch(err, mockHost);

        expect(Sentry.captureException).not.toHaveBeenCalled();
        const payload = getSentPayload(mockReply);
        expect(payload.detail).toBe(err.message);
      }
    });

    it('sanitizes 500 error messages in production environment', () => {
      process.env.NODE_ENV = 'production';
      const secretLeak = new Error(
        'SELECT * FROM users WHERE password_hash = "secret_123" failed',
      );

      filter.catch(secretLeak, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.status).toBe(500);
      expect(payload.detail).toBe(
        'Ha ocurrido un error interno en el servidor',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(secretLeak);
    });

    it('exposes error message in non-production (development/test) environment for easier debugging', () => {
      process.env.NODE_ENV = 'development';
      const devError = new Error(
        'Connection refused at redis://localhost:6379',
      );

      filter.catch(devError, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.status).toBe(500);
      expect(payload.detail).toBe(
        'Connection refused at redis://localhost:6379',
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(devError);
    });
  });

  describe('5. Instance Resolution & Edge Cases', () => {
    it('uses request.url when available', () => {
      mockRequest = { url: '/api/v1/wallets/transfer?amount=10' };
      const exception = new BadRequestException('Invalid transfer');

      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.instance).toBe('/api/v1/wallets/transfer?amount=10');
    });

    it('uses request.raw.url when request.url is undefined', () => {
      mockRequest = { raw: { url: '/api/v1/auth/otp' } };
      const exception = new BadRequestException('Invalid OTP');

      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.instance).toBe('/api/v1/auth/otp');
    });

    it('uses "/" when both request and raw are missing', () => {
      mockHost = {
        switchToHttp: jest.fn().mockReturnValue({
          getResponse: () => mockReply,
          getRequest: () => null,
        }),
      } as unknown as ArgumentsHost;
      const exception = new BadRequestException('No request');

      filter.catch(exception, mockHost);

      const payload = getSentPayload(mockReply);
      expect(payload.instance).toBe('/');
    });
  });
});

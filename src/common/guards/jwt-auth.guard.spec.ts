import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from '../../auth/services/token.service';
import { UsersService } from '../../users/users.service';
import { Role } from '@prisma/client';

describe('JwtAuthGuard (Decoupled Authentication Guard)', () => {
  let guard: JwtAuthGuard;
  let mockTokenService: { verifyAccessToken: jest.Mock };
  let mockUsersService: { findById: jest.Mock };

  beforeEach(async () => {
    mockTokenService = {
      verifyAccessToken: jest.fn(),
    };

    mockUsersService = {
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: TokenService, useValue: mockTokenService },
        { provide: UsersService, useValue: mockUsersService },
      ],
    }).compile();

    guard = module.get<JwtAuthGuard>(JwtAuthGuard);
  });

  const createMockExecutionContext = (headers: Record<string, any> = {}) => {
    const request: any = {
      headers,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  it('should throw UnauthorizedException if authorization header is missing', async () => {
    const context = createMockExecutionContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException(
        'Token de autorización no encontrado en la cabecera',
      ),
    );
  });

  it('should throw UnauthorizedException if bearer token is empty string', async () => {
    const context = createMockExecutionContext({
      authorization: 'Bearer   ',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Token JWT no especificado'),
    );
  });

  it('should throw UnauthorizedException if JWT token is invalid or expired', async () => {
    mockTokenService.verifyAccessToken.mockImplementation(() => {
      throw new Error('jwt expired');
    });

    const context = createMockExecutionContext({
      authorization: 'Bearer invalid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Token de sesión no válido o expirado'),
    );
  });

  it('should throw UnauthorizedException if local database user does not exist', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sub: 'user-uuid-1',
      email: 'user@livora.io',
      role: Role.HOGAR,
    });
    mockUsersService.findById.mockResolvedValue(null);

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException(
        'Usuario autenticado pero sin perfil local en la base de datos',
      ),
    );
  });

  it('should throw UnauthorizedException if user is soft-deleted (deletedAt !== null)', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sub: 'user-uuid-1',
      email: 'deleted@livora.io',
      role: Role.HOGAR,
    });
    mockUsersService.findById.mockResolvedValue({
      id: 'user-uuid-1',
      email: 'deleted_user@deleted.livora.org',
      role: Role.HOGAR,
      isActive: false,
      deletedAt: new Date(),
    } as any);

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Cuenta desactivada o eliminada'),
    );
  });

  it('should throw UnauthorizedException if user is inactive (isActive === false)', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sub: 'user-uuid-1',
      email: 'user@livora.io',
      role: Role.HOGAR,
    });
    mockUsersService.findById.mockResolvedValue({
      id: 'user-uuid-1',
      email: 'user@livora.io',
      role: Role.HOGAR,
      isActive: false,
      deletedAt: null,
    } as any);

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Cuenta desactivada o eliminada'),
    );
  });

  it('should pass and attach sanitized safeUser to request, stripping encryptedPrivateKey', async () => {
    mockTokenService.verifyAccessToken.mockReturnValue({
      sub: 'user-uuid-1',
      email: 'active@livora.io',
      role: Role.HOGAR,
    });
    mockUsersService.findById.mockResolvedValue({
      id: 'user-uuid-1',
      email: 'active@livora.io',
      role: Role.HOGAR,
      walletAddress: 'GAW123456...',
      encryptedPrivateKey: 'aes256-encrypted-key',
      encryptionIv: 'iv-test',
      encryptionTag: 'tag-test',
      isActive: true,
      deletedAt: null,
    } as any);

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);

    const request = context.switchToHttp().getRequest();
    expect(request.user).toBeDefined();
    expect(request.user.id).toBe('user-uuid-1');
    expect(request.user.email).toBe('active@livora.io');
    expect(request.user.encryptedPrivateKey).toBeUndefined();
    expect(request.user.encryptionIv).toBeUndefined();
    expect(request.user.encryptionTag).toBeUndefined();
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseService } from '../../supabase/supabase.service';
import { UsersService } from '../../users/users.service';
import { Role } from '@prisma/client';

describe('SupabaseAuthGuard', () => {
  let guard: SupabaseAuthGuard;
  let mockSupabaseService: any;
  let mockUsersService: any;
  let mockSupabaseClient: any;

  beforeEach(async () => {
    mockSupabaseClient = {
      auth: {
        getUser: jest.fn(),
      },
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue(mockSupabaseClient),
    };

    mockUsersService = {
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupabaseAuthGuard,
        { provide: SupabaseService, useValue: mockSupabaseService },
        { provide: UsersService, useValue: mockUsersService },
      ],
    }).compile();

    guard = module.get<SupabaseAuthGuard>(SupabaseAuthGuard);
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

  it('should throw UnauthorizedException if Supabase token is invalid or expired', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid JWT' },
    });
    const context = createMockExecutionContext({
      authorization: 'Bearer invalid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Token de sesión no válido o expirado'),
    );
  });

  it('should throw UnauthorizedException if local database user does not exist', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-uuid-1' } },
      error: null,
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

  it('should throw UnauthorizedException("Cuenta desactivada o eliminada") if user is soft-deleted (deletedAt !== null)', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-uuid-1' } },
      error: null,
    });
    mockUsersService.findById.mockResolvedValue({
      id: 'supabase-uuid-1',
      email: 'deleted_user@deleted.livora.org',
      role: Role.HOGAR,
      isActive: false,
      deletedAt: new Date(),
    });

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Cuenta desactivada o eliminada'),
    );
  });

  it('should throw UnauthorizedException("Cuenta desactivada o eliminada") if user is inactive (isActive === false)', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-uuid-1' } },
      error: null,
    });
    mockUsersService.findById.mockResolvedValue({
      id: 'supabase-uuid-1',
      email: 'user@livora.io',
      role: Role.HOGAR,
      isActive: false,
      deletedAt: null,
    });

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Cuenta desactivada o eliminada'),
    );
  });

  it('should pass and attach safeUser to request for active and non-deleted user', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-uuid-1' } },
      error: null,
    });
    mockUsersService.findById.mockResolvedValue({
      id: 'supabase-uuid-1',
      email: 'active@livora.io',
      role: Role.HOGAR,
      walletAddress: 'GAW123456...',
      encryptedPrivateKey: 'aes256-encrypted-key',
      isActive: true,
      deletedAt: null,
    });

    const context = createMockExecutionContext({
      authorization: 'Bearer valid.jwt.token',
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);

    const request = context.switchToHttp().getRequest();
    expect(request.user).toBeDefined();
    expect(request.user.id).toBe('supabase-uuid-1');
    expect(request.user.email).toBe('active@livora.io');
    expect(request.user.encryptedPrivateKey).toBeUndefined();
  });
});

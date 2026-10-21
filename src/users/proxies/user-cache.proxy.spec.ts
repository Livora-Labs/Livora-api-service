import { UserCacheProxy } from './user-cache.proxy';
import { UsersRepository } from '../repositories/users.repository';

describe('Patrón Proxy de Caché (PUCP Disoft Diapositivas 13-15)', () => {
  let proxy: UserCacheProxy;
  let mockRepository: jest.Mocked<UsersRepository>;
  let mockRedis: any;

  const mockUser: any = {
    id: 'user-001',
    email: 'test@livora.pe',
    name: 'Juan Perez',
  };

  beforeEach(() => {
    mockRepository = {
      findById: jest.fn().mockResolvedValue(mockUser),
      findByEmail: jest.fn().mockResolvedValue(mockUser),
      create: jest.fn(),
      update: jest.fn(),
      updateFcmToken: jest.fn(),
      getConsentAudits: jest.fn(),
    } as any;

    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    proxy = new UserCacheProxy(mockRepository, mockRedis);
  });

  it('debe consultar el repositorio real en la primera llamada (cache miss)', async () => {
    const user = await proxy.findById('user-001');

    expect(user).toEqual(mockUser);
    expect(mockRepository.findById).toHaveBeenCalledWith('user-001');
    expect(mockRepository.findById).toHaveBeenCalledTimes(1);
  });

  it('debe resolver desde la caché en memoria en llamadas sucesivas (cache hit) sin llamar al repositorio real', async () => {
    await proxy.findById('user-001');
    const cachedUser = await proxy.findById('user-001');

    expect(cachedUser).toEqual(mockUser);
    expect(mockRepository.findById).toHaveBeenCalledTimes(1); // Solo 1 vez a BD
  });

  it('debe invalidar la caché tras una operación de actualización (eviction)', async () => {
    await proxy.findById('user-001'); // Poblar caché
    proxy.evictCache('user-001'); // Invalidar

    await proxy.findById('user-001'); // Debe volver a llamar al repositorio real
    expect(mockRepository.findById).toHaveBeenCalledTimes(2);
  });
});

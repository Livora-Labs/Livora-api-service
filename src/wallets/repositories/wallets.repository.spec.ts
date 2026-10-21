import { WalletsRepository } from './wallets.repository';
import { PrismaService } from '../../prisma/prisma.service';

describe('Patrón Repositorio / Data Mapper de Billeteras (PUCP Disoft Diapositivas 08 y 09)', () => {
  let repository: WalletsRepository;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
      redemptionTransaction: {
        findMany: jest.fn(),
      },
      walletVault: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      walletTransfer: {
        create: jest.fn(),
      },
    };

    repository = new WalletsRepository(mockPrisma as PrismaService);
  });

  it('debe buscar usuario por ID aislando la consulta ORM', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'u1@livora.pe' });
    const user = await repository.findUserById('u1');

    expect(user).toEqual({ id: 'u1', email: 'u1@livora.pe' });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('debe consultar transacciones de canje completadas', async () => {
    mockPrisma.redemptionTransaction.findMany.mockResolvedValue([
      { id: 'r1', tokenAmount: 10 },
      { id: 'r2', tokenAmount: 15 },
    ]);

    const res = await repository.findCompletedRedemptions('u1');
    expect(res).toHaveLength(2);
    expect(mockPrisma.redemptionTransaction.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', status: 'COMPLETED' },
    });
  });

  it('debe guardar claves privadas en la bóveda de forma idempotente con upsert', async () => {
    mockPrisma.walletVault.upsert.mockResolvedValue({
      id: 'vault-1',
      userId: 'u1',
      encryptedPrivateKey: 'enc_hex',
    });

    const vault = await repository.upsertWalletVault('u1', 'enc_hex', 'iv_hex', 'tag_hex');
    expect(vault.encryptedPrivateKey).toBe('enc_hex');
    expect(mockPrisma.walletVault.upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      update: {
        encryptedPrivateKey: 'enc_hex',
        encryptionIv: 'iv_hex',
        encryptionTag: 'tag_hex',
      },
      create: {
        userId: 'u1',
        encryptedPrivateKey: 'enc_hex',
        encryptionIv: 'iv_hex',
        encryptionTag: 'tag_hex',
      },
    });
  });
});

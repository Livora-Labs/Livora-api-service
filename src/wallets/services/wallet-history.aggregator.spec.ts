import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WalletHistoryAggregatorService } from './wallet-history.aggregator';
import { PrismaService } from '../../prisma/prisma.service';

describe('WalletHistoryAggregatorService', () => {
  let service: WalletHistoryAggregatorService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
      redemptionTransaction: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      batch: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      collectionRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
      },
      walletTransfer: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletHistoryAggregatorService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<WalletHistoryAggregatorService>(
      WalletHistoryAggregatorService,
    );
  });

  it('should throw NotFoundException if user does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.getTransactionHistory('invalid-user-id'),
    ).rejects.toThrow(NotFoundException);
  });

  it('should aggregate redemptions and transfers properly for user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'HOGAR',
    });

    mockPrisma.redemptionTransaction.findMany.mockResolvedValue([
      {
        id: 'red-1',
        tokenAmount: 15,
        updatedAt: new Date('2026-03-01T10:00:00Z'),
        store: {
          businessName: 'BioTienda Verde',
          user: { email: 'tienda@biotienda.pe', walletAddress: 'GSTORE' },
        },
      },
    ]);

    mockPrisma.walletTransfer.findMany.mockImplementation(
      async ({ where }: any) => {
        if (where.senderUserId) {
          return [
            {
              id: 'tx-out-1',
              amount: 5,
              toAddress: 'GRECEIVER12345',
              createdAt: new Date('2026-03-02T10:00:00Z'),
              receiver: { name: 'Juan Perez', email: 'juan@test.com' },
            },
          ];
        }
        if (where.receiverUserId) {
          return [
            {
              id: 'tx-in-1',
              amount: 20,
              fromAddress: 'GSENDER12345',
              createdAt: new Date('2026-03-03T10:00:00Z'),
              sender: { name: 'EcoPunto', email: 'ecopunto@test.com' },
            },
          ];
        }
        return [];
      },
    );

    const result = await service.getTransactionHistory('user-1', 1, 10);

    expect(result.data).toHaveLength(3);
    expect(result.meta.total).toBe(3);
    // Verified sorted descending by date
    expect(result.data[0].id).toBe('tx-in-1_recv');
    expect(result.data[1].id).toBe('tx-out-1');
    expect(result.data[2].id).toBe('red-1');
  });

  it('should filter transactions by direction (IN/OUT)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'HOGAR',
    });

    mockPrisma.redemptionTransaction.findMany.mockResolvedValue([
      {
        id: 'red-1',
        tokenAmount: 10,
        updatedAt: new Date(),
        store: {
          businessName: 'Store',
          user: { email: 'store@test.com', walletAddress: 'G1' },
        },
      },
    ]);

    const resultOut = await service.getTransactionHistory(
      'user-1',
      1,
      10,
      'OUT',
    );
    expect(resultOut.data).toHaveLength(1);
    expect(resultOut.data[0].direction).toBe('OUT');

    const resultIn = await service.getTransactionHistory(
      'user-1',
      1,
      10,
      'IN',
    );
    expect(resultIn.data).toHaveLength(0);
  });
});

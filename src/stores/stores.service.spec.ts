import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RedemptionStatus, SettlementStatus } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import { StoresService } from './stores.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { ConfigService } from '@nestjs/config';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { CryptoUtil } from '../common/utils/crypto.util';

describe('StoresService', () => {
  let service: StoresService;
  let prismaMock: any;
  let walletsMock: any;
  let websocketsMock: any;
  let configMock: any;
  let queueMock: any;
  let blockchainMock: any;

  beforeEach(async () => {
    prismaMock = {
      storeProfile: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      redemptionTransaction: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      settlementRequest: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
    };

    walletsMock = {
      getBalance: jest.fn(),
    };

    websocketsMock = {
      emitStoreNotification: jest.fn(),
    };

    configMock = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'ECOTOKEN_CONTRACT_ID')
          return 'CD7L2OEZL74GPHXQ32EEXI7Y7DPHF74GPHXQ32EEXI7Y7DPHF74GPHXQ';
        if (key === 'WALLET_ENCRYPTION_KEY')
          return 'testSecretKey32CharacterLength!';
        return null;
      }),
    };

    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job-redemption-123' }),
    };

    blockchainMock = {
      getNonceOnChain: jest.fn(),
      executeDelegatedTransfer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoresService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: WalletsService, useValue: walletsMock },
        { provide: WebsocketsService, useValue: websocketsMock },
        { provide: ConfigService, useValue: configMock },
        { provide: BlockchainService, useValue: blockchainMock },
        { provide: 'BullQueue_blockchain-queue', useValue: queueMock },
      ],
    }).compile();

    service = module.get<StoresService>(StoresService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createProfile', () => {
    const dto = {
      businessName: 'EcoTienda Test',
      ruc: '20123456789',
      address: 'Calle Falsa 123',
      bankAccount: 'BCP CCI 002-1234',
    };

    it('should create store profile if none exists', async () => {
      prismaMock.storeProfile.findUnique.mockResolvedValue(null);
      prismaMock.storeProfile.create.mockResolvedValue({
        id: 'store-uuid',
        ...dto,
      });

      const result = await service.createProfile('user-uuid', dto);

      expect(prismaMock.storeProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-uuid' },
      });
      expect(prismaMock.storeProfile.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-uuid',
          businessName: dto.businessName,
          ruc: dto.ruc,
          address: dto.address,
          bankAccount: dto.bankAccount,
          logoUrl: undefined,
        },
        include: {
          user: {
            select: { id: true, email: true, role: true, walletAddress: true },
          },
        },
      });
      expect(result).toBeDefined();
      expect(result.id).toBe('store-uuid');
    });

    it('should throw ConflictException if profile already exists', async () => {
      prismaMock.storeProfile.findUnique.mockResolvedValue({
        id: 'store-uuid',
      });

      await expect(service.createProfile('user-uuid', dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('generateQrRedemption', () => {
    it('should create and return QR reference for redemption', async () => {
      prismaMock.storeProfile.findUnique.mockResolvedValue({
        id: 'store-uuid',
      });
      prismaMock.redemptionTransaction.create.mockResolvedValue({
        id: 'red-uuid',
        storeId: 'store-uuid',
        tokenAmount: 25.0,
        qrCodeRef: 'LIVORA-QR-xxx',
        status: RedemptionStatus.PENDING,
      });

      const result = await service.generateQrRedemption('user-uuid', {
        tokenAmount: 25.0,
      });

      expect(prismaMock.storeProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-uuid' },
      });
      expect(result.tokenAmount).toBe(25.0);
      expect(result.status).toBe(RedemptionStatus.PENDING);
    });

    it('should throw NotFoundException if store profile does not exist', async () => {
      prismaMock.storeProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.generateQrRedemption('user-uuid', { tokenAmount: 25.0 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirmRedemption', () => {
    const mockRedemption = {
      id: 'red-uuid',
      storeId: 'store-uuid',
      tokenAmount: 15.5,
      qrCodeRef: 'LIVORA-QR-xxx',
      status: RedemptionStatus.PENDING,
      store: {
        id: 'store-uuid',
        user: {
          id: 'store-user-uuid',
          walletAddress:
            'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
        },
      },
    };

    it('should confirm redemption successfully if household user has enough balance', async () => {
      prismaMock.redemptionTransaction.findUnique.mockResolvedValue(
        mockRedemption,
      );
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'household-uuid',
        walletAddress:
          'GBG4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5',
      });
      walletsMock.getBalance.mockResolvedValue({ balance: '50.0' });
      prismaMock.redemptionTransaction.update.mockResolvedValue({
        ...mockRedemption,
        userId: 'household-uuid',
        status: RedemptionStatus.COMPLETED,
        tokenAmount: 15.5,
      });

      const result = await service.confirmRedemption(
        'household-uuid',
        'LIVORA-QR-xxx',
        { termsAccepted: true },
      );

      expect(prismaMock.redemptionTransaction.findUnique).toHaveBeenCalledWith({
        where: { qrCodeRef: 'LIVORA-QR-xxx' },
        include: {
          store: {
            include: {
              user: { select: { id: true, walletAddress: true } },
            },
          },
        },
      });
      expect(walletsMock.getBalance).toHaveBeenCalledWith('household-uuid');
      expect(prismaMock.redemptionTransaction.update).toHaveBeenCalledWith({
        where: { id: 'red-uuid' },
        data: { userId: 'household-uuid', status: RedemptionStatus.COMPLETED, tokenAmount: 15.5 },
      });
      expect(websocketsMock.emitStoreNotification).toHaveBeenCalledWith(
        'store-user-uuid',
        'redemption:completed',
        expect.any(Object),
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        'redemption-transfer',
        {
          redemptionId: 'red-uuid',
          fromUserId: 'household-uuid',
          toStoreUserId: 'store-user-uuid',
          fromWallet:
            'GBG4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5',
          toWallet: 'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
          tokenAmount: 15.5,
        },
        expect.any(Object),
      );
      expect(result.status).toBe(RedemptionStatus.COMPLETED);
    });

    it('should throw BadRequestException if terms are not accepted', async () => {
      await expect(
        service.confirmRedemption('household-uuid', 'LIVORA-QR-xxx', {
          termsAccepted: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should apply optional donation and insurance charges successfully', async () => {
      prismaMock.redemptionTransaction.findUnique.mockResolvedValue(
        mockRedemption,
      );
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'household-uuid',
        walletAddress:
          'GBG4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5',
      });
      walletsMock.getBalance.mockResolvedValue({ balance: '50.0' });
      prismaMock.redemptionTransaction.update.mockResolvedValue({
        ...mockRedemption,
        userId: 'household-uuid',
        tokenAmount: 17.0, // 15.5 base + 1.0 donation + 0.5 insurance
        status: RedemptionStatus.COMPLETED,
      });

      const result = await service.confirmRedemption(
        'household-uuid',
        'LIVORA-QR-xxx',
        { termsAccepted: true, donationOptIn: true, insuranceOptIn: true },
      );

      expect(prismaMock.redemptionTransaction.update).toHaveBeenCalledWith({
        where: { id: 'red-uuid' },
        data: { userId: 'household-uuid', status: RedemptionStatus.COMPLETED, tokenAmount: 17.0 },
      });
      expect(queueMock.add).toHaveBeenCalledWith(
        'redemption-transfer',
        expect.objectContaining({
          tokenAmount: 17.0,
        }),
        expect.any(Object),
      );
      expect(result.tokenAmount).toBe(17.0);
    });

    it('should throw BadRequestException if household user balance is insufficient', async () => {
      prismaMock.redemptionTransaction.findUnique.mockResolvedValue(
        mockRedemption,
      );
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'household-uuid',
        walletAddress:
          'GBG4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5UP4O5',
      });
      walletsMock.getBalance.mockResolvedValue({ balance: '5.0' });

      await expect(
        service.confirmRedemption('household-uuid', 'LIVORA-QR-xxx', {
          termsAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('requestSettlement', () => {
    it('should create settlement request successfully', async () => {
      prismaMock.storeProfile.findUnique.mockResolvedValue({
        id: 'store-uuid',
      });
      prismaMock.settlementRequest.create.mockResolvedValue({
        id: 'settlement-uuid',
        storeId: 'store-uuid',
        tokenAmount: 60.0,
        fiatAmount: 60.0,
        status: SettlementStatus.PENDING,
      });

      const result = await service.requestSettlement('user-uuid', {
        tokenAmount: 60.0,
      });

      expect(prismaMock.storeProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-uuid' },
      });
      expect(result.fiatAmount).toBe(60.0);
      expect(result.status).toBe(SettlementStatus.PENDING);
    });
  });

  describe('paySettlement', () => {
    const mockSettlement = {
      id: 'settlement-uuid',
      storeId: 'store-uuid',
      tokenAmount: 60.0,
      fiatAmount: 60.0,
      status: SettlementStatus.PENDING,
      store: {
        user: {
          id: 'store-user-uuid',
          walletAddress:
            'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
        },
      },
    };

    it('should mark settlement as PAID and enqueue transfer', async () => {
      prismaMock.settlementRequest.findUnique.mockResolvedValue(mockSettlement);
      prismaMock.settlementRequest.update.mockResolvedValue({
        ...mockSettlement,
        status: SettlementStatus.PAID,
        receiptUrl: 'https://comprobante.pdf',
      });

      const result = await service.paySettlement('settlement-uuid', {
        receiptUrl: 'https://comprobante.pdf',
      });

      expect(prismaMock.settlementRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'settlement-uuid' },
        include: {
          store: {
            include: {
              user: { select: { id: true, walletAddress: true } },
            },
          },
        },
      });
      expect(prismaMock.settlementRequest.update).toHaveBeenCalledWith({
        where: { id: 'settlement-uuid' },
        data: {
          status: SettlementStatus.PAID,
          receiptUrl: 'https://comprobante.pdf',
        },
      });
      expect(websocketsMock.emitStoreNotification).toHaveBeenCalledWith(
        'store-user-uuid',
        'settlement:paid',
        expect.any(Object),
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        'settlement-transfer',
        expect.any(Object),
        expect.any(Object),
      );
      expect(result.status).toBe(SettlementStatus.PAID);
    });
  });
});

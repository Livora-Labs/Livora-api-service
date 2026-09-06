import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { NiubizClient } from './services/niubiz.client';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketsService } from '../websockets/websockets.service';
import * as crypto from 'crypto';

describe('PaymentsService', () => {
  let service: PaymentsService;
  const webhookSecret = 'test_webhook_secret_key_123456';

  const mockPrisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    user: {
      findUnique: jest.fn(),
    },
    paymentTransaction: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockNiubizClient = {
    createSession: jest.fn(),
    authorizeTransaction: jest.fn(),
    getMerchantId: jest.fn().mockReturnValue('456884108'),
  };

  const mockBlockchainService = {
    mintEcoTokens: jest.fn(),
  };

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockWebsocketsService = {
    emitUserEvent: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
      if (key === 'PAYMENT_WEBHOOK_SECRET') return webhookSecret;
      if (key === 'NIUBIZ_ENV') return 'sandbox';
      return defaultVal;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NiubizClient, useValue: mockNiubizClient },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: BlockchainService, useValue: mockBlockchainService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: WebsocketsService, useValue: mockWebsocketsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createSession', () => {
    it('permite crear sesión a rol RECOLECTOR', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-recolector-1',
        email: 'recolector@livora.pe',
        role: Role.RECOLECTOR,
        kycApplications: [{ status: 'APPROVED' }],
      });
      mockPrisma.paymentTransaction.create.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-recolector-1',
        amountPen: 25,
        tokenAmount: 25,
        purchaseNumber: '123456789012',
        status: 'PENDING',
      });
      mockNiubizClient.createSession.mockResolvedValue({
        sessionToken: 'token-session-live-123',
        merchantId: '456884108',
        purchaseNumber: '123456789012',
        amount: 25,
      });
      mockPrisma.paymentTransaction.update.mockResolvedValue({});

      const result = await service.createSession(
        'user-recolector-1',
        { amount: 25 },
        '200.48.10.2',
      );

      expect(result.amount).toBe(25);
      expect(result.tokenAmount).toBe(25);
      expect(result.sessionToken).toBe('token-session-live-123');
      expect(mockNiubizClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 25,
          clientIp: '200.48.10.2',
          kycStatus: 'APPROVED',
        }),
      );
    });

    it('bloquea y rechaza con 403 Forbidden a roles no autorizados como CENTRO_ACOPIO o ADMIN', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-centro-1',
        email: 'centro@livora.pe',
        role: Role.CENTRO_ACOPIO,
      });

      await expect(
        service.createSession('user-centro-1', { amount: 50 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('confirmPayment', () => {
    it('autoriza exitosamente y mintea tokens cuando Niubiz responde ACTION_CODE 000', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: Role.HOGAR,
      });
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        amountPen: 30,
        tokenAmount: 30,
        purchaseNumber: '123456789012',
        status: 'PENDING',
        user: { id: 'user-1', walletAddress: 'GBCORRECTWALLETADDRESS' },
      });
      mockNiubizClient.authorizeTransaction.mockResolvedValue({
        authorized: true,
        actionCode: '000',
        status: 'Authorized',
        cardBrand: 'VISA',
        cardPanMasked: '411111******1111',
        authorizationCode: '123456',
        traceNumber: '987654',
        raw: { status: 'Authorized' },
      });
      mockBlockchainService.mintEcoTokens.mockResolvedValue({ hash: 'tx-stellar-hash-abc' });
      mockPrisma.paymentTransaction.update.mockResolvedValue({});

      const result = await service.confirmPayment('user-1', {
        purchaseNumber: '123456789012',
        transactionToken: 'tok_valid_123',
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.tokenAmount).toBe(30);
      expect(result.cardBrand).toBe('VISA');
      expect(mockBlockchainService.mintEcoTokens).toHaveBeenCalledWith(
        'GBCORRECTWALLETADDRESS',
        30,
      );
    });

    it('deniega y actualiza a FAILED sin mintear tokens cuando Niubiz deniega la tarjeta', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: Role.HOGAR,
      });
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-1',
        amountPen: 30,
        tokenAmount: 30,
        purchaseNumber: '123456789012',
        status: 'PENDING',
        user: { id: 'user-1', walletAddress: 'GBCORRECTWALLETADDRESS' },
      });
      mockNiubizClient.authorizeTransaction.mockResolvedValue({
        authorized: false,
        actionCode: '101',
        status: 'Denied',
        description: 'Tarjeta vencida o fondos insuficientes',
        raw: { status: 'Denied' },
      });

      await expect(
        service.confirmPayment('user-1', {
          purchaseNumber: '123456789012',
          transactionToken: 'tok_invalid_123',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockBlockchainService.mintEcoTokens).not.toHaveBeenCalled();
    });
  });

  describe('processWebhook', () => {
    it('rechaza webhooks con firma HMAC inválida', async () => {
      await expect(
        service.processWebhook({
          purchaseNumber: '123456789012',
          signature: 'invalid_tampered_signature_12345678',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('acepta webhooks con firma HMAC válida calculada con el secreto', async () => {
      const purchaseNumber = '123456789012';
      const validSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(purchaseNumber)
        .digest('hex');

      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        purchaseNumber,
        status: 'COMPLETED',
        amountPen: 20,
      });

      const result = await service.processWebhook({
        purchaseNumber,
        signature: validSignature,
      });

      expect(result.status).toBe('COMPLETED');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { IzipayClient } from './services/izipay.client';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { MailService } from '../common/services/mail.service';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';

describe('PaymentsService (Izipay V4)', () => {
  let service: PaymentsService;

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
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountPen: 0 } }),
    },
  };

  const mockIzipayClient = {
    createPaymentToken: jest.fn(),
    verifyHmac: jest.fn(),
    getPublicKey: jest.fn().mockReturnValue('88005980:testpublickey_mock'),
    getShopId: jest.fn().mockReturnValue('88005980'),
  };

  const mockBlockchainService = {
    mintEcoTokens: jest.fn(),
  };

  const mockNotificationsService = {
    sendPushNotification: jest.fn().mockResolvedValue(true),
  };

  const mockWebsocketsService = {
    emitUserEvent: jest.fn(),
    emitToUser: jest.fn(),
  };

  const mockMailService = {
    sendAccreditationAlertToAdmin: jest.fn().mockResolvedValue(true),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultVal?: string) => defaultVal),
  };

  beforeEach(async () => {
    mockPrisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amountPen: 0 } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IzipayClient, useValue: mockIzipayClient },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: BlockchainService, useValue: mockBlockchainService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: WebsocketsService, useValue: mockWebsocketsService },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createSession', () => {
    it('permite crear sesión a rol RECOLECTOR con monto válido (>= S/ 10.00)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-recolector-1',
        email: 'recolector@livora.pe',
        role: Role.RECOLECTOR,
        walletAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      });
      mockPrisma.paymentTransaction.create.mockResolvedValue({
        id: 'tx-1',
        userId: 'user-recolector-1',
        amountPen: 25,
        tokenAmount: 25,
        purchaseNumber: 'ECO-123456789012-USER',
        status: 'PENDING',
      });
      mockIzipayClient.createPaymentToken.mockResolvedValue({
        formToken: 'mock-form-token-izipay-123',
        orderId: 'ECO-123456789012-USER',
        amountInSoles: 25,
      });
      mockPrisma.paymentTransaction.update.mockResolvedValue({});

      const dto = new CreatePaymentSessionDto();
      dto.amount = 25;

      const result = await service.createSession('user-recolector-1', dto);

      expect(result.success).toBe(true);
      expect(result.formToken).toBe('mock-form-token-izipay-123');
      expect(result.amount).toBe(25);
      expect(mockIzipayClient.createPaymentToken).toHaveBeenCalled();
    });

    it('permite crear sesión a rol TIENDA', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-tienda-1',
        email: 'tienda@livora.pe',
        role: Role.TIENDA,
      });
      mockPrisma.paymentTransaction.create.mockResolvedValue({
        id: 'tx-2',
        userId: 'user-tienda-1',
        amountPen: 50,
        tokenAmount: 50,
        purchaseNumber: 'ECO-987654321-TIEN',
        status: 'PENDING',
      });
      mockIzipayClient.createPaymentToken.mockResolvedValue({
        formToken: 'mock-form-token-tienda-456',
        orderId: 'ECO-987654321-TIEN',
        amountInSoles: 50,
      });
      mockPrisma.paymentTransaction.update.mockResolvedValue({});

      const dto = new CreatePaymentSessionDto();
      dto.amountInSoles = 50;

      const result = await service.createSession('user-tienda-1', dto);

      expect(result.success).toBe(true);
      expect(result.formToken).toBe('mock-form-token-tienda-456');
    });

    it('bloquea roles no autorizados como ADMIN o EMPRESA_B2B', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-admin-1',
        role: Role.ADMIN,
      });

      const dto = new CreatePaymentSessionDto();
      dto.amount = 20;

      await expect(
        service.createSession('user-admin-1', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rechaza montos menores a S/ 10.00', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-recolector-1',
        role: Role.RECOLECTOR,
      });

      const dto = new CreatePaymentSessionDto();
      dto.amount = 5;

      await expect(
        service.createSession('user-recolector-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza montos mayores a S/ 500.00 en una sola operación', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-recolector-1',
        role: Role.RECOLECTOR,
      });

      const dto = new CreatePaymentSessionDto();
      dto.amount = 600;

      await expect(
        service.createSession('user-recolector-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza recargas si el acumulado en 24 horas supera S/ 500.00', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-recolector-1',
        role: Role.RECOLECTOR,
      });

      // Simula que ya recargó S/ 450 en las últimas 24 horas
      mockPrisma.paymentTransaction.aggregate.mockResolvedValue({
        _sum: { amountPen: 450 },
      });

      const dto = new CreatePaymentSessionDto();
      dto.amount = 100; // 450 + 100 = 550 > 500

      await expect(
        service.createSession('user-recolector-1', dto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('processIzipayIpn', () => {
    it('procesa exitosamente IPN con firma HMAC válida y encola/ejecuta minteo', async () => {
      mockIzipayClient.verifyHmac.mockReturnValue(true);

      const fakeAnswer = {
        orderStatus: 'PAID',
        orderDetails: {
          orderId: 'ECO-123456',
          orderTotalAmount: 2000,
        },
        transactions: [
          {
            transactionDetails: {
              cardDetails: {
                effectiveBrand: 'VISA',
                pan: '411111XXXXXX1111',
                authorizationResponse: {
                  authorizationNumber: '123456',
                },
              },
            },
          },
        ],
      };

      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-100',
        purchaseNumber: 'ECO-123456',
        amountPen: 20,
        tokenAmount: 20,
        status: 'PENDING',
        user: {
          id: 'user-1',
          walletAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        },
      });

      mockPrisma.paymentTransaction.update.mockResolvedValue({});
      mockBlockchainService.mintEcoTokens.mockResolvedValue({ hash: 'soroban-tx-hash-789' });

      const result = await service.processIzipayIpn({
        'kr-answer': JSON.stringify(fakeAnswer),
        'kr-hash': 'valid_hmac_hash',
      });

      expect(result).toBe('OK');
      expect(mockIzipayClient.verifyHmac).toHaveBeenCalled();
      expect(mockBlockchainService.mintEcoTokens).toHaveBeenCalledWith(
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        20,
      );
      expect(mockNotificationsService.sendPushNotification).toHaveBeenCalled();
    });

    it('rechaza IPN con firma HMAC inválida', async () => {
      mockIzipayClient.verifyHmac.mockReturnValue(false);

      await expect(
        service.processIzipayIpn({
          'kr-answer': JSON.stringify({ orderStatus: 'PAID' }),
          'kr-hash': 'invalid_hash',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('cumple idempotencia si la transacción ya está COMPLETED', async () => {
      mockIzipayClient.verifyHmac.mockReturnValue(true);

      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-already-done',
        purchaseNumber: 'ECO-IDEMPOTENT',
        status: 'COMPLETED',
        user: { id: 'user-1' },
      });

      const result = await service.processIzipayIpn({
        'kr-answer': JSON.stringify({
          orderStatus: 'PAID',
          orderDetails: { orderId: 'ECO-IDEMPOTENT' },
        }),
        'kr-hash': 'valid_hash',
      });

      expect(result).toBe('OK');
      expect(mockBlockchainService.mintEcoTokens).not.toHaveBeenCalled();
    });
  });

  describe('renderCheckoutPage', () => {
    it('renderiza HTML con Krypton JS cuando la transacción está PENDING', async () => {
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-html-1',
        purchaseNumber: 'ECO-HTML-1',
        amountPen: 35.0,
        transactionToken: 'form-token-xyz',
        status: 'PENDING',
      });

      const html = await service.renderCheckoutPage('ECO-HTML-1');

      expect(html).toContain('kr-payment-form.min.js');
      expect(html).toContain('kr-form-token="form-token-xyz"');
      expect(html).toContain('S/ 35.00 PEN');
      expect(html).toContain('IzipayBridge');
    });

    it('devuelve página de sesión expirada si la transacción no existe o ya no está PENDING', async () => {
      mockPrisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'tx-done',
        purchaseNumber: 'ECO-DONE',
        status: 'COMPLETED',
      });

      const html = await service.renderCheckoutPage('ECO-DONE');

      expect(html).toContain('Sesión de pago no válida o ya procesada');
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { IzipayPaymentAdapter } from './izipay-payment.adapter';
import { IzipayClient } from '../services/izipay.client';

describe('IzipayPaymentAdapter (PUCP Disoft - GoF Adapter Pattern)', () => {
  let adapter: IzipayPaymentAdapter;
  let mockIzipayClient: jest.Mocked<Partial<IzipayClient>>;

  beforeEach(() => {
    mockIzipayClient = {
      getPublicKey: jest.fn().mockReturnValue('pk_test_12345'),
      createPaymentToken: jest.fn().mockResolvedValue({
        formToken: 'mock_form_token_777',
        orderId: 'ECO-ORDER-1',
        amountInSoles: 50.0,
      }),
      verifyHmac: jest.fn(),
    };

    adapter = new IzipayPaymentAdapter(mockIzipayClient as IzipayClient);
  });

  it('debe exponer el identificador del gateway y la clave pública', () => {
    expect(adapter.getGatewayIdentifier()).toBe('IZIPAY_KRYPTON_V4');
    expect(adapter.getPublicKey()).toBe('pk_test_12345');
  });

  it('debe adaptar createPaymentSession invocando el cliente Izipay subyacente', async () => {
    const params = {
      amountInSoles: 50.0,
      orderId: 'ECO-ORDER-1',
      customerEmail: 'test@livora.pe',
      userId: 'user-1',
    };

    const result = await adapter.createPaymentSession(params);

    expect(result.formToken).toBe('mock_form_token_777');
    expect(result.orderId).toBe('ECO-ORDER-1');
    expect(result.amountInSoles).toBe(50.0);
    expect(mockIzipayClient.createPaymentToken).toHaveBeenCalledWith(params);
  });

  it('debe verificar y parsear un payload IPN válido correctamente', () => {
    (mockIzipayClient.verifyHmac as jest.Mock).mockReturnValue(true);

    const rawPayload = {
      orderStatus: 'PAID',
      orderDetails: {
        orderId: 'ECO-ORDER-1',
        orderTotalAmount: 5000,
      },
      transactions: [
        {
          transactionDetails: {
            cardDetails: {
              effectiveBrand: 'VISA',
              pan: '411111XXXXXX1111',
              authorizationResponse: {
                authorizationNumber: 'AUTH999',
              },
            },
          },
        },
      ],
    };

    const dto = {
      'kr-answer': JSON.stringify(rawPayload),
      'kr-hash': 'valid_hash_abc',
      'kr-hash-key': 'sha256_hmac',
    };

    const result = adapter.verifyAndParseIpn(dto);

    expect(result.isValid).toBe(true);
    expect(result.orderId).toBe('ECO-ORDER-1');
    expect(result.isPaid).toBe(true);
    expect(result.amountPen).toBe(50.0);
    expect(result.cardBrand).toBe('VISA');
    expect(result.cardPanMasked).toBe('411111XXXXXX1111');
    expect(result.authorizationCode).toBe('AUTH999');
  });

  it('debe lanzar BadRequestException si faltan kr-answer o kr-hash', () => {
    expect(() => adapter.verifyAndParseIpn({})).toThrow(BadRequestException);
  });

  it('debe lanzar BadRequestException si la firma HMAC no coincide', () => {
    (mockIzipayClient.verifyHmac as jest.Mock).mockReturnValue(false);

    const dto = {
      'kr-answer': JSON.stringify({ orderStatus: 'PAID' }),
      'kr-hash': 'invalid_hash',
    };

    expect(() => adapter.verifyAndParseIpn(dto)).toThrow(BadRequestException);
  });
});

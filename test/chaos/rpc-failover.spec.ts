import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StellarRpcManagerService } from '../../src/blockchain/services/stellar-rpc-manager.service';
import { PrometheusService } from '../../src/metrics/prometheus.service';

describe('Chaos Testing: Stellar Soroban Multi-RPC Failover', () => {
  let rpcManager: StellarRpcManagerService;
  let prometheusService: PrometheusService;

  const mockRpcUrls = [
    'https://primary-soroban.stellar.org',
    'https://secondary-soroban.stellar.org',
    'https://tertiary-soroban.stellar.org',
  ];

  beforeEach(async () => {
    const configServiceMock = {
      get: jest.fn((key: string) => {
        if (key === 'STELLAR_SOROBAN_RPC_URLS') return mockRpcUrls.join(',');
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarRpcManagerService,
        PrometheusService,
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    rpcManager = module.get<StellarRpcManagerService>(StellarRpcManagerService);
    prometheusService = module.get<PrometheusService>(PrometheusService);
    rpcManager.onModuleInit();
  });

  afterEach(() => {
    rpcManager.onModuleDestroy();
  });

  it('Chaos 1: should failover from HTTP 500 on Primary to Secondary in < 100ms', async () => {
    const startTime = performance.now();

    const result = await rpcManager.executeWithFailover(
      async (server, nodeUrl) => {
        if (nodeUrl === 'https://primary-soroban.stellar.org') {
          throw new Error('HTTP 500 Internal Server Error on Primary Node');
        }
        return {
          servedBy: nodeUrl,
          latestLedger: 123456,
        };
      },
    );

    const elapsed = performance.now() - startTime;

    expect(result.servedBy).toBe('https://secondary-soroban.stellar.org');
    expect(result.latestLedger).toBe(123456);
    expect(elapsed).toBeLessThan(100); // Failover inmediato < 100ms
  });

  it('Chaos 2: should handle HTTP 429 Rate Limiting on Primary and switch to Secondary seamlessly', async () => {
    const result = await rpcManager.executeWithFailover(
      async (server, nodeUrl) => {
        if (nodeUrl === 'https://primary-soroban.stellar.org') {
          throw new Error('HTTP 429 Too Many Requests: Rate limit exceeded');
        }
        return {
          servedBy: nodeUrl,
          success: true,
        };
      },
    );

    expect(result.servedBy).toBe('https://secondary-soroban.stellar.org');
    expect(result.success).toBe(true);
  });

  it('Chaos 3: should handle RPC Timeout on Primary and failover without unhandled exceptions', async () => {
    const result = await rpcManager.executeWithFailover(
      async (server, nodeUrl) => {
        if (nodeUrl === 'https://primary-soroban.stellar.org') {
          throw new Error('Request timeout after 5000ms');
        }
        return {
          servedBy: nodeUrl,
          data: 'ok',
        };
      },
    );

    expect(result.servedBy).toBe('https://secondary-soroban.stellar.org');
    expect(result.data).toBe('ok');
  });

  it('Chaos 4: should mark Primary as UNHEALTHY after 3 consecutive failures and bypass it for subsequent calls', async () => {
    // 3 llamadas fallidas en el nodo primario
    for (let i = 0; i < 3; i++) {
      await rpcManager.executeWithFailover(async (server, nodeUrl) => {
        if (nodeUrl === 'https://primary-soroban.stellar.org') {
          throw new Error('Downstream network fault');
        }
        return { nodeUrl };
      });
    }

    const nodes = rpcManager.getNodes();
    expect(nodes[0].status).toBe('UNHEALTHY');
    expect(nodes[0].consecutiveFailures).toBe(3);
    expect(nodes[0].cooldownUntil).toBeGreaterThan(Date.now());

    // La 4ª llamada debe ir directamente a nodos saludables
    const nextCall = await rpcManager.executeWithFailover(async (server, nodeUrl) => {
      return { nodeUrl };
    });

    expect(nextCall.nodeUrl).not.toBe('https://primary-soroban.stellar.org');
  });
});

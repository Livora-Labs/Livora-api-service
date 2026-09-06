import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { rpc as StellarRpc } from '@stellar/stellar-sdk';
import {
  StellarRpcManagerService,
  RPC_COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILURES,
} from './stellar-rpc-manager.service';

describe('StellarRpcManagerService (Multi-RPC Failover & Passive Cooldown)', () => {
  let manager: StellarRpcManagerService;
  let configService: ConfigService;

  const url1 = 'https://rpc-node-1.stellar.org';
  const url2 = 'https://rpc-node-2.stellar.org';
  const url3 = 'https://rpc-node-3.stellar.org';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarRpcManagerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal: any) => {
              if (key === 'STELLAR_SOROBAN_RPC_URLS') {
                return `${url1},${url2},${url3}`;
              }
              if (key === 'STELLAR_CB_TIMEOUT') return 2000;
              if (key === 'STELLAR_CB_ERROR_THRESHOLD') return 50;
              if (key === 'STELLAR_CB_RESET_TIMEOUT') return 5000;
              if (key === 'STELLAR_CB_VOLUME_THRESHOLD') return 2;
              return defaultVal;
            }),
          },
        },
      ],
    }).compile();

    manager = module.get<StellarRpcManagerService>(StellarRpcManagerService);
    configService = module.get<ConfigService>(ConfigService);
    manager.onModuleInit();
  });

  afterEach(() => {
    manager.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('should initialize with all 3 configured RPC endpoints in HEALTHY state', () => {
    const nodes = manager.getNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes[0].url).toBe(url1);
    expect(nodes[1].url).toBe(url2);
    expect(nodes[2].url).toBe(url3);
    expect(nodes.every((n) => n.status === 'HEALTHY')).toBe(true);
  });

  it('should immediately failover to Node 2 when Node 1 fails with HTTP 429 Rate Limited', async () => {
    const nodes = manager.getNodes();
    const mockGetHealth1 = jest
      .spyOn(nodes[0].server, 'getHealth')
      .mockRejectedValue(new Error('HTTP 429 Too Many Requests'));
    const mockGetHealth2 = jest
      .spyOn(nodes[1].server, 'getHealth')
      .mockResolvedValue({ status: 'healthy' } as any);

    const startTime = Date.now();
    const result = await manager.getHealth();
    const duration = Date.now() - startTime;

    expect(result.status).toBe('healthy');
    expect(mockGetHealth1).toHaveBeenCalledTimes(1);
    expect(mockGetHealth2).toHaveBeenCalledTimes(1);
    expect(nodes[0].consecutiveFailures).toBe(1);
    expect(nodes[1].consecutiveFailures).toBe(0);
    expect(duration).toBeLessThan(150); // Conmutación rápida < 150ms
  });

  it('should mark node UNHEALTHY and put it in 5-minute cooldown after 3 consecutive failures', async () => {
    const nodes = manager.getNodes();
    jest
      .spyOn(nodes[0].server, 'getAccount')
      .mockRejectedValue(new Error('Gateway Timeout 504'));
    jest
      .spyOn(nodes[1].server, 'getAccount')
      .mockResolvedValue({ sequenceNumber: () => '100' } as any);

    // Ejecutar 3 llamadas que fallarán en Node 1 y tendrán éxito en Node 2
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const acc = await manager.getAccount('GBTESTACCOUNT');
      expect(acc.sequenceNumber()).toBe('100');
    }

    expect(nodes[0].status).toBe('UNHEALTHY');
    expect(nodes[0].consecutiveFailures).toBe(3);
    expect(nodes[0].cooldownUntil).toBeGreaterThan(Date.now() + RPC_COOLDOWN_MS - 5000);

    // En la 4ta llamada, Node 0 debe ser salteado inmediatamente sin ser llamado
    const mockNode0Call = jest.spyOn(nodes[0].server, 'getAccount');
    mockNode0Call.mockClear();

    await manager.getAccount('GBTESTACCOUNT');
    expect(mockNode0Call).not.toHaveBeenCalled();
  });

  it('should reincorporate node into pool after cooldown expires', async () => {
    const nodes = manager.getNodes();
    nodes[0].status = 'UNHEALTHY';
    nodes[0].cooldownUntil = Date.now() - 1000; // Cooldown vencido hace 1s

    jest
      .spyOn(nodes[0].server, 'getHealth')
      .mockResolvedValue({ status: 'healthy' } as any);

    const result = await manager.getHealth();
    expect(result.status).toBe('healthy');
    expect(nodes[0].status).toBe('HEALTHY');
    expect(nodes[0].consecutiveFailures).toBe(0);
    expect(nodes[0].cooldownUntil).toBe(0);
  });

  it('should throw aggregate error when 100% of RPC nodes fail', async () => {
    const nodes = manager.getNodes();
    nodes.forEach((n) => {
      jest.spyOn(n.server, 'getHealth').mockRejectedValue(new Error('Node unreachable'));
    });

    await expect(manager.getHealth()).rejects.toThrow(
      /Todos los nodos RPC de Soroban fallaron/,
    );
  });

  it('should execute simulation, sendTransaction and getTransaction through failover', async () => {
    const nodes = manager.getNodes();
    jest
      .spyOn(nodes[0].server, 'simulateTransaction')
      .mockResolvedValue({ result: { retval: 'mock-retval' } } as any);
    jest
      .spyOn(nodes[0].server, 'sendTransaction')
      .mockResolvedValue({ status: 'PENDING', hash: 'tx-hash-123' } as any);
    jest
      .spyOn(nodes[0].server, 'getTransaction')
      .mockResolvedValue({ status: 'SUCCESS', ledger: 12345 } as any);

    const sim = await manager.simulateTransaction({} as any);
    expect(sim).toBeDefined();

    const send = await manager.sendTransaction({} as any);
    expect(send.hash).toBe('tx-hash-123');

    const tx = await manager.getTransaction('tx-hash-123');
    expect(tx.status).toBe('SUCCESS');
  });
});

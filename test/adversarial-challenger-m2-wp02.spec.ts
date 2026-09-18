import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { rpc as StellarRpc } from '@stellar/stellar-sdk';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import {
  StellarRpcManagerService,
  RPC_COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILURES,
} from '../src/blockchain/services/stellar-rpc-manager.service';
import { IpfsService } from '../src/blockchain/services/ipfs.service';
import { RoleThrottlerGuard } from '../src/common/guards/role-throttler.guard';

describe('Adversarial Challenge Suite: Challenger 2 (WP-02 Web3 Failover & CGNAT Concurrency)', () => {
  const JWT_SECRET = 'cgnat_adversarial_challenge_jwt_secret_2026!';

  // =========================================================================
  // CHALLENGE 1: StellarRpcManagerService Multi-RPC Failover & Passive Cooldown
  // =========================================================================
  describe('Challenge 1: StellarRpcManagerService Failover & Cooldown', () => {
    let manager: StellarRpcManagerService;
    const url0 = 'https://soroban-node-0.stellar.org';
    const url1 = 'https://soroban-node-1.stellar.org';
    const url2 = 'https://soroban-node-2.stellar.org';

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarRpcManagerService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultVal: any) => {
                if (key === 'STELLAR_SOROBAN_RPC_URLS') {
                  return `${url0},${url1},${url2}`;
                }
                if (key === 'STELLAR_CB_TIMEOUT') return 2000;
                if (key === 'STELLAR_CB_ERROR_THRESHOLD') return 50;
                if (key === 'STELLAR_CB_RESET_TIMEOUT') return 5000;
                if (key === 'STELLAR_CB_VOLUME_THRESHOLD') return 2;
                if (key === 'STELLAR_NODE_TIMEOUT_MS') return 300;
                return defaultVal;
              }),
            },
          },
        ],
      }).compile();

      manager = module.get<StellarRpcManagerService>(StellarRpcManagerService);
      manager.onModuleInit();
    });

    afterEach(() => {
      manager.onModuleDestroy();
      jest.restoreAllMocks();
    });

    it('1.1: Node 0 must accumulate failure counts and transition to UNHEALTHY after 3 consecutive failures', async () => {
      const nodes = manager.getNodes();
      expect(nodes).toHaveLength(3);
      expect(nodes[0].url).toBe(url0);
      expect(nodes[1].url).toBe(url1);

      // Node 0 always fails; Node 1 always succeeds
      const node0Spy = jest
        .spyOn(nodes[0].server, 'getHealth')
        .mockRejectedValue(new Error('503 Service Unavailable'));
      const node1Spy = jest
        .spyOn(nodes[1].server, 'getHealth')
        .mockResolvedValue({ status: 'healthy' } as any);

      // Attempt 1: Node 0 fails -> Node 1 succeeds
      const res1 = await manager.getHealth();
      expect(res1.status).toBe('healthy');
      expect(nodes[0].consecutiveFailures).toBe(1);
      expect(nodes[0].status).toBe('HEALTHY');
      expect(nodes[1].consecutiveFailures).toBe(0);

      // Attempt 2: Node 0 fails -> Node 1 succeeds
      const res2 = await manager.getHealth();
      expect(res2.status).toBe('healthy');
      expect(nodes[0].consecutiveFailures).toBe(2);
      expect(nodes[0].status).toBe('HEALTHY');

      // Attempt 3: Node 0 fails -> Node 1 succeeds. Should trigger UNHEALTHY transition
      const res3 = await manager.getHealth();
      expect(res3.status).toBe('healthy');
      expect(nodes[0].consecutiveFailures).toBe(3);
      expect(nodes[0].status).toBe('UNHEALTHY');
      expect(nodes[0].cooldownUntil).toBeGreaterThan(Date.now() + RPC_COOLDOWN_MS - 2000);

      // Attempt 4: Node 0 is UNHEALTHY; must be skipped entirely without invocation
      node0Spy.mockClear();
      node1Spy.mockClear();

      const res4 = await manager.getHealth();
      expect(res4.status).toBe('healthy');
      expect(node0Spy).not.toHaveBeenCalled(); // Node 0 skipped
      expect(node1Spy).toHaveBeenCalledTimes(1); // Node 1 served request directly
    });

    it('1.2: Multi-node cascading failover: Node 0 and Node 1 fail, Node 2 succeeds seamlessly', async () => {
      const nodes = manager.getNodes();
      const node0Spy = jest
        .spyOn(nodes[0].server, 'getHealth')
        .mockRejectedValue(new Error('Node 0 connection timeout'));
      const node1Spy = jest
        .spyOn(nodes[1].server, 'getHealth')
        .mockRejectedValue(new Error('Node 1 rate limit 429'));
      const node2Spy = jest
        .spyOn(nodes[2].server, 'getHealth')
        .mockResolvedValue({ status: 'healthy' } as any);

      const result = await manager.getHealth();
      expect(result.status).toBe('healthy');

      expect(node0Spy).toHaveBeenCalledTimes(1);
      expect(node1Spy).toHaveBeenCalledTimes(1);
      expect(node2Spy).toHaveBeenCalledTimes(1);

      expect(nodes[0].consecutiveFailures).toBe(1);
      expect(nodes[1].consecutiveFailures).toBe(1);
      expect(nodes[2].consecutiveFailures).toBe(0);
    });

    it('1.3: Timeout per node: Hanging node is aborted after nodeTimeoutMs and failover proceeds', async () => {
      const nodes = manager.getNodes();

      // Node 0 hangs for 1000ms (exceeding configured 300ms node timeout)
      jest.spyOn(nodes[0].server, 'getHealth').mockImplementation(() => {
        return new Promise((resolve) => setTimeout(() => resolve({ status: 'healthy' } as any), 1000));
      });

      // Node 1 responds immediately
      jest.spyOn(nodes[1].server, 'getHealth').mockResolvedValue({ status: 'healthy' } as any);

      const startTime = Date.now();
      const result = await manager.getHealth();
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('healthy');
      // Should have timed out after ~300ms and switched to Node 1, taking far less than 1000ms
      expect(elapsed).toBeLessThan(800);
      expect(nodes[0].consecutiveFailures).toBe(1);
    });

    it('1.4: Exhaustion of all nodes triggers emergency attempt on node with earliest cooldown', async () => {
      const nodes = manager.getNodes();
      // Put all nodes in UNHEALTHY cooldown
      const now = Date.now();
      nodes[0].status = 'UNHEALTHY';
      nodes[0].cooldownUntil = now + 100000;
      nodes[1].status = 'UNHEALTHY';
      nodes[1].cooldownUntil = now + 50000; // Earliest cooldown!
      nodes[2].status = 'UNHEALTHY';
      nodes[2].cooldownUntil = now + 150000;

      // Node 1 is fallback candidate; let's simulate recovery on Node 1
      const fallbackSpy = jest
        .spyOn(nodes[1].server, 'getHealth')
        .mockResolvedValue({ status: 'healthy' } as any);

      const result = await manager.getHealth();
      expect(result.status).toBe('healthy');
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(nodes[1].status).toBe('HEALTHY');
      expect(nodes[1].consecutiveFailures).toBe(0);
    });

    it('1.5: Cooldown expiration reincorporates node as HEALTHY on next cycle', async () => {
      const nodes = manager.getNodes();
      nodes[0].status = 'UNHEALTHY';
      nodes[0].consecutiveFailures = 3;
      nodes[0].cooldownUntil = Date.now() - 500; // Expired 500ms ago

      jest.spyOn(nodes[0].server, 'getHealth').mockResolvedValue({ status: 'healthy' } as any);

      const result = await manager.getHealth();
      expect(result.status).toBe('healthy');
      expect(nodes[0].status).toBe('HEALTHY');
      expect(nodes[0].consecutiveFailures).toBe(0);
      expect(nodes[0].cooldownUntil).toBe(0);
    });
  });

  // =========================================================================
  // CHALLENGE 2: Blockchain Processor & IPFS Verification
  // =========================================================================
  describe('Challenge 2: IPFS Multihash SHA-256 CIDv0 Derivation & Static Integrity', () => {
    let ipfsService: IpfsService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          IpfsService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'PINATA_API_KEY') return 'value'; // Forces fallback deterministic compute
                if (key === 'PINATA_SECRET_KEY') return 'value';
                if (key === 'IPFS_GATEWAY_URL') return 'https://ipfs.io/ipfs/';
                return null;
              }),
            },
          },
        ],
      }).compile();

      ipfsService = module.get<IpfsService>(IpfsService);
    });

    it('2.1: computeIpfsCidV0 generates deterministic, valid Multihash SHA-256 CIDv0 (Qm... 46 chars)', () => {
      const testPayload = {
        batchId: '00000000-0000-0000-0000-000000000001',
        totalKg: 154.5,
        materialsActual: { CARTON: 100, PET: 54.5 },
      };

      const cid1 = ipfsService.computeIpfsCidV0(testPayload);
      const cid2 = ipfsService.computeIpfsCidV0(testPayload);

      // Determinism
      expect(cid1).toBe(cid2);

      // CIDv0 format specification: Base58btc starting with 'Qm', exactly 46 characters
      expect(cid1).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(cid1.length).toBe(46);
      expect(cid1.startsWith('Qm')).toBe(true);

      // Different payload yields distinct CID
      const diffPayload = { ...testPayload, totalKg: 154.6 };
      const cidDiff = ipfsService.computeIpfsCidV0(diffPayload);
      expect(cidDiff).not.toBe(cid1);
      expect(cidDiff).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    });

    it('2.2: Cryptographic validation of Multihash binary envelope (0x12 0x20 SHA-256)', () => {
      const payload = 'Livora Test Multihash Content';
      const cid = ipfsService.computeIpfsCidV0(payload);

      // Decode base58btc to verify exact 34-byte envelope
      const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let num = 0n;
      for (const char of cid) {
        const index = alphabet.indexOf(char);
        expect(index).toBeGreaterThanOrEqual(0);
        num = num * 58n + BigInt(index);
      }

      let hex = num.toString(16);
      if (hex.length % 2 !== 0) hex = '0' + hex;
      const decodedBuffer = Buffer.from(hex, 'hex');

      // Multihash specification:
      // Byte 0: 0x12 (Function code for SHA2-256)
      // Byte 1: 0x20 (Digest size: 32 bytes)
      // Bytes 2-33: SHA-256 digest of payload
      expect(decodedBuffer[0]).toBe(0x12);
      expect(decodedBuffer[1]).toBe(0x20);
      expect(decodedBuffer.length).toBe(34);

      const expectedDigest = crypto.createHash('sha256').update(payload).digest();
      const actualDigest = decodedBuffer.subarray(2);
      expect(actualDigest).toEqual(expectedDigest);
    });

    it('2.3: uploadBatchMetadata returns gateway URL without synthetic DUMMY_IPFS_HASH', async () => {
      const manifest = { batchId: 'batch-test-123', totalKg: 50 };
      const cid = await ipfsService.uploadBatchMetadata(manifest);

      expect(cid).toBeDefined();
      expect(cid).not.toContain('DUMMY');
      expect(cid).not.toContain('dummy');
      expect(cid.startsWith('Qm')).toBe(true);
      expect(cid.length).toBe(46);

      const gatewayUrl = ipfsService.getGatewayUrl(cid);
      expect(gatewayUrl).toBe(`https://ipfs.io/ipfs/${cid}`);
    });
  });

  // =========================================================================
  // CHALLENGE 3: RoleThrottlerGuard CGNAT Simulation & Dynamic Role Limits
  // =========================================================================
  describe('Challenge 3: RoleThrottlerGuard CGNAT Simulation & Role Limits', () => {
    let guard: RoleThrottlerGuard;
    let storageMock: any;
    const trackedKeys: Array<{ key: string; limit: number; ttl: number }> = [];

    beforeEach(async () => {
      trackedKeys.length = 0;
      process.env.SUPABASE_JWT_SECRET = JWT_SECRET;

      storageMock = {
        increment: jest.fn().mockImplementation((key: string, ttl: number, limit: number) => {
          trackedKeys.push({ key, limit, ttl });
          return Promise.resolve({
            totalHits: 1,
            timeToExpire: ttl,
            isBlocked: false,
            timeToBlockExpire: 0,
          });
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          ThrottlerModule.forRoot({
            throttlers: [{ name: 'default', ttl: 60000, limit: 100 }],
          }),
        ],
        providers: [
          RoleThrottlerGuard,
          { provide: ThrottlerStorage, useValue: storageMock },
        ],
      }).compile();

      await module.init();
      guard = module.get<RoleThrottlerGuard>(RoleThrottlerGuard);
    });

    const dummyHandler = () => {};
    class DummyController {}

    const createMockHttpContext = (authHeader?: string, clientIp = '181.176.50.10') => {
      const req: any = {
        headers: authHeader ? { authorization: authHeader } : {},
        ip: clientIp,
        ips: [clientIp],
      };

      const ctx: Partial<ExecutionContext> = {
        getType: jest.fn().mockReturnValue('http'),
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: () => req,
          getResponse: () => ({ header: jest.fn() }),
        }),
        getHandler: (() => dummyHandler) as any,
        getClass: (() => DummyController) as any,
      };

      return { ctx: ctx as ExecutionContext, req };
    };

    it('3.1: CGNAT Isolation: Multiple distinct users behind the SAME public IP are keyed by user:<id>', async () => {
      const cgnatIp = '200.48.65.35'; // Common CGNAT IP in Peru (Telefónica del Perú)

      const userHogar1 = { id: 'usr-hogar-001', role: Role.HOGAR };
      const userHogar2 = { id: 'usr-hogar-002', role: Role.HOGAR };
      const userRecolector = { id: 'usr-recolector-001', role: Role.RECOLECTOR };
      const userCentro = { id: 'usr-centro-001', role: Role.CENTRO_ACOPIO };

      const token1 = jwt.sign({ sub: userHogar1.id, role: userHogar1.role }, JWT_SECRET);
      const token2 = jwt.sign({ sub: userHogar2.id, role: userHogar2.role }, JWT_SECRET);
      const token3 = jwt.sign({ sub: userRecolector.id, role: userRecolector.role }, JWT_SECRET);
      const token4 = jwt.sign({ sub: userCentro.id, role: userCentro.role }, JWT_SECRET);

      // Execute canActivate on simulated requests all arriving from identical CGNAT IP
      const { ctx: ctx1, req: req1 } = createMockHttpContext(`Bearer ${token1}`, cgnatIp);
      const { ctx: ctx2, req: req2 } = createMockHttpContext(`Bearer ${token2}`, cgnatIp);
      const { ctx: ctx3, req: req3 } = createMockHttpContext(`Bearer ${token3}`, cgnatIp);
      const { ctx: ctx4, req: req4 } = createMockHttpContext(`Bearer ${token4}`, cgnatIp);
      const { ctx: ctxAnon, req: reqAnon } = createMockHttpContext(undefined, cgnatIp);

      await guard.canActivate(ctx1);
      await guard.canActivate(ctx2);
      await guard.canActivate(ctx3);
      await guard.canActivate(ctx4);
      await guard.canActivate(ctxAnon);

      // Verify tracker resolution
      const tracker1 = await (guard as any).getTracker(req1);
      const tracker2 = await (guard as any).getTracker(req2);
      const tracker3 = await (guard as any).getTracker(req3);
      const tracker4 = await (guard as any).getTracker(req4);
      const trackerAnon = await (guard as any).getTracker(reqAnon);

      expect(tracker1).toBe(`user:${userHogar1.id}`);
      expect(tracker2).toBe(`user:${userHogar2.id}`);
      expect(tracker3).toBe(`user:${userRecolector.id}`);
      expect(tracker4).toBe(`user:${userCentro.id}`);
      expect(trackerAnon).toBe(cgnatIp);

      // Critical assertion: None of the authenticated trackers collide despite identical IP
      const trackers = [tracker1, tracker2, tracker3, tracker4];
      const uniqueTrackers = new Set(trackers);
      expect(uniqueTrackers.size).toBe(4);
    });

    it('3.2: Dynamic role rate limits are accurately mapped in handleRequest', async () => {
      const rolesAndLimits: Array<{ role: Role; expectedLimit: number }> = [
        { role: Role.HOGAR, expectedLimit: 60 },
        { role: Role.RECOLECTOR, expectedLimit: 120 },
        { role: Role.CENTRO_ACOPIO, expectedLimit: 300 },
        { role: Role.ADMIN, expectedLimit: 500 },
        { role: Role.EMPRESA_B2B, expectedLimit: 150 },
        { role: Role.TIENDA, expectedLimit: 150 },
      ];

      for (const { role, expectedLimit } of rolesAndLimits) {
        const token = jwt.sign({ sub: `usr-${role.toLowerCase()}`, role }, JWT_SECRET);
        const { ctx, req } = createMockHttpContext(`Bearer ${token}`);
        await guard.canActivate(ctx);

        const throttler = { name: 'default', ttl: 60000, limit: 100 };
        await guard['handleRequest']({
          context: ctx,
          limit: 100,
          ttl: 60000,
          throttler,
          blockDuration: 0,
          getTracker: (r) => (guard as any).getTracker(r),
          generateKey: (_c, suffix, name) => `${name}-${suffix}`,
        });

        const lastTracked = trackedKeys[trackedKeys.length - 1];
        expect(lastTracked.limit).toBe(expectedLimit);
        expect(lastTracked.key).toBe(`default-user:usr-${role.toLowerCase()}`);
      }
    });

    it('3.3: CGNAT Non-Interference: Rate exhaustion of User 1 does NOT block User 2 on same IP', async () => {
      const cgnatIp = '190.236.100.5';

      const tokenUser1 = jwt.sign({ sub: 'victim-user-1', role: Role.HOGAR }, JWT_SECRET);
      const tokenUser2 = jwt.sign({ sub: 'innocent-user-2', role: Role.HOGAR }, JWT_SECRET);

      const expectedVictimHash = crypto
        .createHash('sha256')
        .update('DummyController-dummyHandler-default-user:victim-user-1')
        .digest('hex');

      // Setup storage mock where victim-user-1 is exhausted (isBlocked: true)
      // but innocent-user-2 is fresh (isBlocked: false)
      storageMock.increment.mockImplementation((key: string, ttl: number, limit: number) => {
        if (key === expectedVictimHash || key.includes('victim-user-1')) {
          return Promise.resolve({
            totalHits: 61,
            timeToExpire: 50000,
            isBlocked: true,
            timeToBlockExpire: 50000,
          });
        }
        return Promise.resolve({
          totalHits: 1,
          timeToExpire: 60000,
          isBlocked: false,
          timeToBlockExpire: 0,
        });
      });

      const { ctx: ctx1 } = createMockHttpContext(`Bearer ${tokenUser1}`, cgnatIp);
      const { ctx: ctx2 } = createMockHttpContext(`Bearer ${tokenUser2}`, cgnatIp);

      // User 1 attempt throws ThrottlerException (blocked)
      await expect(guard.canActivate(ctx1)).rejects.toThrow();

      // User 2 from the SAME CGNAT IP is allowed through without error!
      const user2Allowed = await guard.canActivate(ctx2);
      expect(user2Allowed).toBe(true);
    });
  });
});

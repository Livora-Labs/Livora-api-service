import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rpc as StellarRpc, Account } from '@stellar/stellar-sdk';
import CircuitBreaker from 'opossum';
import { STELLAR_CIRCUIT_BREAKER_OPTIONS } from './blockchain.service';
import { PrometheusService } from '../../metrics/prometheus.service';

export interface RpcNodeState {
  url: string;
  server: StellarRpc.Server;
  tier: 'PRIMARY' | 'SECONDARY' | 'FALLBACK';
  weight: number;
  consecutiveFailures: number;
  status: 'HEALTHY' | 'UNHEALTHY';
  cooldownUntil: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
}

export const DEFAULT_SOROBAN_RPC_URLS = [
  'https://soroban-testnet.stellar.org',
  'https://rpc.publicnode.org/soroban/testnet',
  'https://testnet.sorobanrpc.com',
];

export const RPC_COOLDOWN_MS = 60 * 1000; // 60 segundos de cooldown
export const MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_NODE_TIMEOUT_MS = 3000; // 3.0s timeout activo

@Injectable()
export class StellarRpcManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarRpcManagerService.name);
  private nodes: RpcNodeState[] = [];
  private activeNodeIndex = 0;
  private roundRobinCursor = 0;
  private rpcBreaker: CircuitBreaker;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly prometheusService?: PrometheusService,
  ) {}

  onModuleInit() {
    this.initNodes();
    this.initCircuitBreaker();
  }

  onModuleDestroy() {
    if (this.rpcBreaker) {
      this.rpcBreaker.shutdown();
    }
    this.nodes = [];
  }

  private calculateCooldownWithJitter(baseCooldownMs: number): number {
    // Full Jitter / Decorrelated Jitter: 0 a 5000ms adicionales para prevenir thundering herd
    const jitterMs = Math.floor(Math.random() * 5000);
    return Date.now() + baseCooldownMs + jitterMs;
  }

  /**
   * Inicializa la lista de nodos RPC a partir de variables de entorno o valores por defecto.
   */
  private initNodes() {
    const primaryQuicknode =
      this.configService.get<string>('QUICKNODE_RPC_URL_PRIMARY') ||
      this.configService.get<string>('QUICKNODE_RPC_URL') ||
      this.configService.get<string>('STELLAR_QUICKNODE_URL');

    const secondaryQuicknode =
      this.configService.get<string>('QUICKNODE_RPC_URL_SECONDARY') ||
      this.configService.get<string>('STELLAR_QUICKNODE_SECONDARY_URL') ||
      this.configService.get<string>('QUICKNODE_BACKUP_RPC_URL');

    const rpcUrlsConfig =
      this.configService.get<string>('STELLAR_SOROBAN_RPC_URLS') ||
      this.configService.get<string>('STELLAR_RPC_URLS') ||
      this.configService.get<string>('STELLAR_RPC_URL');

    const timeoutMs = this.configService.get<number>(
      'STELLAR_NODE_TIMEOUT_MS',
      DEFAULT_NODE_TIMEOUT_MS,
    );

    const candidateNodes: RpcNodeState[] = [];

    // 1. Primary QuickNode
    if (primaryQuicknode && primaryQuicknode.trim().startsWith('http')) {
      candidateNodes.push({
        url: primaryQuicknode.trim(),
        server: new StellarRpc.Server(primaryQuicknode.trim(), {
          timeout: timeoutMs,
          allowHttp: false,
        }),
        tier: 'PRIMARY',
        weight: 10,
        consecutiveFailures: 0,
        status: 'HEALTHY',
        cooldownUntil: 0,
        totalRequests: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      });
    }

    // 2. Secondary QuickNode
    if (secondaryQuicknode && secondaryQuicknode.trim().startsWith('http')) {
      candidateNodes.push({
        url: secondaryQuicknode.trim(),
        server: new StellarRpc.Server(secondaryQuicknode.trim(), {
          timeout: timeoutMs,
          allowHttp: false,
        }),
        tier: 'SECONDARY',
        weight: 5,
        consecutiveFailures: 0,
        status: 'HEALTHY',
        cooldownUntil: 0,
        totalRequests: 0,
        totalSuccesses: 0,
        totalFailures: 0,
      });
    }

    // 3. Fallback Soroban Public RPCs
    let fallbacks: string[] = [];
    if (rpcUrlsConfig) {
      fallbacks = rpcUrlsConfig
        .split(',')
        .map((u) => u.trim())
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    }

    if (fallbacks.length === 0 && candidateNodes.length === 0) {
      fallbacks = [...DEFAULT_SOROBAN_RPC_URLS];
    }

    for (const url of fallbacks) {
      if (!candidateNodes.some((n) => n.url === url)) {
        let tier: 'PRIMARY' | 'SECONDARY' | 'FALLBACK' = 'FALLBACK';
        let weight = 1;
        if (!primaryQuicknode && candidateNodes.length === 0) {
          tier = 'PRIMARY';
          weight = 10;
        } else if (
          !secondaryQuicknode &&
          candidateNodes.length === 1 &&
          candidateNodes[0].tier === 'PRIMARY'
        ) {
          tier = 'SECONDARY';
          weight = 5;
        }

        candidateNodes.push({
          url,
          server: new StellarRpc.Server(url, {
            timeout: timeoutMs,
            allowHttp: false,
          }),
          tier,
          weight,
          consecutiveFailures: 0,
          status: 'HEALTHY',
          cooldownUntil: 0,
          totalRequests: 0,
          totalSuccesses: 0,
          totalFailures: 0,
        });
      }
    }

    this.nodes = candidateNodes;
    this.logger.log(
      `[StellarRpcManager] Inicializado con ${this.nodes.length} endpoints RPC (Primary QN: ${Boolean(primaryQuicknode)}, Secondary QN: ${Boolean(secondaryQuicknode)}): ${this.nodes.map((n) => `[${n.tier}] ${n.url}`).join(', ')}`,
    );
  }

  /**
   * Inicializa el Circuit Breaker de Opossum envolviendo el pool Multi-RPC.
   */
  private initCircuitBreaker() {
    const options: CircuitBreaker.Options = {
      timeout: this.configService.get<number>(
        'STELLAR_CB_TIMEOUT',
        STELLAR_CIRCUIT_BREAKER_OPTIONS.timeout as number,
      ),
      errorThresholdPercentage: this.configService.get<number>(
        'STELLAR_CB_ERROR_THRESHOLD',
        STELLAR_CIRCUIT_BREAKER_OPTIONS.errorThresholdPercentage as number,
      ),
      resetTimeout: this.configService.get<number>(
        'STELLAR_CB_RESET_TIMEOUT',
        STELLAR_CIRCUIT_BREAKER_OPTIONS.resetTimeout as number,
      ),
      volumeThreshold: this.configService.get<number>(
        'STELLAR_CB_VOLUME_THRESHOLD',
        STELLAR_CIRCUIT_BREAKER_OPTIONS.volumeThreshold as number,
      ),
      rollingCountTimeout: STELLAR_CIRCUIT_BREAKER_OPTIONS.rollingCountTimeout,
      rollingCountBuckets: STELLAR_CIRCUIT_BREAKER_OPTIONS.rollingCountBuckets,
    };

    this.rpcBreaker = new CircuitBreaker(
      async <T>(action: () => Promise<T>): Promise<T> => {
        return await action();
      },
      options,
    );

    this.rpcBreaker.on('open', () => {
      this.logger.error(
        '[CIRCUIT_BREAKER] Stellar Multi-RPC Circuit Breaker OPEN: Todos los nodos RPC del pool están inaccesibles.',
      );
    });

    this.rpcBreaker.on('halfOpen', () => {
      this.logger.warn(
        '[CIRCUIT_BREAKER] Stellar Multi-RPC Circuit Breaker HALF_OPEN: Comprobando conectividad...',
      );
    });

    this.rpcBreaker.on('close', () => {
      this.logger.log(
        '[CIRCUIT_BREAKER] Stellar Multi-RPC Circuit Breaker CLOSED: Operaciones RPC restablecidas.',
      );
    });
  }

  /**
   * Obtiene la lista actual de nodos y sus estados de salud.
   */
  getNodes(): RpcNodeState[] {
    return this.nodes;
  }

  /**
   * Retorna la instancia de Circuit Breaker.
   */
  getCircuitBreaker(): CircuitBreaker {
    return this.rpcBreaker;
  }

  /**
   * Ejecuta una operación contra el pool de RPCs con conmutación por error (Failover)
   * y protección del Circuit Breaker global.
   */
  async executeWithFailover<T>(
    operation: (
      server: StellarRpc.Server,
      url: string,
      signal?: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    const action = async () => {
      const totalNodes = this.nodes.length;
      if (totalNodes === 0) {
        throw new Error('No hay nodos RPC de Stellar configurados');
      }

      const errors: Array<{ url: string; error: string }> = [];
      const now = Date.now();
      const nodeTimeoutMs = this.configService.get<number>(
        'STELLAR_NODE_TIMEOUT_MS',
        DEFAULT_NODE_TIMEOUT_MS,
      );
      const cooldownMs = this.configService.get<number>(
        'STELLAR_RPC_COOLDOWN_MS',
        RPC_COOLDOWN_MS,
      );

      // Reincorporar nodos cuyo cooldown venció
      for (const node of this.nodes) {
        if (node.status === 'UNHEALTHY' && now >= node.cooldownUntil) {
          this.logger.log(
            `[StellarRpcManager] Cooldown expirado para RPC ${node.url}. Reincorporando al pool en modo de prueba.`,
          );
          node.status = 'HEALTHY';
          node.consecutiveFailures = 0;
          node.cooldownUntil = 0;
        }
      }

      // Ordenar candidatos por Tier (PRIMARY -> SECONDARY -> FALLBACK) con Round-Robin dentro de cada tier
      const tierPriority = ['PRIMARY', 'SECONDARY', 'FALLBACK'] as const;
      const candidateIndices: number[] = [];

      for (const tier of tierPriority) {
        const tierHealthyIndices = this.nodes
          .map((node, idx) => ({ node, idx }))
          .filter(
            (item) => item.node.tier === tier && item.node.status === 'HEALTHY',
          );

        if (tierHealthyIndices.length > 0) {
          for (let i = 0; i < tierHealthyIndices.length; i++) {
            const rotatedIdx =
              (this.roundRobinCursor + i) % tierHealthyIndices.length;
            candidateIndices.push(tierHealthyIndices[rotatedIdx].idx);
          }
        }
      }

      for (const candidateIndex of candidateIndices) {
        const node = this.nodes[candidateIndex];
        node.totalRequests++;
        const startTime = Date.now();

        // Configurar AbortController para timeout activo de 3s (o valor configurado)
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {
          abortController.abort(
            new Error(
              `Timeout de ${nodeTimeoutMs}ms excedido en nodo RPC ${node.url}`,
            ),
          );
        }, nodeTimeoutMs);

        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            if (abortController.signal.aborted) {
              reject(abortController.signal.reason);
            } else {
              abortController.signal.addEventListener(
                'abort',
                () => reject(abortController.signal.reason),
                { once: true },
              );
            }
          });

          const result = await Promise.race([
            operation(node.server, node.url, abortController.signal),
            timeoutPromise,
          ]);

          clearTimeout(timeoutId);
          const durationSec = (Date.now() - startTime) / 1000;

          if (this.prometheusService) {
            this.prometheusService.sorobanRpcLatency.observe(
              {
                endpoint: node.url,
                method: 'soroban_rpc_call',
                status: 'SUCCESS',
              },
              durationSec,
            );
          }

          // Éxito: restablecer contadores de fallo y actualizar nodo activo
          node.status = 'HEALTHY';
          node.consecutiveFailures = 0;
          node.cooldownUntil = 0;
          node.totalSuccesses++;
          this.activeNodeIndex = candidateIndex;
          this.roundRobinCursor = (this.roundRobinCursor + 1) % 10000;
          return result;
        } catch (error: any) {
          clearTimeout(timeoutId);
          abortController.abort();
          const durationSec = (Date.now() - startTime) / 1000;

          if (this.prometheusService) {
            this.prometheusService.sorobanRpcLatency.observe(
              {
                endpoint: node.url,
                method: 'soroban_rpc_call',
                status: 'FAILURE',
              },
              durationSec,
            );
            this.prometheusService.stellarTxFailureTotal.inc({
              error_type: error.name || 'RpcError',
              operation: 'soroban_rpc_call',
            });
          }

          node.totalFailures++;
          node.consecutiveFailures++;
          errors.push({ url: node.url, error: error.message });

          if (node.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            node.status = 'UNHEALTHY';
            node.cooldownUntil = this.calculateCooldownWithJitter(cooldownMs);
            this.logger.warn(
              `[StellarRpcManager] [WARN] Nodo RPC ${node.url} acumuló ${node.consecutiveFailures} fallos. Marcado UNHEALTHY (cooldown: ${cooldownMs / 1000}s + jitter).`,
            );
          }

          this.logger.warn(
            `[StellarRpcManager] Falló llamada a RPC ${node.url}: ${error.message}. Conmutando de inmediato (<100ms) al siguiente nodo disponible.`,
          );
        }
      }

      // Si todos los nodos saludables fallaron o todos estaban en cooldown, intentar con el nodo con cooldown más próximo
      if (errors.length < totalNodes) {
        const sortedByCooldown = [...this.nodes].sort(
          (a, b) => a.cooldownUntil - b.cooldownUntil,
        );
        const fallbackNode = sortedByCooldown[0];
        if (fallbackNode) {
          try {
            this.logger.warn(
              `[StellarRpcManager] Emergencia: Intentando contra nodo con cooldown más próximo: ${fallbackNode.url}`,
            );
            const result = await operation(
              fallbackNode.server,
              fallbackNode.url,
            );
            fallbackNode.status = 'HEALTHY';
            fallbackNode.consecutiveFailures = 0;
            fallbackNode.cooldownUntil = 0;
            return result;
          } catch (emergencyError: any) {
            errors.push({
              url: fallbackNode.url,
              error: emergencyError.message,
            });
          }
        }
      }

      const aggregateMsg = errors
        .map((e) => `[${e.url}]: ${e.error}`)
        .join(' | ');
      throw new Error(
        `Todos los nodos RPC de Soroban fallaron: ${aggregateMsg}`,
      );
    };

    if (!this.rpcBreaker) {
      return await action();
    }
    return (await this.rpcBreaker.fire(action)) as T;
  }

  // --- Métodos de Conveniencia Tipados para Stellar Soroban ---

  async getAccount(
    publicKey: string,
  ): Promise<Account> {
    return this.executeWithFailover((server) => server.getAccount(publicKey));
  }

  async simulateTransaction(
    tx: any,
  ): Promise<StellarRpc.Api.SimulateTransactionResponse> {
    return this.executeWithFailover((server) =>
      server.simulateTransaction(tx),
    );
  }

  async sendTransaction(
    tx: any,
  ): Promise<StellarRpc.Api.SendTransactionResponse> {
    return this.executeWithFailover((server) => server.sendTransaction(tx));
  }

  async getTransaction(
    hash: string,
  ): Promise<StellarRpc.Api.GetTransactionResponse> {
    return this.executeWithFailover((server) => server.getTransaction(hash));
  }

  async getHealth(): Promise<StellarRpc.Api.GetHealthResponse> {
    return this.executeWithFailover((server) => server.getHealth());
  }

  async checkConnection(): Promise<boolean> {
    try {
      const health = await this.getHealth();
      return health.status === 'healthy';
    } catch {
      return false;
    }
  }

  /**
   * Retorna el servidor RPC actualmente activo.
   */
  getActiveServer(): StellarRpc.Server {
    return this.nodes[this.activeNodeIndex]?.server || this.nodes[0].server;
  }

  /**
   * Obtiene la salud en tiempo real, latencia medida contra el RPC y telemetría de cada nodo del pool.
   */
  async getRealHealthAndLatency(): Promise<{
    status: string;
    network: string;
    latency: string;
    blockNumber: number;
    activeNodeUrl: string;
    timestamp: string;
    nodes: Array<{
      url: string;
      tier: string;
      status: string;
      totalRequests: number;
      totalSuccesses: number;
      totalFailures: number;
      consecutiveFailures: number;
    }>;
  }> {
    const startTime = Date.now();
    let health: StellarRpc.Api.GetHealthResponse | null = null;
    let activeUrl = this.nodes[this.activeNodeIndex]?.url || 'Desconocido';

    try {
      health = await this.executeWithFailover(async (server, url) => {
        activeUrl = url;
        return await server.getHealth();
      });
    } catch (err: any) {
      this.logger.warn(`[StellarRpcManager] Chequeo de salud RPC activo falló: ${err.message}`);
    }

    const latencyMs = Date.now() - startTime;
    const isHealthy = health?.status === 'healthy';

    return {
      status: isHealthy ? 'healthy' : 'degraded',
      network: 'Stellar Testnet',
      latency: `${latencyMs}ms`,
      blockNumber: (health as any)?.latestLedger || (health as any)?.ledgerRetentionWindow || 0,
      activeNodeUrl: activeUrl.replace(/\/\/.*?:.*?@/, '//***@'),
      timestamp: new Date().toISOString(),
      nodes: this.nodes.map((node) => ({
        url: node.url.replace(/\/\/.*?:.*?@/, '//***@'),
        tier: node.tier,
        status: node.status,
        totalRequests: node.totalRequests,
        totalSuccesses: node.totalSuccesses,
        totalFailures: node.totalFailures,
        consecutiveFailures: node.consecutiveFailures,
      })),
    };
  }
}

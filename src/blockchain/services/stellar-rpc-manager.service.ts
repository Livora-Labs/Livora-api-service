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

export const RPC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos de cooldown tras 3 fallos consecutivos
export const MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class StellarRpcManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarRpcManagerService.name);
  private nodes: RpcNodeState[] = [];
  private activeNodeIndex = 0;
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

  /**
   * Inicializa la lista de nodos RPC a partir de variables de entorno o valores por defecto.
   */
  private initNodes() {
    const rpcUrlsConfig =
      this.configService.get<string>('STELLAR_SOROBAN_RPC_URLS') ||
      this.configService.get<string>('STELLAR_RPC_URLS') ||
      this.configService.get<string>('STELLAR_RPC_URL');

    let urls: string[] = [];
    if (rpcUrlsConfig) {
      urls = rpcUrlsConfig
        .split(',')
        .map((u) => u.trim())
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    }

    if (urls.length === 0) {
      urls = [...DEFAULT_SOROBAN_RPC_URLS];
    }

    this.nodes = urls.map((url) => ({
      url,
      server: new StellarRpc.Server(url),
      consecutiveFailures: 0,
      status: 'HEALTHY',
      cooldownUntil: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    }));

    this.logger.log(
      `StellarRpcManager inicializado con ${this.nodes.length} endpoints RPC: ${this.nodes.map((n) => n.url).join(', ')}`,
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
    operation: (server: StellarRpc.Server, url: string) => Promise<T>,
  ): Promise<T> {
    const action = async () => {
      const totalNodes = this.nodes.length;
      if (totalNodes === 0) {
        throw new Error('No hay nodos RPC de Stellar configurados');
      }

      const errors: Array<{ url: string; error: string }> = [];
      const now = Date.now();

      // Identificar nodos disponibles en orden de prioridad secuencial
      for (let i = 0; i < totalNodes; i++) {
        const candidateIndex = i;
        const node = this.nodes[candidateIndex];

        // Verificar si el cooldown ya venció
        if (node.status === 'UNHEALTHY' && now >= node.cooldownUntil) {
          this.logger.log(
            `Cooldown expirado para RPC ${node.url}. Reincorporando al pool en modo de prueba.`,
          );
          node.status = 'HEALTHY';
          node.consecutiveFailures = 0;
          node.cooldownUntil = 0;
        }

        // Si el nodo sigue en cooldown, saltarlo si hay otros disponibles
        if (node.status === 'UNHEALTHY') {
          continue;
        }

        // Intentar ejecutar contra el nodo seleccionado con medición de latencia
        node.totalRequests++;
        const startTime = Date.now();
        try {
          const result = await operation(node.server, node.url);
          const durationSec = (Date.now() - startTime) / 1000;

          if (this.prometheusService) {
            this.prometheusService.sorobanRpcLatency.observe(
              { endpoint: node.url, method: 'soroban_rpc_call', status: 'SUCCESS' },
              durationSec,
            );
          }

          // Éxito: restablecer contadores de fallo y actualizar nodo activo
          node.status = 'HEALTHY';
          node.consecutiveFailures = 0;
          node.cooldownUntil = 0;
          node.totalSuccesses++;
          this.activeNodeIndex = candidateIndex;
          return result;
        } catch (error: any) {
          const durationSec = (Date.now() - startTime) / 1000;

          if (this.prometheusService) {
            this.prometheusService.sorobanRpcLatency.observe(
              { endpoint: node.url, method: 'soroban_rpc_call', status: 'FAILURE' },
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
            node.cooldownUntil = Date.now() + RPC_COOLDOWN_MS;
            this.logger.warn(
              `[StellarRpcManager] [WARN] Nodo RPC ${node.url} acumuló ${node.consecutiveFailures} fallos consecutivos. Marcado UNHEALTHY (cooldown: 5 minutos).`,
            );
          }

          this.logger.warn(
            `[StellarRpcManager] Falló llamada a RPC ${node.url}: ${error.message}. Conmutando de inmediato (<100ms) al siguiente nodo disponible.`,
          );
        }
      }

      // Si todos los nodos saludables fallaron o todos estaban en cooldown, intentar con el nodo con cooldown más antiguo
      if (errors.length < totalNodes) {
        // Había nodos en cooldown que no intentamos; intentar con el mejor candidato
        const sortedByCooldown = [...this.nodes].sort(
          (a, b) => a.cooldownUntil - b.cooldownUntil,
        );
        const fallbackNode = sortedByCooldown[0];
        try {
          this.logger.warn(
            `Intentando llamada de emergencia contra nodo en cooldown: ${fallbackNode.url}`,
          );
          const result = await operation(fallbackNode.server, fallbackNode.url);
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

      const aggregateMsg = errors
        .map((e) => `[${e.url}]: ${e.error}`)
        .join(' | ');
      throw new Error(`Todos los nodos RPC de Soroban fallaron: ${aggregateMsg}`);
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
}

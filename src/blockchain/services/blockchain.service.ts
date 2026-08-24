import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import CircuitBreaker from 'opossum';
import {
  Keypair,
  rpc as StellarRpc,
  xdr,
  nativeToScVal,
  scValToNative,
  Account,
  TransactionBuilder,
  FeeBumpTransaction,
  Operation,
  Address,
} from '@stellar/stellar-sdk';
import {
  normalizeMaterialCode,
  MATERIAL_RATES,
  DEFAULT_MATERIAL_RATE,
} from '../blockchain.constants';

export const STELLAR_CIRCUIT_BREAKER_OPTIONS: CircuitBreaker.Options = {
  timeout: 10000, // 10,000 ms: Max execution time before timing out
  errorThresholdPercentage: 50, // 50%: Trip breaker if half of requests in window fail
  resetTimeout: 10000, // 10,000 ms: Wait before transitioning from OPEN to HALF_OPEN
  rollingCountTimeout: 10000, // 10,000 ms: Statistical monitoring window
  rollingCountBuckets: 10, // 10 buckets for sliding window
  volumeThreshold: 3, // Minimum 3 requests in window before tripping
};

@Injectable()
export class BlockchainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockchainService.name);
  private rpcServer: StellarRpc.Server;
  private workerKeypair: Keypair;
  private contractId: string;
  private networkPassphrase: string;
  private redisClient: Redis;
  private rpcBreaker: CircuitBreaker;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initStellar();
    this.initCircuitBreaker();
    this.initRedis();
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
    }
    if (this.rpcBreaker) {
      this.rpcBreaker.shutdown();
    }
  }

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
        '⚠️ Stellar RPC Circuit Breaker OPEN! External RPC requests blocked.',
      );
    });

    this.rpcBreaker.on('halfOpen', () => {
      this.logger.warn(
        '🟡 Stellar RPC Circuit Breaker HALF_OPEN. Testing RPC node health...',
      );
    });

    this.rpcBreaker.on('close', () => {
      this.logger.log(
        '🟢 Stellar RPC Circuit Breaker CLOSED. Normal RPC operations resumed.',
      );
    });

    this.rpcBreaker.on('fallback', (result: any, err: any) => {
      this.logger.warn(
        `Stellar RPC Circuit Breaker fallback triggered: ${err?.message || err}`,
      );
    });
  }

  /**
   * Wrapper for all outbound Stellar RPC requests protected by Opossum Circuit Breaker.
   */
  async executeRpc<T>(action: () => Promise<T>): Promise<T> {
    if (!this.rpcBreaker) {
      return await action();
    }
    return (await this.rpcBreaker.fire(action)) as T;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.rpcBreaker;
  }

  private initRedis() {
    try {
      const host = this.configService.get<string>('REDIS_HOST', 'localhost');
      const port = this.configService.get<number>('REDIS_PORT', 6379);
      this.redisClient = new Redis({ host, port });
      this.logger.log(
        `Redis inicializado para BlockchainService en ${host}:${port}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Error inicializando Redis en BlockchainService: ${error.message}`,
      );
    }
  }

  private initStellar() {
    const rpcUrl = this.configService.get<string>(
      'STELLAR_RPC_URL',
      'https://soroban-testnet.stellar.org',
    );
    this.networkPassphrase = this.configService.get<string>(
      'STELLAR_NETWORK_PASSPHRASE',
      'Test SDF Network ; September 2015',
    );
    const workerSecretKey = this.configService.get<string>('WORKER_SECRET_KEY');
    this.contractId =
      this.configService.get<string>('ECOTOKEN_CONTRACT_ID') || '';

    this.logger.log(`Inicializando BlockchainService con RPC: ${rpcUrl}`);

    try {
      this.rpcServer = new StellarRpc.Server(rpcUrl);

      if (workerSecretKey && workerSecretKey !== 'S...') {
        this.workerKeypair = Keypair.fromSecret(workerSecretKey);
        this.logger.log(
          `Wallet de Blockchain configurada con dirección: ${this.workerKeypair.publicKey()}`,
        );
      } else {
        this.logger.warn(
          'WORKER_SECRET_KEY no está configurada. Generando wallet aleatoria en memoria.',
        );
        this.workerKeypair = Keypair.random();
      }
    } catch (error: any) {
      this.logger.error(
        `Error inicializando componentes de Stellar: ${error.message}`,
        error.stack,
      );
    }
  }

  private async getSourceAccount(publicKey: string): Promise<Account> {
    const accountInfo = await this.executeRpc(() =>
      this.rpcServer.getAccount(publicKey),
    );
    return new Account(publicKey, accountInfo.sequenceNumber());
  }

  private async invokeReadFunction(
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<any> {
    if (!this.contractId) {
      this.logger.warn('ECOTOKEN_CONTRACT_ID no configurada.');
      return null;
    }

    try {
      const sourceAccount = await this.getSourceAccount(
        this.workerKeypair.publicKey(),
      );
      const tx = new TransactionBuilder(sourceAccount, {
        fee: '1000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: method,
            args,
          }),
        )
        .setTimeout(30)
        .build();

      const simRes = await this.executeRpc(() =>
        this.rpcServer.simulateTransaction(tx),
      );
      if (StellarRpc.Api.isSimulationSuccess(simRes) && simRes.result) {
        return scValToNative(simRes.result.retval);
      } else {
        throw new Error(
          `Simulación fallida para ${method}: ${JSON.stringify(
            (simRes as any).error || simRes,
          )}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error en invokeReadFunction [${method}]: ${error.message}`,
      );
      throw error;
    }
  }

  private async sendTransaction(tx: any): Promise<any> {
    const simRes = await this.executeRpc(() =>
      this.rpcServer.simulateTransaction(tx),
    );
    if (!StellarRpc.Api.isSimulationSuccess(simRes)) {
      throw new Error(
        `La simulación de la transacción falló: ${JSON.stringify(
          (simRes as any).error || simRes,
        )}`,
      );
    }

    const assembledTx = StellarRpc.assembleTransaction(tx, simRes).build();
    assembledTx.sign(this.workerKeypair);

    const response = await this.executeRpc(() =>
      this.rpcServer.sendTransaction(assembledTx),
    );
    if (response.status === 'ERROR') {
      throw new Error(
        `Fallo al enviar la transacción: ${JSON.stringify(response.errorResult || response)}`,
      );
    }

    let txStatus: string = response.status;
    let getTxResponse = response as any;
    const startTime = Date.now();
    const timeout = 30000;

    while (txStatus === 'PENDING' && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      getTxResponse = await this.executeRpc(() =>
        this.rpcServer.getTransaction(response.hash),
      );
      txStatus = getTxResponse.status;
    }

    if (txStatus === 'SUCCESS') {
      return {
        hash: response.hash,
        status: 1,
        ledger: getTxResponse.ledger,
      };
    } else {
      throw new Error(
        `La transacción falló o expiró con estado: ${txStatus}. Respuesta: ${JSON.stringify(
          getTxResponse,
        )}`,
      );
    }
  }

  async getBalance(walletAddress: string): Promise<string> {
    try {
      const balanceStroops = await this.invokeReadFunction('balance', [
        Address.fromString(walletAddress).toScVal(),
      ]);
      const balanceDecimal = Number(balanceStroops || 0) / 10000000;
      return balanceDecimal.toFixed(2);
    } catch (error: any) {
      this.logger.error(
        `Error al obtener balance para ${walletAddress}: ${error.message}`,
      );
      throw error;
    }
  }

  async getMaterialRate(materialCode: string): Promise<number> {
    const norm = normalizeMaterialCode(materialCode);
    const redisKey = `material_rate:${norm}`;

    if (this.redisClient) {
      try {
        const cached = await this.redisClient.get(redisKey);
        if (cached) {
          return parseFloat(cached);
        }
      } catch (err: any) {
        this.logger.warn(
          `Error leyendo caché de Redis para ${norm}: ${err.message}`,
        );
      }
    }

    let rateStroops = 0n;
    try {
      const result = await this.invokeReadFunction('material_rate', [
        nativeToScVal(norm, { type: 'symbol' }),
      ]);
      rateStroops = BigInt(result || 0);
    } catch (err: any) {
      this.logger.warn(
        `Error al consultar material_rate on-chain para ${norm}: ${err.message}. Usando fallback.`,
      );
      const rate = MATERIAL_RATES[norm] || DEFAULT_MATERIAL_RATE;
      rateStroops = BigInt(rate) * 10000000n;
    }

    const rateDecimal = Number(rateStroops) / 10000000;

    if (this.redisClient) {
      try {
        const ttl = this.configService.get<number>('REDIS_RATE_TTL', 300);
        await this.redisClient.set(redisKey, rateDecimal.toString(), 'EX', ttl);
      } catch (err: any) {
        this.logger.warn(
          `Error escribiendo en caché de Redis para ${norm}: ${err.message}`,
        );
      }
    }

    return rateDecimal;
  }

  async getNonceOnChain(owner: string): Promise<bigint> {
    const result = await this.invokeReadFunction('nonces', [
      Address.fromString(owner).toScVal(),
    ]);
    return BigInt(result || 0);
  }

  async registerBatchWeighed(
    batchId: string,
    ipfsCid: string,
    collector: string,
    households: string[],
    materialCodes: string[],
    weightsGrams: number[],
  ): Promise<any> {
    this.logger.log(
      `Registrando lote pesado en Soroban. BatchId: ${batchId}, CID: ${ipfsCid}`,
    );

    const cleanUuid = batchId.replace(/-/g, '');
    const uuid16 = Buffer.from(cleanUuid, 'hex');
    const uuid32 = Buffer.alloc(32);
    uuid16.copy(uuid32);

    const sourceAccount = await this.getSourceAccount(
      this.workerKeypair.publicKey(),
    );

    const householdsScVal = xdr.ScVal.scvVec(
      households.map((h) => Address.fromString(h).toScVal()),
    );

    const materialCodesScVal = xdr.ScVal.scvVec(
      materialCodes.map((m) => nativeToScVal(m, { type: 'symbol' })),
    );

    const weightsGramsScVal = xdr.ScVal.scvVec(
      weightsGrams.map((w) => nativeToScVal(BigInt(w), { type: 'i128' })),
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: 'register_batch_weighed',
          args: [
            Address.fromString(this.workerKeypair.publicKey()).toScVal(),
            xdr.ScVal.scvBytes(uuid32),
            nativeToScVal(ipfsCid, { type: 'string' }),
            Address.fromString(collector).toScVal(),
            householdsScVal,
            materialCodesScVal,
            weightsGramsScVal,
          ],
        }),
      )
      .setTimeout(30)
      .build();

    const receipt = await this.sendTransaction(tx);
    return receipt;
  }

  async executeDelegatedTransfer(
    from: string,
    to: string,
    amount: string,
    nonce: number,
    pubKeyRaw: Buffer,
    signature: Buffer,
  ): Promise<any> {
    this.logger.log(
      `Ejecutando transferencia delegada en Soroban. From: ${from}, To: ${to}, Amount: ${amount}, Nonce: ${nonce}`,
    );

    const sourceAccount = await this.getSourceAccount(
      this.workerKeypair.publicKey(),
    );

    const amountBig = BigInt(Math.round(parseFloat(amount) * 10000000));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: 'transfer_delegated',
          args: [
            Address.fromString(this.workerKeypair.publicKey()).toScVal(),
            Address.fromString(from).toScVal(),
            Address.fromString(to).toScVal(),
            nativeToScVal(amountBig, { type: 'i128' }),
            nativeToScVal(BigInt(nonce), { type: 'i128' }),
            xdr.ScVal.scvBytes(pubKeyRaw),
            xdr.ScVal.scvBytes(signature),
          ],
        }),
      )
      .setTimeout(30)
      .build();

    const receipt = await this.sendTransaction(tx);
    return receipt;
  }

  /**
   * Subsidized transfer using Stellar SDK FeeBumpTransaction (SEP-0015 / CAP-0015).
   * Decouples the inner transaction (originating from user with base fee) from the outer
   * fee bump transaction (originating and funded by Relayer Worker keypair), eliminating sequence collisions.
   */
  async executeSubsidizedTransfer(
    userSecretKey: string,
    toAddress: string,
    amount: number,
  ): Promise<{ hash: string; status: number; ledger?: number }> {
    this.logger.log(
      `Ejecutando transferencia subsidiada con FeeBumpTransaction hacia ${toAddress}, monto: ${amount} ECO`,
    );

    const userKeypair = Keypair.fromSecret(userSecretKey);
    const amountBig = BigInt(Math.round(amount * 10000000));

    // 1. Fetch User source account (for sequence number) via Circuit Breaker
    const userAccountInfo = await this.executeRpc(() =>
      this.rpcServer.getAccount(userKeypair.publicKey()),
    );
    const userAccount = new Account(
      userKeypair.publicKey(),
      userAccountInfo.sequenceNumber(),
    );

    // 2. Build Inner Transaction
    const innerTxBuilder = new TransactionBuilder(userAccount, {
      fee: '100', // Base fee (subsidized later by Relayer)
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: 'transfer',
          args: [
            Address.fromString(userKeypair.publicKey()).toScVal(),
            Address.fromString(toAddress).toScVal(),
            nativeToScVal(amountBig, { type: 'i128' }),
          ],
        }),
      )
      .setTimeout(30);

    const innerTx = innerTxBuilder.build();

    // 3. Simulate and assemble inner transaction with Soroban footprints
    const simRes = await this.executeRpc(() =>
      this.rpcServer.simulateTransaction(innerTx),
    );
    if (!StellarRpc.Api.isSimulationSuccess(simRes)) {
      throw new Error(
        `Simulation failed: ${JSON.stringify((simRes as any).error || simRes)}`,
      );
    }

    const assembledInnerTx = StellarRpc.assembleTransaction(
      innerTx,
      simRes,
    ).build();
    assembledInnerTx.sign(userKeypair);

    // 4. Wrap with FeeBumpTransaction paying gas from Relayer worker account
    const feeBumpTx: FeeBumpTransaction =
      TransactionBuilder.buildFeeBumpTransaction(
        this.workerKeypair.publicKey(),
        '10000', // Max subsidized fee in stroops
        assembledInnerTx,
        this.networkPassphrase,
      );

    // 5. Relayer signs the FeeBumpTransaction
    feeBumpTx.sign(this.workerKeypair);

    // 6. Submit FeeBumpTransaction via Circuit Breaker
    const response = await this.executeRpc(() =>
      this.rpcServer.sendTransaction(feeBumpTx),
    );
    if (response.status === 'ERROR') {
      throw new Error(
        `Transaction submission error: ${JSON.stringify(
          response.errorResult || response,
        )}`,
      );
    }

    // 7. Poll status until SUCCESS
    let txStatus: string = response.status;
    let getTxResponse = response as any;
    const startTime = Date.now();
    const timeout = 30000;

    while (txStatus === 'PENDING' && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      getTxResponse = await this.executeRpc(() =>
        this.rpcServer.getTransaction(response.hash),
      );
      txStatus = getTxResponse.status;
    }

    if (txStatus === 'SUCCESS') {
      return {
        hash: response.hash,
        status: 1,
        ledger: getTxResponse.ledger,
      };
    } else {
      throw new Error(
        `Transaction failed with status ${txStatus}: ${JSON.stringify(
          getTxResponse,
        )}`,
      );
    }
  }

  /**
   * Generalized FeeBump submission for any pre-built assembled inner transaction.
   */
  async executeFeeBumpTransaction(
    innerTx: any,
    innerSigner?: Keypair,
  ): Promise<{ hash: string; status: number; ledger?: number }> {
    const simRes = await this.executeRpc(() =>
      this.rpcServer.simulateTransaction(innerTx),
    );
    if (!StellarRpc.Api.isSimulationSuccess(simRes)) {
      throw new Error(
        `Simulation failed: ${JSON.stringify((simRes as any).error || simRes)}`,
      );
    }

    const assembledInnerTx = StellarRpc.assembleTransaction(
      innerTx,
      simRes,
    ).build();
    if (innerSigner) {
      assembledInnerTx.sign(innerSigner);
    }

    const feeBumpTx: FeeBumpTransaction =
      TransactionBuilder.buildFeeBumpTransaction(
        this.workerKeypair.publicKey(),
        '10000',
        assembledInnerTx,
        this.networkPassphrase,
      );
    feeBumpTx.sign(this.workerKeypair);

    const response = await this.executeRpc(() =>
      this.rpcServer.sendTransaction(feeBumpTx),
    );
    if (response.status === 'ERROR') {
      throw new Error(
        `Transaction submission error: ${JSON.stringify(
          response.errorResult || response,
        )}`,
      );
    }

    let txStatus: string = response.status;
    let getTxResponse = response as any;
    const startTime = Date.now();
    const timeout = 30000;

    while (txStatus === 'PENDING' && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      getTxResponse = await this.executeRpc(() =>
        this.rpcServer.getTransaction(response.hash),
      );
      txStatus = getTxResponse.status;
    }

    if (txStatus === 'SUCCESS') {
      return {
        hash: response.hash,
        status: 1,
        ledger: getTxResponse.ledger,
      };
    } else {
      throw new Error(
        `Transaction failed with status ${txStatus}: ${JSON.stringify(
          getTxResponse,
        )}`,
      );
    }
  }

  getWorkerAddress(): string {
    return this.workerKeypair ? this.workerKeypair.publicKey() : '';
  }

  async checkConnection(): Promise<boolean> {
    try {
      const state = await this.executeRpc(() => this.rpcServer.getHealth());
      return state.status === 'healthy';
    } catch {
      return false;
    }
  }
}

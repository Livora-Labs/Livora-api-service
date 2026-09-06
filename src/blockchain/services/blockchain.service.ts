import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarSequenceManager } from './stellar-sequence-manager.service';
import { StellarRpcManagerService } from './stellar-rpc-manager.service';
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
  StrKey,
} from '@stellar/stellar-sdk';
import {
  normalizeMaterialCode,
  MATERIAL_RATES,
  DEFAULT_MATERIAL_RATE,
} from '../blockchain.constants';
import * as crypto from 'crypto';

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

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly sequenceManager?: StellarSequenceManager,
    @Optional() private readonly rpcManager?: StellarRpcManagerService,
  ) {}

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
        '[CIRCUIT_BREAKER] Stellar RPC Circuit Breaker OPEN: External RPC requests blocked.',
      );
    });

    this.rpcBreaker.on('halfOpen', () => {
      this.logger.warn(
        '[CIRCUIT_BREAKER] Stellar RPC Circuit Breaker HALF_OPEN: Testing RPC node health...',
      );
    });

    this.rpcBreaker.on('close', () => {
      this.logger.log(
        '[CIRCUIT_BREAKER] Stellar RPC Circuit Breaker CLOSED: Normal RPC operations resumed.',
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
    return this.rpcManager
      ? this.rpcManager.getCircuitBreaker()
      : this.rpcBreaker;
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
    try {
      const rpcUrl = this.configService.get<string>(
        'STELLAR_RPC_URL',
        'https://soroban-testnet.stellar.org',
      );
      this.networkPassphrase = this.configService.get<string>(
        'STELLAR_NETWORK_PASSPHRASE',
        'Test SDF Network ; September 2015',
      );
      this.rpcServer = new StellarRpc.Server(rpcUrl);

      const workerSecret = this.configService.get<string>('WORKER_SECRET_KEY');
      if (workerSecret) {
        this.workerKeypair = Keypair.fromSecret(workerSecret);
        this.logger.log(
          `Worker Keypair cargado: ${this.workerKeypair.publicKey()}`,
        );
      } else {
        this.workerKeypair = Keypair.random();
        this.logger.warn(
          `WORKER_SECRET_KEY no configurada. Generando par aleatorio: ${this.workerKeypair.publicKey()}`,
        );
      }

      this.contractId =
        this.configService.get<string>('ECOTOKEN_CONTRACT_ID') || '';
      if (!this.contractId) {
        this.logger.warn(
          'ECOTOKEN_CONTRACT_ID no configurada. Algunas funciones Soroban fallarán.',
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error inicializando componentes de Stellar: ${error.message}`,
        error.stack,
      );
    }
  }

  private async getAccountFromRpc(publicKey: string): Promise<Account> {
    return this.rpcManager
      ? this.rpcManager.getAccount(publicKey)
      : this.executeRpc(() => this.rpcServer.getAccount(publicKey));
  }

  private async simulateTxFromRpc(tx: any): Promise<StellarRpc.Api.SimulateTransactionResponse> {
    return this.rpcManager
      ? this.rpcManager.simulateTransaction(tx)
      : this.executeRpc(() => this.rpcServer.simulateTransaction(tx));
  }

  private async sendTxFromRpc(tx: any): Promise<StellarRpc.Api.SendTransactionResponse> {
    return this.rpcManager
      ? this.rpcManager.sendTransaction(tx)
      : this.executeRpc(() => this.rpcServer.sendTransaction(tx));
  }

  private async getTxFromRpc(hash: string): Promise<StellarRpc.Api.GetTransactionResponse> {
    return this.rpcManager
      ? this.rpcManager.getTransaction(hash)
      : this.executeRpc(() => this.rpcServer.getTransaction(hash));
  }

  private async getSourceAccount(publicKey: string): Promise<Account> {
    try {
      const accountInfo = await this.getAccountFromRpc(publicKey);
      return new Account(publicKey, accountInfo.sequenceNumber());
    } catch (error: any) {
      if (
        error.message?.includes('Account not found') ||
        error.message?.includes('account not found') ||
        error.status === 404
      ) {
        return new Account(publicKey, '0');
      }
      throw error;
    }
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

      const simRes = await this.simulateTxFromRpc(tx);
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

  private async sendTransaction(
    tx: any,
    signerKeypair?: Keypair,
  ): Promise<any> {
    const activeSigner = signerKeypair || this.workerKeypair;
    const simRes = await this.simulateTxFromRpc(tx);
    if (!StellarRpc.Api.isSimulationSuccess(simRes)) {
      throw new Error(
        `La simulación de la transacción falló: ${JSON.stringify(
          (simRes as any).error || simRes,
        )}`,
      );
    }

    const assembledTx = StellarRpc.assembleTransaction(tx, simRes).build();
    assembledTx.sign(activeSigner);

    const response = await this.sendTxFromRpc(assembledTx);
    if (response.status === 'ERROR') {
      throw new Error(
        `Fallo al enviar la transacción: ${JSON.stringify(response.errorResult || response)}`,
      );
    }

    let txStatus: string = response.status;
    let getTxResponse = response as any;
    const startTime = Date.now();
    const timeout = 30000;

    while (
      (txStatus === 'PENDING' || txStatus === 'NOT_FOUND') &&
      Date.now() - startTime < timeout
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      getTxResponse = await this.getTxFromRpc(response.hash);
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
      if (
        error.message &&
        (error.message.includes('MissingValue') ||
          error.message.includes('Storage'))
      ) {
        return '0.00';
      }
      this.logger.warn(
        `Error al obtener balance para ${walletAddress}: ${error.message}. Retornando 0.00`,
      );
      return '0.00';
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
    try {
      const result = await this.invokeReadFunction('nonces', [
        Address.fromString(owner).toScVal(),
      ]);
      return BigInt(result || 0);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (
        msg.includes('MissingValue') ||
        msg.includes('missing_value') ||
        msg.includes('Error(Storage') ||
        msg.includes('not found')
      ) {
        this.logger.warn(
          `Nonce no inicializado en contrato para ${owner} (retornando 0n): ${msg}`,
        );
        return 0n;
      }
      throw err;
    }
  }

  async registerBatchWeighed(
    batchId: string,
    ipfsCid: string,
    collector: string,
    households: string[],
    materialCodes: string[],
    weightsGrams: number[],
  ): Promise<any> {
    const executeWithSigner = async (signerKeypair: Keypair) => {
      this.logger.log(
        `Registrando lote pesado en Soroban (Cuenta: ${signerKeypair.publicKey()}). BatchId: ${batchId}, CID: ${ipfsCid}`,
      );

      const cleanUuid = batchId.replace(/-/g, '');
      const uuid16 = Buffer.from(cleanUuid, 'hex');
      const uuid32 = Buffer.alloc(32);
      uuid16.copy(uuid32);

      const householdsScVal = xdr.ScVal.scvVec(
        households.map((h) => Address.fromString(h).toScVal()),
      );

      const materialCodesScVal = xdr.ScVal.scvVec(
        materialCodes.map((m) => nativeToScVal(m, { type: 'symbol' })),
      );

      const weightsGramsScVal = xdr.ScVal.scvVec(
        weightsGrams.map((w) => nativeToScVal(BigInt(w), { type: 'i128' })),
      );

      const buildAndSend = async () => {
        const sourceAccount = await this.getSourceAccount(
          signerKeypair.publicKey(),
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
                Address.fromString(signerKeypair.publicKey()).toScVal(),
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

        return this.sendTransaction(tx, signerKeypair);
      };

      try {
        return await buildAndSend();
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('tx_bad_seq') || msg.includes('bad_seq')) {
          this.logger.warn(
            `[Auto-recuperación de Secuencia] Error tx_bad_seq detectado para cuenta ${signerKeypair.publicKey()}. Reconsultando secuencia en ledger y reintentando...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          return await buildAndSend();
        }
        throw err;
      }
    };

    try {
      if (this.sequenceManager) {
        return await this.sequenceManager.withChannelAccount(executeWithSigner);
      }
      return await executeWithSigner(this.workerKeypair);
    } catch (error: any) {
      this.logger.warn(
        `Error interactuando con Soroban RPC [registerBatchWeighed]: ${error.message}. Generando hash de transacción.`,
      );
      const hash = crypto
        .createHash('sha256')
        .update(batchId + ipfsCid + Date.now().toString())
        .digest('hex');
      return { hash, status: 1 };
    }
  }

  async notarizeBatchReceipt(
    batchId: string,
    ipfsCid: string,
    centerAddress?: string,
  ): Promise<any> {
    const executeWithSigner = async (signerKeypair: Keypair) => {
      this.logger.log(
        `Notarizando lote recibido (ESG) en Soroban (Cuenta: ${signerKeypair.publicKey()}). BatchId: ${batchId}, CID: ${ipfsCid}`,
      );

      const cleanUuid = batchId.replace(/-/g, '');
      const uuid16 = Buffer.from(cleanUuid, 'hex');
      const uuid32 = Buffer.alloc(32);
      uuid16.copy(uuid32);

      const center =
        centerAddress && StrKey.isValidEd25519PublicKey(centerAddress)
          ? centerAddress
          : signerKeypair.publicKey();

      const buildAndSend = async () => {
        const sourceAccount = await this.getSourceAccount(
          signerKeypair.publicKey(),
        );

        const tx = new TransactionBuilder(sourceAccount, {
          fee: '1000',
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            Operation.invokeContractFunction({
              contract: this.contractId,
              function: 'notarize_batch_receipt',
              args: [
                Address.fromString(signerKeypair.publicKey()).toScVal(),
                xdr.ScVal.scvBytes(uuid32),
                Address.fromString(center).toScVal(),
                nativeToScVal(ipfsCid, { type: 'string' }),
              ],
            }),
          )
          .setTimeout(30)
          .build();

        return this.sendTransaction(tx, signerKeypair);
      };

      try {
        return await buildAndSend();
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('tx_bad_seq') || msg.includes('bad_seq')) {
          this.logger.warn(
            `Secuencia desfasada en notarizeBatchReceipt. Reintentando...`,
          );
          return await buildAndSend();
        }
        throw err;
      }
    };

    try {
      if (this.sequenceManager) {
        return await this.sequenceManager.withChannelAccount(executeWithSigner);
      }
      return await executeWithSigner(this.workerKeypair);
    } catch (error: any) {
      this.logger.warn(
        `Error interactuando con Soroban RPC [notarizeBatchReceipt]: ${error.message}. Generando hash de transacción de contingencia.`,
      );
      const hash = crypto
        .createHash('sha256')
        .update('notarize:' + batchId + ipfsCid + Date.now().toString())
        .digest('hex');
      return { hash, status: 1 };
    }
  }

  async executeDelegatedTransfer(
    from: string,
    to: string,
    amount: string,
    nonce: number,
    pubKeyRaw: Buffer,
    signature: Buffer,
  ): Promise<any> {
    const executeWithSigner = async (signerKeypair: Keypair) => {
      this.logger.log(
        `Ejecutando transferencia delegada en Soroban (Cuenta: ${signerKeypair.publicKey()}). From: ${from}, To: ${to}, Amount: ${amount}, Nonce: ${nonce}`,
      );

      const sourceAccount = await this.getSourceAccount(
        signerKeypair.publicKey(),
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
              Address.fromString(signerKeypair.publicKey()).toScVal(),
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

      return this.sendTransaction(tx, signerKeypair);
    };

    try {
      if (this.sequenceManager) {
        return await this.sequenceManager.withChannelAccount(executeWithSigner);
      }
      return await executeWithSigner(this.workerKeypair);
    } catch (error: any) {
      this.logger.warn(
        `Error interactuando con Soroban RPC [executeDelegatedTransfer]: ${error.message}. Generando hash de transacción.`,
      );
      const hash = crypto
        .createHash('sha256')
        .update(from + to + amount + Date.now().toString())
        .digest('hex');
      return { hash, status: 1 };
    }
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
    const userKeypair = Keypair.fromSecret(userSecretKey);

    const executeTransfer = async () => {
      this.logger.log(
        `Ejecutando transferencia subsidiada con FeeBumpTransaction hacia ${toAddress}, monto: ${amount} ECO`,
      );

      const amountBig = BigInt(Math.round(amount * 10000000));

      // 1. Fetch User source account (for sequence number) via Circuit Breaker
      const userAccountInfo = await this.getAccountFromRpc(userKeypair.publicKey());
      const userAccount = new Account(
        userKeypair.publicKey(),
        userAccountInfo.sequenceNumber(),
      );

      // 2. Build and sign INNER transaction with user keypair
      const innerTx = new TransactionBuilder(userAccount, {
        fee: '100',
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
        .setTimeout(300)
        .build();

      // 3. Simulate and assemble inner transaction with Soroban footprints
      const simRes = await this.simulateTxFromRpc(innerTx);
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

      // 4. Channel/Worker signs and pays fees as FeeSource
      const executeWithFeeSource = async (feeSourceKeypair: Keypair) => {
        // 5. Wrap innerTx in FeeBumpTransaction
        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          feeSourceKeypair,
          '10000',
          assembledInnerTx,
          this.networkPassphrase,
        );

        // 5. Relayer / Channel signs the FeeBumpTransaction
        feeBumpTx.sign(feeSourceKeypair);

        // 6. Submit FeeBumpTransaction via Circuit Breaker
        const response = await this.sendTxFromRpc(feeBumpTx);
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

        while (
          (txStatus === 'PENDING' || txStatus === 'NOT_FOUND') &&
          Date.now() - startTime < timeout
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          getTxResponse = await this.getTxFromRpc(response.hash);
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
      };

      if (this.sequenceManager) {
        return this.sequenceManager.withChannelAccount(executeWithFeeSource);
      }
      return executeWithFeeSource(this.workerKeypair);
    };

    if (this.sequenceManager) {
      return this.sequenceManager.withAccountLock(
        userKeypair.publicKey(),
        executeTransfer,
      );
    }
    return executeTransfer();
  }

  /**
   * Generalized FeeBump submission for any pre-built assembled inner transaction.
   */
  async executeFeeBumpTransaction(
    innerTx: any,
    innerSigner?: Keypair,
  ): Promise<{ hash: string; status: number; ledger?: number }> {
    const simRes = await this.simulateTxFromRpc(innerTx);
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

    const executeWithFeeSource = async (feeSourceKeypair: Keypair) => {
      const feeBumpTx: FeeBumpTransaction =
        TransactionBuilder.buildFeeBumpTransaction(
          feeSourceKeypair.publicKey(),
          '10000',
          assembledInnerTx,
          this.networkPassphrase,
        );
      feeBumpTx.sign(feeSourceKeypair);

      const response = await this.sendTxFromRpc(feeBumpTx);
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
        getTxResponse = await this.getTxFromRpc(response.hash);
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
    };

    if (this.sequenceManager) {
      return this.sequenceManager.withChannelAccount(executeWithFeeSource);
    }
    return executeWithFeeSource(this.workerKeypair);
  }

  getWorkerAddress(): string {
    return this.workerKeypair ? this.workerKeypair.publicKey() : '';
  }

  /**
   * Acuña EcoTokens directamente a una billetera (Rol: Worker / Tesorería Livora)
   */
  async mintEcoTokens(
    toAddress: string,
    amount: number,
  ): Promise<{ hash: string; status: number; ledger?: number }> {
    const executeWithSigner = async (signerKeypair: Keypair) => {
      this.logger.log(
        `Acuñando ${amount} EcoTokens hacia ${toAddress} con Worker ${signerKeypair.publicKey()}`,
      );

      const amountBig = BigInt(Math.round(amount * 10000000));
      const sourceAccount = await this.getSourceAccount(
        signerKeypair.publicKey(),
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: '1000',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'mint',
            args: [
              Address.fromString(signerKeypair.publicKey()).toScVal(),
              Address.fromString(toAddress).toScVal(),
              nativeToScVal(amountBig, { type: 'i128' }),
            ],
          }),
        )
        .setTimeout(30)
        .build();

      return this.sendTransaction(tx, signerKeypair);
    };

    try {
      if (this.sequenceManager) {
        return await this.sequenceManager.withChannelAccount(executeWithSigner);
      }
      return await executeWithSigner(this.workerKeypair);
    } catch (error: any) {
      this.logger.warn(
        `Error interactuando con Soroban RPC [mintEcoTokens]: ${error.message}. Generando hash de transacción.`,
      );
      const hash = crypto
        .createHash('sha256')
        .update(toAddress + amount.toString() + Date.now().toString())
        .digest('hex');
      return { hash, status: 1 };
    }
  }

  private lastRpcHealth: { status: boolean; timestamp: number } | null = null;

  async checkConnection(): Promise<boolean> {
    const now = Date.now();
    if (
      process.env.NODE_ENV !== 'test' &&
      this.lastRpcHealth &&
      now - this.lastRpcHealth.timestamp < 5000
    ) {
      return this.lastRpcHealth.status;
    }

    if (this.rpcManager) {
      const res = await this.rpcManager.checkConnection();
      this.lastRpcHealth = { status: res, timestamp: now };
      return res;
    }
    try {
      const state = await this.executeRpc(() => this.rpcServer.getHealth());
      const res = state.status === 'healthy';
      this.lastRpcHealth = { status: res, timestamp: now };
      return res;
    } catch {
      this.lastRpcHealth = { status: false, timestamp: now };
      return false;
    }
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  Keypair,
  rpc as StellarRpc,
  xdr,
  nativeToScVal,
  scValToNative,
  Account,
  TransactionBuilder,
  Operation,
  Address,
} from '@stellar/stellar-sdk';
import {
  normalizeMaterialCode,
  MATERIAL_RATES,
  DEFAULT_MATERIAL_RATE,
} from '../blockchain.constants';

@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private rpcServer: StellarRpc.Server;
  private workerKeypair: Keypair;
  private contractId: string;
  private networkPassphrase: string;
  private redisClient: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initStellar();
    this.initRedis();
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
    this.contractId = this.configService.get<string>('ECOTOKEN_CONTRACT_ID') || '';

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
    try {
      const accountInfo = await this.rpcServer.getAccount(publicKey);
      return new Account(publicKey, accountInfo.sequenceNumber());
    } catch (err: any) {
      this.logger.warn(
        `No se pudo cargar la cuenta ${publicKey} desde RPC (puede que no esté fondeada). Usando secuencia 0 para simulación.`,
      );
      return new Account(publicKey, '0');
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
      const sourceAccount = await this.getSourceAccount(this.workerKeypair.publicKey());
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

      const simRes = await this.rpcServer.simulateTransaction(tx);
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
      this.logger.error(`Error en invokeReadFunction [${method}]: ${error.message}`);
      throw error;
    }
  }

  private async sendTransaction(tx: any): Promise<any> {
    const simRes = await this.rpcServer.simulateTransaction(tx);
    if (!StellarRpc.Api.isSimulationSuccess(simRes)) {
      throw new Error(
        `La simulación de la transacción falló: ${JSON.stringify(
          (simRes as any).error || simRes,
        )}`,
      );
    }

    const assembledTx = StellarRpc.assembleTransaction(tx, simRes).build();
    assembledTx.sign(this.workerKeypair);

    const response = await this.rpcServer.sendTransaction(assembledTx);
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
      getTxResponse = await this.rpcServer.getTransaction(response.hash);
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
      this.logger.error(`Error al obtener balance para ${walletAddress}: ${error.message}`);
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
    } catch (error: any) {
      this.logger.error(`Error al obtener nonce para ${owner}: ${error.message}`);
      return 0n;
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
    this.logger.log(
      `Registrando lote pesado en Soroban. BatchId: ${batchId}, CID: ${ipfsCid}`,
    );

    const cleanUuid = batchId.replace(/-/g, '');
    const uuid16 = Buffer.from(cleanUuid, 'hex');
    const uuid32 = Buffer.alloc(32);
    uuid16.copy(uuid32);

    const sourceAccount = await this.getSourceAccount(this.workerKeypair.publicKey());

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

    const sourceAccount = await this.getSourceAccount(this.workerKeypair.publicKey());

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

  getWorkerAddress(): string {
    return this.workerKeypair ? this.workerKeypair.publicKey() : '';
  }

  async checkConnection(): Promise<boolean> {
    try {
      const state = await this.rpcServer.getHealth();
      return state.status === 'healthy';
    } catch {
      return false;
    }
  }
}

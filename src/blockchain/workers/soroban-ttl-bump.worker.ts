import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  Keypair,
  Operation,
  TransactionBuilder,
  Networks,
  Address,
  xdr,
  rpc as StellarRpc,
} from '@stellar/stellar-sdk';
import { StellarRpcManagerService } from '../services/stellar-rpc-manager.service';
import { BLOCKCHAIN_QUEUE } from '../blockchain.constants';

export const TTL_BUMP_JOB_NAME = 'bump-soroban-ledger-ttl';
export const DEFAULT_EXTEND_TO_LEDGERS = 3110400; // ~6 meses (a 5s por ledger)

@Processor(BLOCKCHAIN_QUEUE)
@Injectable()
export class SorobanTtlBumpWorker extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SorobanTtlBumpWorker.name);

  constructor(
    private readonly rpcManager: StellarRpcManagerService,
    private readonly configService: ConfigService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_QUEUE)
    private readonly blockchainQueue?: Queue,
  ) {
    super();
  }

  async onModuleInit() {
    if (this.blockchainQueue) {
      try {
        // Registrar trabajo recurrente diario a las 02:00 UTC
        await this.blockchainQueue.add(
          TTL_BUMP_JOB_NAME,
          { extendTo: DEFAULT_EXTEND_TO_LEDGERS },
          {
            jobId: 'recurring-soroban-ttl-bump',
            repeat: {
              pattern: '0 2 * * *', // Todos los días a las 02:00 AM
            },
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            removeOnComplete: true,
          },
        );
        this.logger.log(
          '[SorobanTtlBumpWorker] Cron recurrente registrado exitosamente (0 2 * * *).',
        );
      } catch (err: any) {
        this.logger.warn(
          `No se pudo registrar el cron recurrente de TTL Bump: ${err.message}`,
        );
      }
    }
  }

  async process(job: Job<any>): Promise<any> {
    if (job.name !== TTL_BUMP_JOB_NAME) {
      return;
    }

    this.logger.log(
      `Iniciando extensión preventiva de TTL de contratos Soroban (Job #${job.id})...`,
    );

    const contractsToBump = [
      this.configService.get<string>('SOROBAN_REGISTRY_CONTRACT_ID'),
      this.configService.get<string>('SOROBAN_TOKEN_CONTRACT_ID'),
    ].filter(Boolean) as string[];

    if (contractsToBump.length === 0) {
      this.logger.warn(
        'No se encontraron contratos configurados para extender TTL.',
      );
      return { bumped: 0, contracts: [] };
    }

    const adminSecret =
      this.configService.get<string>('STELLAR_ADMIN_SECRET') ||
      this.configService.get<string>('STELLAR_SECRET_KEY');

    if (!adminSecret) {
      throw new Error(
        'STELLAR_ADMIN_SECRET no configurado para ejecutar el mantenimiento de TTL',
      );
    }

    const adminKeypair = Keypair.fromSecret(adminSecret);
    const networkPassphrase =
      this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE') ||
      Networks.TESTNET;
    const extendTo = job.data?.extendTo || DEFAULT_EXTEND_TO_LEDGERS;

    const results: Array<{
      contractId: string;
      success: boolean;
      result: any;
    }> = [];

    for (const contractId of contractsToBump) {
      try {
        const result = await this.bumpContractTtl(
          contractId,
          adminKeypair,
          networkPassphrase,
          extendTo,
        );
        results.push({ contractId, success: true, result });
        this.logger.log(
          `TTL extendido exitosamente para contrato: ${contractId}`,
        );
      } catch (error: any) {
        this.logger.error(
          `Error al extender TTL para contrato ${contractId}: ${error.message}`,
          error.stack,
        );
        throw error; // Permite a BullMQ aplicar la política de reintentos
      }
    }

    return { bumped: results.length, contracts: results };
  }

  /**
   * Ejecuta la extensión de TTL del contrato contra la red Soroban vía Multi-RPC.
   */
  async bumpContractTtl(
    contractId: string,
    signer: Keypair,
    networkPassphrase: string,
    extendTo: number,
  ) {
    return this.rpcManager.executeWithFailover(async (server) => {
      const account = await server.getAccount(signer.publicKey());

      const extendOp = Operation.extendFootprintTtl({
        extendTo,
      });

      const tx = new TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase,
      })
        .addOperation(extendOp)
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);

      if (StellarRpc.Api.isSimulationSuccess(sim)) {
        const preparedTx = await server.prepareTransaction(tx);
        preparedTx.sign(signer);
        const sendResponse = await server.sendTransaction(preparedTx);
        return {
          status: sendResponse.status,
          hash: sendResponse.hash,
        };
      }

      return {
        status: 'SIMULATION_SKIPPED',
        contractId,
      };
    });
  }
}

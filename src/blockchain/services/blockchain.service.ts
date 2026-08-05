import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { ECO_BATCH_REGISTRY_ABI } from '../blockchain.constants';

@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initEthers();
  }

  private initEthers() {
    const rpcUrl = this.configService.get<string>(
      'ARBITRUM_RPC_URL',
      'https://sepolia-rollup.arbitrum.io/rpc',
    );
    const rawPrivateKey = this.configService.get<string>('WORKER_PRIVATE_KEY');
    let privateKey = rawPrivateKey?.trim();
    if (privateKey && !privateKey.startsWith('0x')) {
      privateKey = `0x${privateKey}`;
    }
    const contractAddress = this.configService.get<string>('ECOTOKEN_CONTRACT_ADDRESS');

    this.logger.log(`Inicializando BlockchainService con RPC: ${rpcUrl}`);

    try {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);

      if (privateKey && privateKey !== '0x...' && ethers.isHexString(privateKey, 32)) {
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.logger.log(`Wallet de Blockchain configurada con dirección: ${this.wallet.address}`);
      } else {
        // Fallback wallet para entornos de desarrollo/pruebas
        this.logger.warn(
          'WORKER_PRIVATE_KEY no está configurada o es inválida. Generando wallet aleatoria en memoria.',
        );
        const randomWallet = ethers.Wallet.createRandom();
        this.wallet = new ethers.Wallet(randomWallet.privateKey, this.provider);
      }

      if (contractAddress && contractAddress !== '0x...' && ethers.isAddress(contractAddress)) {
        this.contract = new ethers.Contract(
          contractAddress,
          ECO_BATCH_REGISTRY_ABI,
          this.wallet,
        );
      } else {
        // En caso de que el contrato no esté desplegado o la dirección sea placeholder
        const fallbackAddress = ethers.ZeroAddress;
        this.logger.warn(
          `ECOTOKEN_CONTRACT_ADDRESS no configurada o inválida. Usando dirección fallback: ${fallbackAddress}`,
        );
        this.contract = new ethers.Contract(
          fallbackAddress,
          ECO_BATCH_REGISTRY_ABI,
          this.wallet,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error inicializando componentes de Ethers.js: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Invoca la función register_batch del contrato inteligente en Arbitrum Stylus.
   * @param batchIdBytes32 Identificador del lote en formato bytes32 hex
   * @param ipfsCid CID de los metadatos en IPFS
   * @param recipients Lista de direcciones de destinatarios (recolector + hogares)
   * @param amounts Lista de montos en wei (18 decimales)
   * @returns TransactionReceipt con el resultado de la confirmación
   */
  async executeBatchRegistration(
    batchIdBytes32: string,
    ipfsCid: string,
    recipients: string[],
    amounts: bigint[],
  ): Promise<ethers.TransactionReceipt> {
    this.logger.log(
      `Ejecutando register_batch en contrato [${await this.contract.getAddress()}]. BatchIdBytes32: ${batchIdBytes32}, CID: ${ipfsCid}`,
    );

    try {
      const contractAddress = await this.contract.getAddress();
      if (contractAddress === ethers.ZeroAddress) {
        this.logger.warn(
          'El contrato inteligente está apuntando a ZeroAddress. Simulando confirmación de transacción on-chain.',
        );
        return {
          hash: `0xmock${Date.now().toString(16)}00000000000000000000000000000000000000000000`,
          status: 1,
          blockNumber: 1234567,
          from: this.wallet.address,
          to: contractAddress,
        } as unknown as ethers.TransactionReceipt;
      }

      const tx = await this.contract.registerBatch(
        batchIdBytes32,
        ipfsCid,
        recipients,
        amounts,
      );


      this.logger.log(`Transacción enviada a Arbitrum. Tx Hash: ${tx.hash}`);

      const receipt = await tx.wait();
      this.logger.log(
        `Transacción confirmada en bloque #${receipt.blockNumber}. Tx Hash: ${receipt.hash}`,
      );

      return receipt;
    } catch (error: any) {
      this.logger.error(
        `Error al ejecutar transacción on-chain register_batch: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Retorna la dirección de la billetera del worker.
   */
  getWorkerAddress(): string {
    return this.wallet ? this.wallet.address : ethers.ZeroAddress;
  }
}

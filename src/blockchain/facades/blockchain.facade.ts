import { Injectable } from '@nestjs/common';
import { BlockchainService } from '../services/blockchain.service';
import { IBlockchainFacade } from './blockchain.facade.interface';

/**
 * Implementación de la Fachada Blockchain (PUCP Disoft - Facade Pattern)
 * Oculta la complejidad de RPC failover, Soroban auth, circuit breaker y sequence manager,
 * ofreciendo una API limpia para el resto de la aplicación.
 */
@Injectable()
export class BlockchainFacade implements IBlockchainFacade {
  constructor(private readonly blockchainService: BlockchainService) {}

  async getBalance(walletAddress: string): Promise<string> {
    return this.blockchainService.getBalance(walletAddress);
  }

  async getMaterialRate(materialCode: string): Promise<number> {
    return this.blockchainService.getMaterialRate(materialCode);
  }

  async mintEcoTokens(destinationAddress: string, amount: number): Promise<any> {
    return this.blockchainService.mintEcoTokens(destinationAddress, amount);
  }

  async executeSubsidizedTransfer(
    senderPrivateKey: string,
    destinationAddress: string,
    amount: number,
  ): Promise<any> {
    return this.blockchainService.executeSubsidizedTransfer(
      senderPrivateKey,
      destinationAddress,
      amount,
    );
  }

  async notarizeBatchReceipt(
    batchId: string,
    ipfsCid: string,
    centerAddress?: string,
  ): Promise<any> {
    return this.blockchainService.notarizeBatchReceipt(
      batchId,
      ipfsCid,
      centerAddress,
    );
  }

  async sponsorAccountCreation(newAccountPublicKey: string): Promise<any> {
    return this.blockchainService.sponsorAccountCreation(newAccountPublicKey);
  }

  async checkConnection(): Promise<boolean> {
    return this.blockchainService.checkConnection();
  }

  getWorkerAddress(): string {
    return this.blockchainService.getWorkerAddress();
  }
}

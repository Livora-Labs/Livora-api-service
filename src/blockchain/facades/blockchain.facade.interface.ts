/**
 * Patrón Fachada (Facade Pattern) - PUCP Disoft Diapositiva 05
 * Proporciona una interfaz unificada y de alto nivel sobre el complejo subsistema
 * blockchain (Stellar Horizon, Soroban RPC, failover, sequence managers y circuit breakers).
 */
export interface IBlockchainFacade {
  getBalance(walletAddress: string): Promise<string>;
  getMaterialRate(materialCode: string): Promise<number>;
  mintEcoTokens(destinationAddress: string, amount: number): Promise<any>;
  executeSubsidizedTransfer(
    senderPrivateKey: string,
    destinationAddress: string,
    amount: number,
  ): Promise<any>;
  notarizeBatchReceipt(
    batchId: string,
    ipfsCid: string,
    centerAddress?: string,
  ): Promise<any>;
  sponsorAccountCreation(newAccountPublicKey: string): Promise<any>;
  checkConnection(): Promise<boolean>;
  getWorkerAddress(): string;
}

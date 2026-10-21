import { BlockchainFacade } from './blockchain.facade';
import { BlockchainService } from '../services/blockchain.service';

describe('Patrón Fachada: BlockchainFacade (PUCP Disoft Diapositiva 05)', () => {
  let facade: BlockchainFacade;
  let mockBlockchainService: Partial<BlockchainService>;

  beforeEach(() => {
    mockBlockchainService = {
      getBalance: jest.fn().mockResolvedValue('150.50'),
      getMaterialRate: jest.fn().mockResolvedValue(2.5),
      mintEcoTokens: jest.fn().mockResolvedValue({ hash: 'tx_mint_123' }),
      executeSubsidizedTransfer: jest.fn().mockResolvedValue({ hash: 'tx_subsidized_456' }),
      notarizeBatchReceipt: jest.fn().mockResolvedValue({ hash: 'tx_notarize_789' }),
      sponsorAccountCreation: jest.fn().mockResolvedValue({ hash: 'tx_sponsor_000' }),
      checkConnection: jest.fn().mockResolvedValue(true),
      getWorkerAddress: jest.fn().mockReturnValue('GDWORKER_STELLAR_PUBKEY'),
    };

    facade = new BlockchainFacade(mockBlockchainService as BlockchainService);
  });

  it('debe consultar saldo on-chain a través de la fachada sin exponer lógica interna', async () => {
    const balance = await facade.getBalance('GACCOUNT_PUBKEY');
    expect(balance).toBe('150.50');
    expect(mockBlockchainService.getBalance).toHaveBeenCalledWith('GACCOUNT_PUBKEY');
  });

  it('debe acuñar tokens ecológicos delegando en el servicio Soroban', async () => {
    const res = await facade.mintEcoTokens('GDESTINATION_PUBKEY', 50);
    expect(res).toEqual({ hash: 'tx_mint_123' });
    expect(mockBlockchainService.mintEcoTokens).toHaveBeenCalledWith('GDESTINATION_PUBKEY', 50);
  });

  it('debe notarizar lotes en blockchain delegando parámetros limpios', async () => {
    const res = await facade.notarizeBatchReceipt('batch-01', 'QmIpfsCid');
    expect(res).toEqual({ hash: 'tx_notarize_789' });
    expect(mockBlockchainService.notarizeBatchReceipt).toHaveBeenCalledWith(
      'batch-01',
      'QmIpfsCid',
      undefined,
    );
  });

  it('debe verificar conectividad con Stellar Horizon / RPC', async () => {
    const isConnected = await facade.checkConnection();
    expect(isConnected).toBe(true);
    expect(mockBlockchainService.checkConnection).toHaveBeenCalled();
  });
});

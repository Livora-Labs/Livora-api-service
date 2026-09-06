import { BlockchainModule } from './blockchain.module';
import { BlockchainService } from './services/blockchain.service';
import { IpfsService } from './services/ipfs.service';
import { StellarRpcManagerService } from './services/stellar-rpc-manager.service';
import { StellarSequenceManager } from './services/stellar-sequence-manager.service';

describe('BlockchainModule Providers & Exports', () => {
  it('should export all essential blockchain and storage services', () => {
    expect(BlockchainModule).toBeDefined();
    const imports = Reflect.getMetadata('imports', BlockchainModule) || [];
    const providers = Reflect.getMetadata('providers', BlockchainModule) || [];
    const exportsList = Reflect.getMetadata('exports', BlockchainModule) || [];

    expect(exportsList).toContain(BlockchainService);
    expect(exportsList).toContain(IpfsService);
    expect(exportsList).toContain(StellarRpcManagerService);
    expect(exportsList).toContain(StellarSequenceManager);
    expect(providers).toContain(BlockchainService);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { IpfsService } from './ipfs.service';
import { DUMMY_IPFS_HASH } from '../blockchain.constants';

describe('IpfsService (Stream Upload & Gateway Formatting)', () => {
  let service: IpfsService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IpfsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'PINATA_API_KEY') return 'test_pinata_key';
              if (key === 'PINATA_SECRET_KEY') return 'test_pinata_secret';
              if (key === 'IPFS_GATEWAY_URL') return 'https://gateway.pinata.cloud/ipfs/';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<IpfsService>(IpfsService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should format gateway URL properly for CID v0 and v1', () => {
    const cidV0 = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
    expect(service.getGatewayUrl(cidV0)).toBe(
      'https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    );

    const ipfsScheme = 'ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
    expect(service.getGatewayUrl(ipfsScheme)).toBe(
      'https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    );
  });

  it('should return fallback dummy hash when Pinata credentials are not set', async () => {
    (configService.get as jest.Mock).mockReturnValue(null);

    const res = await service.uploadJson({ test: 123 }, 'test-manifest');
    expect(res).toBe(DUMMY_IPFS_HASH);

    const stream = Readable.from(['{"test": 123}']);
    const streamRes = await service.uploadStream(stream, 'test.json');
    expect(streamRes).toBe(DUMMY_IPFS_HASH);
  });

  it('should upload stream to Pinata successfully when fetch returns 200 with IpfsHash', async () => {
    const mockFetch = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ IpfsHash: 'QmStreamHashUploadedSuccessfully1234567890' }),
    } as any);

    const stream = Readable.from([Buffer.from('stream-data-chunk-1')]);
    const cid = await service.uploadStream(stream, 'batch-manifest.json', 'application/json');

    expect(cid).toBe('QmStreamHashUploadedSuccessfully1234567890');
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should upload JSON stream via uploadJsonStream', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ IpfsHash: 'QmJsonStreamHashUploadedSuccessfully123' }),
    } as any);

    const cid = await service.uploadJsonStream({ batchId: 'b-1' }, 'batch-b-1');
    expect(cid).toBe('QmJsonStreamHashUploadedSuccessfully123');
  });
});

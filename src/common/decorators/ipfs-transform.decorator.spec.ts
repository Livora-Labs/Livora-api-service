import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IpfsTransform } from './ipfs-transform.decorator';
import { IpfsGatewayInterceptor } from '../interceptors/ipfs-gateway.interceptor';

@IpfsTransform()
@Controller('test-decorated')
class DecoratedController {
  @Get()
  getData() {
    return {
      id: 'item-1',
      ipfsCid: 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    };
  }
}

@Controller('test-undecorated')
class UndecoratedController {
  @Get()
  getData() {
    return {
      id: 'item-2',
      ipfsCid: 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    };
  }
}

describe('IpfsTransform Decorator & Scope Isolation', () => {
  let decoratedController: DecoratedController;
  let undecoratedController: UndecoratedController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DecoratedController, UndecoratedController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'IPFS_GATEWAY_URL') return 'https://dedicated.pinata.cloud/ipfs/';
              return null;
            }),
          },
        },
        IpfsGatewayInterceptor,
      ],
    }).compile();

    decoratedController = module.get<DecoratedController>(DecoratedController);
    undecoratedController = module.get<UndecoratedController>(UndecoratedController);
  });

  it('should have IpfsGatewayInterceptor metadata bound to decorated controller', () => {
    const interceptors = Reflect.getMetadata(
      '__interceptors__',
      DecoratedController,
    );
    expect(interceptors).toBeDefined();
    expect(interceptors).toHaveLength(1);
    expect(interceptors[0]).toBe(IpfsGatewayInterceptor);
  });

  it('should NOT have IpfsGatewayInterceptor metadata on undecorated controller', () => {
    const interceptors = Reflect.getMetadata(
      '__interceptors__',
      UndecoratedController,
    );
    expect(interceptors).toBeUndefined();
  });
});

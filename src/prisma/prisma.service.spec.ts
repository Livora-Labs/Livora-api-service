import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService (PgBouncer & Read Replicas)', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should instantiate primary PrismaClient and read replica PrismaClient', () => {
    expect(service).toBeDefined();
    expect(service.read).toBeDefined();
    expect(service.getReadClient()).toBe(service.read);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { PrometheusService } from './prometheus.service';

describe('PrometheusService', () => {
  let service: PrometheusService;
  let queueMock: any;

  beforeEach(async () => {
    queueMock = {
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 5,
        active: 2,
        failed: 1,
        delayed: 0,
        completed: 100,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrometheusService,
        { provide: 'BullQueue_blockchain-queue', useValue: queueMock },
      ],
    }).compile();

    service = module.get<PrometheusService>(PrometheusService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should export prometheus metrics string containing custom metrics', async () => {
    // Record sample metrics
    service.sorobanRpcLatency.observe(
      { endpoint: 'https://soroban-testnet.stellar.org', method: 'soroban_rpc_call', status: 'SUCCESS' },
      0.12,
    );
    service.stellarTxFailureTotal.inc({
      error_type: 'TimeoutError',
      operation: 'soroban_rpc_call',
    });

    const metrics = await service.getMetrics();

    expect(metrics).toContain('bullmq_queue_depth');
    expect(metrics).toContain('stellar_soroban_rpc_latency_seconds');
    expect(metrics).toContain('stellar_transaction_failure_total');
    expect(metrics).toContain('nodejs_heap_memory_bytes');
    expect(metrics).toContain('process_cpu_user_seconds_total');
    expect(service.getContentType()).toContain('text/plain');
  });
});

import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as client from 'prom-client';

@Injectable()
export class PrometheusService implements OnModuleInit {
  private readonly registry: client.Registry;

  public readonly bullmqQueueDepth: client.Gauge<string>;
  public readonly sorobanRpcLatency: client.Histogram<string>;
  public readonly stellarTxFailureTotal: client.Counter<string>;
  public readonly nodejsHeapMemory: client.Gauge<string>;

  constructor(
    @Optional()
    @InjectQueue('blockchain-queue')
    private readonly blockchainQueue?: Queue,
  ) {
    this.registry = new client.Registry();

    // Recolector de métricas estándar de Node.js (CPU, Event Loop, GC, Heap)
    client.collectDefaultMetrics({ register: this.registry });

    // 1. bullmq_queue_depth (Gauge)
    this.bullmqQueueDepth = new client.Gauge({
      name: 'bullmq_queue_depth',
      help: 'Profundidad de trabajos en la cola de BullMQ por estado (waiting, active, failed, delayed, completed)',
      labelNames: ['queue_name', 'state'],
      registers: [this.registry],
    });

    // 2. stellar_soroban_rpc_latency_seconds (Histogram)
    this.sorobanRpcLatency = new client.Histogram({
      name: 'stellar_soroban_rpc_latency_seconds',
      help: 'Latencia en segundos de las peticiones RPC a la red Stellar/Soroban',
      labelNames: ['endpoint', 'method', 'status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // 3. stellar_transaction_failure_total (Counter)
    this.stellarTxFailureTotal = new client.Counter({
      name: 'stellar_transaction_failure_total',
      help: 'Número total de transacciones fallidas en la blockchain Stellar/Soroban',
      labelNames: ['error_type', 'operation'],
      registers: [this.registry],
    });

    // 4. nodejs_heap_memory_bytes (Gauge)
    this.nodejsHeapMemory = new client.Gauge({
      name: 'nodejs_heap_memory_bytes',
      help: 'Uso de memoria heap de Node.js en bytes',
      registers: [this.registry],
    });
  }

  onModuleInit() {
    this.updateHeapMemory();
  }

  private updateHeapMemory() {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const memory = process.memoryUsage();
      this.nodejsHeapMemory.set(memory.heapUsed);
    }
  }

  async getMetrics(): Promise<string> {
    this.updateHeapMemory();

    // Actualizar métricas de BullMQ en tiempo real si la cola está conectada
    if (this.blockchainQueue) {
      try {
        const counts = await this.blockchainQueue.getJobCounts(
          'waiting',
          'active',
          'failed',
          'delayed',
          'completed',
        );

        for (const [state, count] of Object.entries(counts)) {
          this.bullmqQueueDepth.set(
            { queue_name: 'blockchain-queue', state },
            count,
          );
        }
      } catch {
        // En caso de que Redis no esté disponible momentáneamente
      }
    }

    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}

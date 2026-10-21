import {
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { IpfsService } from '../blockchain/services/ipfs.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { NotificationsService } from '../notifications/notifications.service';

import { CreateCollectionDto } from './dto/create-collection.dto';
import { FindCollectionsQueryDto } from './dto/find-collections-query.dto';
import { UpdateCollectionStatusDto } from './dto/update-collection-status.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { SubmitBidDto } from './dto/submit-bid.dto';
import { SelectBidDto } from './dto/select-bid.dto';
import { AvailableCollectionsQueryDto } from './dto/available-collections-query.dto';
import { RateCollectionDto } from './dto/rate-collection.dto';
import { EditCollectionRequestDto } from './dto/edit-collection-request.dto';
import { CollectorTelemetryDto } from './dto/collector-telemetry.dto';

import { CollectionAuctionService } from './services/collection-auction.service';
import { CollectionLifecycleService } from './services/collection-lifecycle.service';
import { CollectionVerificationService } from './services/collection-verification.service';
import { CollectionTrackingService } from './services/collection-tracking.service';
import { CollectionEscrowService } from './services/collection-escrow.service';
import { CollectionsRepository } from './repositories/collections.repository';
import { RewardCalculatorFactory } from './factories/reward-calculator.factory';

/**
 * CollectionsService - Fachada Orquestadora (PUCP Disoft - GoF Facade Pattern)
 * Proporciona un punto de entrada unificado y de alto nivel a los subsistemas de recolección,
 * eliminando el antipatrón The Blob y delegando responsabilidades a servicios cohesivos:
 * - CollectionLifecycleService (Ciclo de vida, transiciones, cancelaciones, reclasificaciones)
 * - CollectionVerificationService (Verificación multifactorial en campo, Chain of Resp, Strategy)
 * - CollectionTrackingService (Telemetría en tiempo real, geocercas WGS-84, GPS tracking)
 * - CollectionAuctionService (Subastas competitivas de centros de acopio)
 * - CollectionEscrowService (Garantías y depósitos en custodia Stellar)
 * - CollectionsRepository (Acceso a datos desacoplado, PostGIS spatial radar)
 */
@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);
  private readonly lifecycle: CollectionLifecycleService;
  private readonly verification: CollectionVerificationService;
  private readonly tracking: CollectionTrackingService;
  private readonly escrow: CollectionEscrowService;
  private readonly repo: CollectionsRepository;
  private readonly rewardFactory: RewardCalculatorFactory;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ipfsService: IpfsService,
    private readonly blockchainService: BlockchainService,
    private readonly websocketsService: WebsocketsService,
    private readonly notificationsService: NotificationsService,
    private readonly auctionService: CollectionAuctionService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly redisService?: RedisService,
    @Optional() lifecycleService?: CollectionLifecycleService,
    @Optional() verificationService?: CollectionVerificationService,
    @Optional() trackingService?: CollectionTrackingService,
    @Optional() escrowService?: CollectionEscrowService,
    @Optional() repository?: CollectionsRepository,
    @Optional() rewardCalculatorFactory?: RewardCalculatorFactory,
  ) {
    this.repo = repository ?? new CollectionsRepository(this.prisma, this.redisService);
    this.rewardFactory = rewardCalculatorFactory ?? new RewardCalculatorFactory();
    this.escrow =
      escrowService ??
      new CollectionEscrowService(
        this.prisma,
        this.blockchainService,
        this.rewardFactory,
      );
    this.lifecycle =
      lifecycleService ??
      new CollectionLifecycleService(
        this.prisma,
        this.escrow,
        this.blockchainService,
        this.notificationsService,
        this.websocketsService,
        this.configService,
        this.ipfsService,
        this.redisService,
      );
    this.verification =
      verificationService ??
      new CollectionVerificationService(
        this.prisma,
        this.repo,
        this.rewardFactory,
        this.blockchainService,
        this.notificationsService,
        this.websocketsService,
        this.configService || (new ConfigService() as any),
        this.redisService,
      );
    this.tracking =
      trackingService ??
      new CollectionTrackingService(
        this.prisma,
        this.websocketsService,
        this.notificationsService,
        this.redisService,
      );
  }

  // ==========================================
  // CICLO DE VIDA (Lifecycle Subsystem)
  // ==========================================

  async create(
    userId: string,
    dto: CreateCollectionDto,
    file?:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
  ) {
    return this.lifecycle.create(userId, dto, file);
  }

  async updateStatus(
    id: string,
    userId: string,
    role: string,
    dto: UpdateCollectionStatusDto,
  ) {
    return this.lifecycle.updateStatus(id, userId, role, dto);
  }

  async abandonCollectionRequest(
    id: string,
    collectorId: string,
    reason?: string,
  ) {
    return this.lifecycle.abandonCollectionRequest(id, collectorId, reason);
  }

  async rateCollectionRequest(
    householdUserId: string,
    id: string,
    dto: RateCollectionDto,
  ) {
    return this.lifecycle.rateCollectionRequest(householdUserId, id, dto);
  }

  async editCollectionRequest(
    id: string,
    userId: string,
    dto: EditCollectionRequestDto,
  ) {
    return this.lifecycle.editCollectionRequest(id, userId, dto);
  }

  async reportNoShow(id: string, collectorId: string) {
    return this.lifecycle.reportNoShow(id, collectorId);
  }

  async rejectOnSite(
    id: string,
    collectorId: string,
    reason: string,
    photoUrls?: string[],
  ) {
    return this.lifecycle.rejectOnSite(id, collectorId, reason, photoUrls);
  }

  async checkAuctionFallbacks() {
    return this.lifecycle.checkAuctionFallbacks();
  }

  // ==========================================
  // VERIFICACIÓN EN DOMICILIO (Verification Subsystem)
  // ==========================================

  async verifyPin(id: string, collectorId: string, dto: VerifyPinDto) {
    return this.verification.verifyPin(id, collectorId, dto);
  }

  // ==========================================
  // TELEMETRÍA Y SEGUIMIENTO (Tracking Subsystem)
  // ==========================================

  async startRoute(id: string, collectorId: string) {
    return this.tracking.startRoute(id, collectorId);
  }

  async reachDestination(id: string, collectorId: string) {
    return this.tracking.reachDestination(id, collectorId);
  }

  async updateCollectorLocation(
    id: string,
    collectorId: string,
    dto: CollectorTelemetryDto,
  ) {
    return this.tracking.updateCollectorLocation(id, collectorId, dto);
  }

  // ==========================================
  // SUBASTAS Y TARIFARIOS (Auction Subsystem)
  // ==========================================

  async submitBid(centerId: string, requestId: string, dto: SubmitBidDto) {
    return this.auctionService.submitBid(centerId, requestId, dto);
  }

  async withdrawBid(centerId: string, requestId: string, bidId?: string) {
    return this.auctionService.withdrawBid(centerId, requestId, bidId);
  }

  async selectBid(householdId: string, requestId: string, dto: SelectBidDto) {
    return this.auctionService.selectBid(householdId, requestId, dto);
  }

  async claimAutomatic(centerId: string, requestId: string) {
    return this.auctionService.claimAutomatic(centerId, requestId);
  }

  // ==========================================
  // CONSULTAS Y REPOSITORIO (Repository Subsystem)
  // ==========================================

  async findAll(user: { id: string; role: Role }, query: FindCollectionsQueryDto) {
    return this.repo.findAll(user, query);
  }

  async findAvailable(
    collectorId: string,
    query: AvailableCollectionsQueryDto,
  ) {
    return this.repo.findAvailable(collectorId, query);
  }

  async findOne(id: string, userId: string, role: string) {
    return this.repo.findOne(id, userId, role);
  }
}

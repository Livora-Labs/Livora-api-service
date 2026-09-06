import { Test, TestingModule } from '@nestjs/testing';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { RequestStatus, Role } from '@prisma/client';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { FastifyRequest } from 'fastify';

describe('CollectionsController', () => {
  let controller: CollectionsController;

  const mockCollectionsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    updateStatus: jest.fn(),
    verifyPin: jest.fn(),
    submitBid: jest.fn(),
    withdrawBid: jest.fn(),
    selectBid: jest.fn(),
    claimAutomatic: jest.fn(),
    abandonCollectionRequest: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CollectionsController],
      providers: [
        {
          provide: CollectionsService,
          useValue: mockCollectionsService,
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CollectionsController>(CollectionsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create collection request with JSON body when not multipart', async () => {
      const user = { id: 'user-123', role: Role.HOGAR };
      const dto: CreateCollectionDto = {
        itemsEstimated: { PET: 5 },
        description: 'Botellas plásticas y cartón',
        latitude: -12.0464,
        longitude: -77.0428,
        photoUrl: 'https://ipfs.io/ipfs/QmExistingPhotoHash',
      };
      const expectedResult = {
        id: 'req-123',
        ...dto,
        status: RequestStatus.PENDING,
      };
      mockCollectionsService.create.mockResolvedValue(expectedResult);

      const result = await controller.create(user, dto);

      expect(mockCollectionsService.create).toHaveBeenCalledWith(
        user.id,
        dto,
        undefined,
      );
      expect(result).toEqual(expectedResult);
    });

    it('should parse multipart request file and fields when multipart stream request is received', async () => {
      const user = { id: 'user-123', role: Role.HOGAR };
      const fileBuffer = Buffer.from('mock-image-data');
      const mockReq = {
        isMultipart: () => true,
        file: jest.fn().mockResolvedValue({
          filename: 'photo.jpg',
          mimetype: 'image/jpeg',
          toBuffer: () => Promise.resolve(fileBuffer),
          fields: {
            itemsEstimated: { value: '{"PET": 10}' },
            description: { value: 'Materiales reciclables varios' },
            latitude: { value: '-12.05' },
            longitude: { value: '-77.03' },
          },
        }),
      } as unknown as FastifyRequest;

      const expectedResult = { id: 'req-456', status: RequestStatus.PENDING };
      mockCollectionsService.create.mockResolvedValue(expectedResult);

      const emptyDto: CreateCollectionDto = {
        itemsEstimated: {},
        description: '',
        latitude: 0,
        longitude: 0,
      };

      const result = await controller.create(user, emptyDto, mockReq);

      expect(mockReq.file).toHaveBeenCalled();
      expect(mockCollectionsService.create).toHaveBeenCalledWith(
        user.id,
        {
          itemsEstimated: { PET: 10 },
          description: 'Materiales reciclables varios',
          latitude: -12.05,
          longitude: -77.03,
          photoUrl: undefined,
        },
        {
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg',
          buffer: fileBuffer,
          size: fileBuffer.length,
        },
      );
      expect(result).toEqual(expectedResult);
    });

    it('should pass incomingFile from fastifyMultipart attachFieldsToBody to service.create', async () => {
      const user = { id: 'user-123', role: Role.HOGAR };
      const fileBuffer = Buffer.from('mock-attached-image');
      const mockReq = {
        incomingFile: {
          originalname: 'photo-attached.png',
          mimetype: 'image/png',
          buffer: fileBuffer,
          size: fileBuffer.length,
        },
      } as unknown as FastifyRequest;

      const dto: CreateCollectionDto = {
        itemsEstimated: { PET: 2.5, GLASS: 1.0 },
        description: 'Bolsa verde',
        latitude: -12.04,
        longitude: -77.04,
      };

      const expectedResult = { id: 'req-789', status: RequestStatus.PENDING };
      mockCollectionsService.create.mockResolvedValue(expectedResult);

      const result = await controller.create(user, dto, mockReq);

      expect(mockCollectionsService.create).toHaveBeenCalledWith(user.id, dto, {
        originalname: 'photo-attached.png',
        mimetype: 'image/png',
        buffer: fileBuffer,
        size: fileBuffer.length,
      });
      expect(result).toEqual(expectedResult);
    });
  });

  describe('findAll', () => {
    it('should call service.findAll with user and query', async () => {
      const user = { id: 'user-123', role: Role.RECOLECTOR };
      const query = { page: 1, limit: 10 };
      const expected = [{ id: 'req-1' }];
      mockCollectionsService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(user, query);

      expect(mockCollectionsService.findAll).toHaveBeenCalledWith(user, query);
      expect(result).toEqual(expected);
    });
  });

  describe('findOne', () => {
    it('should call service.findOne with id and user info', async () => {
      const user = { id: 'user-123', role: Role.HOGAR };
      const expected = { id: 'req-1' };
      mockCollectionsService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne('req-1', user);

      expect(mockCollectionsService.findOne).toHaveBeenCalledWith(
        'req-1',
        user.id,
        user.role,
      );
      expect(result).toEqual(expected);
    });
  });

  describe('updateStatus', () => {
    it('should call service.updateStatus', async () => {
      const user = { id: 'collector-1', role: Role.RECOLECTOR };
      const dto = { status: RequestStatus.ACCEPTED };
      const expected = { id: 'req-1', status: RequestStatus.ACCEPTED };
      mockCollectionsService.updateStatus.mockResolvedValue(expected);

      const result = await controller.updateStatus('req-1', user, dto);

      expect(mockCollectionsService.updateStatus).toHaveBeenCalledWith(
        'req-1',
        user.id,
        user.role,
        dto,
      );
      expect(result).toEqual(expected);
    });
  });

  describe('verifyPin', () => {
    it('should call service.verifyPin', async () => {
      const dto = { pin: '1234' };
      const expected = { id: 'req-1', status: RequestStatus.COMPLETED };
      mockCollectionsService.verifyPin.mockResolvedValue(expected);

      const result = await controller.verifyPin('req-1', 'collector-1', dto);

      expect(mockCollectionsService.verifyPin).toHaveBeenCalledWith(
        'req-1',
        'collector-1',
        dto,
      );
      expect(result).toEqual(expected);
    });
  });

  describe('submitBid', () => {
    it('should call service.submitBid with centerId, requestId and dto', async () => {
      const dto = { proposedRates: { PET: 1.2 } };
      const expected = { id: 'bid-1', status: 'PENDING' };
      mockCollectionsService.submitBid.mockResolvedValue(expected);

      const result = await controller.submitBid('req-1', 'center-1', dto);

      expect(mockCollectionsService.submitBid).toHaveBeenCalledWith(
        'center-1',
        'req-1',
        dto,
      );
      expect(result).toEqual(expected);
    });
  });

  describe('withdrawBid', () => {
    it('should call service.withdrawBid with centerId, requestId and bidId', async () => {
      const expected = { success: true };
      mockCollectionsService.withdrawBid.mockResolvedValue(expected);

      const result = await controller.withdrawBid('req-1', 'bid-1', 'center-1');

      expect(mockCollectionsService.withdrawBid).toHaveBeenCalledWith(
        'center-1',
        'req-1',
        'bid-1',
      );
      expect(result).toEqual(expected);
    });
  });

  describe('selectBid', () => {
    it('should call service.selectBid with householdId, requestId and dto', async () => {
      const dto = { bidId: 'bid-1' };
      const expected = { id: 'req-1', assignedCenterId: 'center-1' };
      mockCollectionsService.selectBid.mockResolvedValue(expected);

      const result = await controller.selectBid('req-1', 'household-1', dto);

      expect(mockCollectionsService.selectBid).toHaveBeenCalledWith(
        'household-1',
        'req-1',
        dto,
      );
      expect(result).toEqual(expected);
    });
  });

  describe('claimAutomatic', () => {
    it('should call service.claimAutomatic with centerId and requestId', async () => {
      const expected = { id: 'req-1', assignedCenterId: 'center-1' };
      mockCollectionsService.claimAutomatic.mockResolvedValue(expected);

      const result = await controller.claimAutomatic('req-1', 'center-1');

      expect(mockCollectionsService.claimAutomatic).toHaveBeenCalledWith(
        'center-1',
        'req-1',
      );
      expect(result).toEqual(expected);
    });
  });

  describe('abandonRequest', () => {
    it('should call service.abandonCollectionRequest with id, collectorId and reason', async () => {
      const expected = { id: 'req-1', status: 'PENDING', collectorId: null };
      mockCollectionsService.abandonCollectionRequest.mockResolvedValue(expected);

      const result = await controller.abandonRequest(
        'req-1',
        'collector-1',
        'Avería mecánica en camión',
      );

      expect(mockCollectionsService.abandonCollectionRequest).toHaveBeenCalledWith(
        'req-1',
        'collector-1',
        'Avería mecánica en camión',
      );
      expect(result).toEqual(expected);
    });
  });
});


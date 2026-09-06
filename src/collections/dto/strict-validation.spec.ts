import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCollectionDto } from './create-collection.dto';
import { ReceiveBatchDto } from '../../batches/dto/receive-batch.dto';
import { VerifyPinDto } from './verify-pin.dto';
import { SubmitBidDto } from './submit-bid.dto';
import { MaterialPriceItemDto } from '../../centers/dto/update-price-list.dto';
import { CreateQrRedemptionDto } from '../../stores/dto/create-qr-redemption.dto';
import { CreateTransactionDto } from '../../wallets/dto/create-transaction.dto';
import { CreateSaleDto } from '../../sales/dto/create-sale.dto';

describe('Strict Input Validation Audit & Shielding', () => {
  describe('CreateCollectionDto - itemsEstimated', () => {
    it('should REJECT microscopic weights like 0.000004 kg', async () => {
      const dto = plainToInstance(CreateCollectionDto, {
        itemsEstimated: { PET: 0.000004 },
        latitude: -12.0464,
        longitude: -77.0428,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'itemsEstimated')).toBe(true);
    });

    it('should REJECT weights under 0.5 kg (e.g. 0.2 kg)', async () => {
      const dto = plainToInstance(CreateCollectionDto, {
        itemsEstimated: { PET: 0.2 },
        latitude: -12.0464,
        longitude: -77.0428,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'itemsEstimated')).toBe(true);
    });

    it('should REJECT weights with more than 2 decimal places (e.g. 1.255 kg)', async () => {
      const dto = plainToInstance(CreateCollectionDto, {
        itemsEstimated: { PET: 1.255 },
        latitude: -12.0464,
        longitude: -77.0428,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'itemsEstimated')).toBe(true);
    });

    it('should REJECT 0 kg or negative weights', async () => {
      const dtoZero = plainToInstance(CreateCollectionDto, {
        itemsEstimated: { PET: 0 },
        latitude: -12.0464,
        longitude: -77.0428,
      });
      const errorsZero = await validate(dtoZero);
      expect(errorsZero.some((e) => e.property === 'itemsEstimated')).toBe(true);

      const dtoNegative = plainToInstance(CreateCollectionDto, {
        itemsEstimated: { PET: -2.5 },
        latitude: -12.0464,
        longitude: -77.0428,
      });
      const errorsNeg = await validate(dtoNegative);
      expect(errorsNeg.some((e) => e.property === 'itemsEstimated')).toBe(true);
    });

    it('should ACCEPT valid weights >= 0.5 kg with up to 2 decimals', async () => {
      const dto = plainToInstance(CreateCollectionDto, {
        itemsEstimated: { PET: 0.5, CARTON: 1.5, VIDRIO: 2.75 },
        latitude: -12.0464,
        longitude: -77.0428,
      });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'itemsEstimated').length).toBe(0);
    });
  });

  describe('ReceiveBatchDto - materialsActual', () => {
    it('should REJECT microscopic or sub-0.5kg real weights', async () => {
      const dtoMicro = plainToInstance(ReceiveBatchDto, {
        materialsActual: { PET: 0.000004 },
      });
      const errorsMicro = await validate(dtoMicro);
      expect(errorsMicro.some((e) => e.property === 'materialsActual')).toBe(true);

      const dtoSub = plainToInstance(ReceiveBatchDto, {
        materialsActual: { PET: 0.3 },
      });
      const errorsSub = await validate(dtoSub);
      expect(errorsSub.some((e) => e.property === 'materialsActual')).toBe(true);
    });

    it('should REJECT more than 2 decimal places in real weights', async () => {
      const dto = plainToInstance(ReceiveBatchDto, {
        materialsActual: { PET: 10.123 },
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'materialsActual')).toBe(true);
    });

    it('should ACCEPT valid industrial weights >= 0.5 kg', async () => {
      const dto = plainToInstance(ReceiveBatchDto, {
        materialsActual: { PET: 15.5, CARTON: 8.25 },
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });
  });

  describe('VerifyPinDto - actualWeights', () => {
    it('should REJECT microscopic or invalid actualWeights in domestic verification', async () => {
      const dto = plainToInstance(VerifyPinDto, {
        pin: '1234',
        actualWeights: { PET: 0.000004 },
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'actualWeights')).toBe(true);
    });

    it('should ACCEPT valid actualWeights >= 0.5 kg', async () => {
      const dto = plainToInstance(VerifyPinDto, {
        pin: '1234',
        actualWeights: { PET: 1.5, CARTON: 0.5 },
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });
  });

  describe('SubmitBidDto & MaterialPriceItemDto - Acopio Tariffs', () => {
    it('should REJECT tariffs under 0.05 PEN in SubmitBidDto', async () => {
      const dto = plainToInstance(SubmitBidDto, {
        proposedRates: { PET: 0.01 },
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'proposedRates')).toBe(true);
    });

    it('should REJECT tariffs under 0.05 PEN or >2 decimals in MaterialPriceItemDto', async () => {
      const dtoUnder = plainToInstance(MaterialPriceItemDto, {
        materialType: 'PET',
        pricePerKg: 0.02,
      });
      const errorsUnder = await validate(dtoUnder);
      expect(errorsUnder.some((e) => e.property === 'pricePerKg')).toBe(true);

      const dtoDecimals = plainToInstance(MaterialPriceItemDto, {
        materialType: 'PET',
        pricePerKg: 1.255,
      });
      const errorsDecimals = await validate(dtoDecimals);
      expect(errorsDecimals.some((e) => e.property === 'pricePerKg')).toBe(true);
    });

    it('should ACCEPT valid tariffs >= 0.05 PEN with max 2 decimals', async () => {
      const dtoItem = plainToInstance(MaterialPriceItemDto, {
        materialType: 'PET',
        pricePerKg: 0.05,
      });
      const errorsItem = await validate(dtoItem);
      expect(errorsItem.length).toBe(0);

      const dtoBid = plainToInstance(SubmitBidDto, {
        proposedRates: { PET: 0.05, CARTON: 1.25 },
      });
      const errorsBid = await validate(dtoBid);
      expect(errorsBid.length).toBe(0);
    });
  });

  describe('CreateQrRedemptionDto - POS Store Charging', () => {
    it('should REJECT POS charging amounts under 0.10 ECO or with >2 decimals', async () => {
      const dtoUnder = plainToInstance(CreateQrRedemptionDto, {
        tokenAmount: 0.05,
      });
      const errorsUnder = await validate(dtoUnder);
      expect(errorsUnder.some((e) => e.property === 'tokenAmount')).toBe(true);

      const dtoMicro = plainToInstance(CreateQrRedemptionDto, {
        tokenAmount: 0.000004,
      });
      const errorsMicro = await validate(dtoMicro);
      expect(errorsMicro.some((e) => e.property === 'tokenAmount')).toBe(true);

      const dtoDecimals = plainToInstance(CreateQrRedemptionDto, {
        tokenAmount: 15.555,
      });
      const errorsDecimals = await validate(dtoDecimals);
      expect(errorsDecimals.some((e) => e.property === 'tokenAmount')).toBe(true);
    });

    it('should ACCEPT POS charge of 0.10 ECO or higher with max 2 decimals', async () => {
      const dtoMin = plainToInstance(CreateQrRedemptionDto, {
        tokenAmount: 0.10,
      });
      const errorsMin = await validate(dtoMin);
      expect(errorsMin.length).toBe(0);

      const dtoStandard = plainToInstance(CreateQrRedemptionDto, {
        tokenAmount: 25.50,
      });
      const errorsStandard = await validate(dtoStandard);
      expect(errorsStandard.length).toBe(0);
    });
  });

  describe('CreateTransactionDto & CreateSaleDto', () => {
    it('should REJECT wallet transfer under 0.10 ECO or >2 decimals', async () => {
      const dto = plainToInstance(CreateTransactionDto, {
        toAddress: 'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
        amount: 0.05,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    });

    it('should REJECT B2B sales with weight < 0.5 kg or amount < 0.10', async () => {
      const dto = plainToInstance(CreateSaleDto, {
        materialType: 'PET',
        weightKg: 0.2,
        totalAmount: 0.05,
        buyerId: '123e4567-e89b-12d3-a456-426614174000',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'weightKg')).toBe(true);
      expect(errors.some((e) => e.property === 'totalAmount')).toBe(true);
    });
  });
});

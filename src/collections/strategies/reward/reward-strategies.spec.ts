import { StandardRewardStrategy } from './standard-reward.strategy';
import { DonationRewardStrategy } from './donation-reward.strategy';
import { RewardCalculatorFactory } from '../../factories/reward-calculator.factory';

describe('Patrón Estrategia & Factory Method de Recompensas (PUCP Disoft Diapositivas 04 y 06)', () => {
  let factory: RewardCalculatorFactory;

  beforeEach(() => {
    factory = new RewardCalculatorFactory();
  });

  describe('RewardCalculatorFactory (Factory Method)', () => {
    it('debe devolver StandardRewardStrategy si isDonation es false', () => {
      const strategy = factory.getStrategy(false);
      expect(strategy).toBeInstanceOf(StandardRewardStrategy);
    });

    it('debe devolver DonationRewardStrategy si isDonation es true', () => {
      const strategy = factory.getStrategy(true);
      expect(strategy).toBeInstanceOf(DonationRewardStrategy);
    });
  });

  describe('StandardRewardStrategy (Strategy Pattern)', () => {
    const strategy = new StandardRewardStrategy();

    it('debe calcular correctamente los montos proporcionales (25% hogar, 5% tesorería, 70% escrow)', () => {
      const weights = { PLASTIC_PET: 10, CARTON: 20 };
      const rates = { PLASTIC_PET: 2.0, CARTON: 1.0 }; // Total = 10*2 + 20*1 = 40

      const result = strategy.calculate(weights, rates, false);

      expect(result.totalEstimatedValue).toBe(40.0);
      expect(result.householdAmount).toBe(10.0); // 25% de 40
      expect(result.treasuryAmount).toBe(2.0); // 5% de 40
      expect(result.requiredEscrow).toBe(28.0); // 70% de 40
      expect(result.breakdown['PLASTIC_PET'].subtotal).toBe(20.0);
      expect(result.breakdown['CARTON'].subtotal).toBe(20.0);
    });

    it('debe manejar pesos y tarifas no provistas usando valores defensivos', () => {
      const weights = { GLASS: 5 };
      const rates = {}; // Sin tarifa pactada -> fallback 1.0

      const result = strategy.calculate(weights, rates, false);
      expect(result.totalEstimatedValue).toBe(5.0);
      expect(result.householdAmount).toBe(1.25);
    });
  });

  describe('DonationRewardStrategy (Strategy Pattern)', () => {
    const strategy = new DonationRewardStrategy();

    it('debe asignar 0.00 LIVOs al hogar y 0.00 escrow requerido en modalidad donación', () => {
      const weights = { METAL: 10 };
      const rates = { METAL: 5.0 }; // Total = 50.0

      const result = strategy.calculate(weights, rates, true);

      expect(result.totalEstimatedValue).toBe(50.0);
      expect(result.householdAmount).toBe(0.0);
      expect(result.requiredEscrow).toBe(0.0);
      expect(result.treasuryAmount).toBe(0.0);
    });
  });
});

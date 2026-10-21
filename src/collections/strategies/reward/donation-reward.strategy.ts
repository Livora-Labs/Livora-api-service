import {
  IRewardCalculationResult,
  IRewardCalculationStrategy,
} from './reward-calculation.strategy.interface';

/**
 * Estrategia de Donación Social/Ecológica (PUCP Disoft - Strategy Pattern)
 * Cuando el Hogar elige donar sus materiales reciclables:
 * - Hogar: 0.00 LIVOs (impacto ambiental registrado 100% como donación)
 * - Escrow para el recolector: 0.00 (incentiva al recolector sin bloquear capital)
 * - Tesorería: 0.00 tarifa
 */
export class DonationRewardStrategy implements IRewardCalculationStrategy {
  calculate(
    weights: Record<string, number>,
    agreedRates: Record<string, number>,
    _isDonation?: boolean,
  ): IRewardCalculationResult {
    let totalEstimatedValue = 0;
    const breakdown: Record<
      string,
      { weight: number; rate: number; subtotal: number }
    > = {};

    for (const [mat, rawWeight] of Object.entries(weights || {})) {
      const weight =
        typeof rawWeight === 'number'
          ? rawWeight
          : parseFloat(String(rawWeight)) || 0;
      const rate = agreedRates?.[mat] || agreedRates?.[mat.toUpperCase()] || 1.0;
      const subtotal = weight * rate;
      totalEstimatedValue += subtotal;

      breakdown[mat] = {
        weight,
        rate,
        subtotal: parseFloat(subtotal.toFixed(4)),
      };
    }

    return {
      totalEstimatedValue: parseFloat(totalEstimatedValue.toFixed(4)),
      householdAmount: 0.0,
      treasuryAmount: 0.0,
      requiredEscrow: 0.0,
      breakdown,
    };
  }
}

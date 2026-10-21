import {
  IRewardCalculationResult,
  IRewardCalculationStrategy,
} from './reward-calculation.strategy.interface';

/**
 * Estrategia Estándar de Recompensa Ecológica (PUCP Disoft - Strategy Pattern)
 * Calcula el valor base según los pesos reales y los tarifarios pactados con el Centro de Acopio.
 * - Hogar: 25% del valor real en LIVOs
 * - Tesorería de Livora: 5% de tarifa operativa
 * - Escrow requerido: 70% del valor estimado total
 */
export class StandardRewardStrategy implements IRewardCalculationStrategy {
  calculate(
    weights: Record<string, number>,
    agreedRates: Record<string, number>,
    isDonation: boolean = false,
  ): IRewardCalculationResult {
    let totalActualValue = 0;
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
      totalActualValue += subtotal;

      breakdown[mat] = {
        weight,
        rate,
        subtotal: parseFloat(subtotal.toFixed(4)),
      };
    }

    const householdAmount = isDonation
      ? 0.0
      : parseFloat((totalActualValue * 0.25).toFixed(2));
    const treasuryAmount = parseFloat((totalActualValue * 0.05).toFixed(2));
    const requiredEscrow = parseFloat((totalActualValue * 0.7).toFixed(2));

    return {
      totalEstimatedValue: parseFloat(totalActualValue.toFixed(4)),
      householdAmount,
      treasuryAmount,
      requiredEscrow,
      breakdown,
    };
  }
}

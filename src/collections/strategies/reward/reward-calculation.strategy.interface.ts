/**
 * Patrón Estrategia (Strategy Pattern) - PUCP Disoft Diapositiva 06
 * Define la familia de algoritmos para el cálculo de incentivos, garantías y recompensas ecológicas.
 */

export interface IRewardCalculationResult {
  totalEstimatedValue: number;
  householdAmount: number;
  treasuryAmount: number;
  requiredEscrow: number;
  breakdown: Record<string, { weight: number; rate: number; subtotal: number }>;
}

export interface IRewardCalculationStrategy {
  calculate(
    weights: Record<string, number>,
    agreedRates: Record<string, number>,
    isDonation?: boolean,
  ): IRewardCalculationResult;
}

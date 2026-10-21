import { Injectable } from '@nestjs/common';
import { IRewardCalculationStrategy } from '../strategies/reward/reward-calculation.strategy.interface';
import { StandardRewardStrategy } from '../strategies/reward/standard-reward.strategy';
import { DonationRewardStrategy } from '../strategies/reward/donation-reward.strategy';

export enum RewardStrategyType {
  STANDARD = 'STANDARD',
  DONATION = 'DONATION',
}

/**
 * Patrón Factory Method (PUCP Disoft Diapositiva 04)
 * Desacopla la selección e instanciación de la estrategia de cálculo de recompensas ecológicas.
 */
@Injectable()
export class RewardCalculatorFactory {
  private readonly strategies: Map<RewardStrategyType, IRewardCalculationStrategy> = new Map();

  constructor() {
    this.strategies.set(RewardStrategyType.STANDARD, new StandardRewardStrategy());
    this.strategies.set(RewardStrategyType.DONATION, new DonationRewardStrategy());
  }

  /**
   * Factory Method para resolver la estrategia adecuada según el contexto de negocio
   */
  public getStrategy(isDonation: boolean = false): IRewardCalculationStrategy {
    if (isDonation) {
      return this.strategies.get(RewardStrategyType.DONATION)!;
    }
    return this.strategies.get(RewardStrategyType.STANDARD)!;
  }
}

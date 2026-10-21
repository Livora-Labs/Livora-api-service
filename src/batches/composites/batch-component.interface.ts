/**
 * Patrón Compuesto (Composite Pattern) - PUCP Disoft Diapositiva 05
 * Permite tratar de manera homogénea a lotes individuales y lotes industriales consolidados.
 */
export interface IBatchComponent {
  getId(): string;
  getTotalWeightKg(): number;
  getMaterialsBreakdown(): Record<string, number>;
  getBatchCount(): number;
}

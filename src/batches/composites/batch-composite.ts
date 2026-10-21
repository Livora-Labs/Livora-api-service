import { IBatchComponent } from './batch-component.interface';

/**
 * Componente Hoja (Leaf) del Patrón Composite - PUCP Disoft Diapositiva 05
 * Representa un lote unitario entregado por un recolector.
 */
export class BatchLeaf implements IBatchComponent {
  constructor(
    private readonly id: string,
    private readonly materials: Record<string, number>,
  ) {}

  getId(): string {
    return this.id;
  }

  getTotalWeightKg(): number {
    return Object.values(this.materials).reduce(
      (sum, val) => sum + (Number(val) || 0),
      0,
    );
  }

  getMaterialsBreakdown(): Record<string, number> {
    return { ...this.materials };
  }

  getBatchCount(): number {
    return 1;
  }
}

/**
 * Componente Compuesto (Composite) del Patrón Composite - PUCP Disoft Diapositiva 05
 * Agrega jerárquicamente múltiples lotes en un macro-lote consolidado para venta B2B.
 */
export class ConsolidatedBatchComposite implements IBatchComponent {
  private readonly children: IBatchComponent[] = [];

  constructor(private readonly id: string) {}

  getId(): string {
    return this.id;
  }

  add(component: IBatchComponent): this {
    this.children.push(component);
    return this;
  }

  remove(componentId: string): void {
    const idx = this.children.findIndex((c) => c.getId() === componentId);
    if (idx !== -1) {
      this.children.splice(idx, 1);
    }
  }

  getChildren(): IBatchComponent[] {
    return [...this.children];
  }

  getTotalWeightKg(): number {
    return parseFloat(
      this.children
        .reduce((sum, child) => sum + child.getTotalWeightKg(), 0)
        .toFixed(3),
    );
  }

  getMaterialsBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = {};

    for (const child of this.children) {
      const childMaterials = child.getMaterialsBreakdown();
      for (const [mat, weight] of Object.entries(childMaterials)) {
        breakdown[mat] = parseFloat(
          ((breakdown[mat] || 0) + (Number(weight) || 0)).toFixed(3),
        );
      }
    }

    return breakdown;
  }

  getBatchCount(): number {
    return this.children.reduce((sum, child) => sum + child.getBatchCount(), 0);
  }
}

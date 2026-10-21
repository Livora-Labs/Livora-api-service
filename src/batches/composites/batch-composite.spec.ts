import { BatchLeaf, ConsolidatedBatchComposite } from './batch-composite';

describe('Patrón Compuesto: ConsolidatedBatchComposite (PUCP Disoft Diapositiva 05)', () => {
  it('debe calcular el peso total de un lote hoja unitario', () => {
    const leaf = new BatchLeaf('batch-01', {
      PLASTIC_PET: 15.5,
      CARTON: 20.0,
    });

    expect(leaf.getId()).toBe('batch-01');
    expect(leaf.getTotalWeightKg()).toBe(35.5);
    expect(leaf.getBatchCount()).toBe(1);
    expect(leaf.getMaterialsBreakdown()).toEqual({
      PLASTIC_PET: 15.5,
      CARTON: 20.0,
    });
  });

  it('debe agregar recursivamente múltiples lotes en un macro-lote consolidado', () => {
    const leaf1 = new BatchLeaf('batch-01', {
      PLASTIC_PET: 10.0,
      GLASS: 5.0,
    });
    const leaf2 = new BatchLeaf('batch-02', {
      PLASTIC_PET: 15.5,
      CARTON: 30.0,
    });
    const leaf3 = new BatchLeaf('batch-03', {
      GLASS: 12.0,
      METAL: 8.5,
    });

    const consolidated = new ConsolidatedBatchComposite('consolidated-macro-999');
    consolidated.add(leaf1).add(leaf2).add(leaf3);

    expect(consolidated.getId()).toBe('consolidated-macro-999');
    expect(consolidated.getBatchCount()).toBe(3);
    expect(consolidated.getTotalWeightKg()).toBe(81.0); // 15 + 45.5 + 20.5 = 81.0

    const breakdown = consolidated.getMaterialsBreakdown();
    expect(breakdown['PLASTIC_PET']).toBe(25.5); // 10.0 + 15.5
    expect(breakdown['GLASS']).toBe(17.0); // 5.0 + 12.0
    expect(breakdown['CARTON']).toBe(30.0);
    expect(breakdown['METAL']).toBe(8.5);
  });

  it('debe permitir remover un lote componente del consolidado', () => {
    const leaf1 = new BatchLeaf('batch-01', { PLASTIC_PET: 10 });
    const leaf2 = new BatchLeaf('batch-02', { PLASTIC_PET: 20 });

    const consolidated = new ConsolidatedBatchComposite('cons-01');
    consolidated.add(leaf1).add(leaf2);

    expect(consolidated.getBatchCount()).toBe(2);
    consolidated.remove('batch-01');

    expect(consolidated.getBatchCount()).toBe(1);
    expect(consolidated.getTotalWeightKg()).toBe(20);
  });
});

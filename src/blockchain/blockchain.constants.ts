export const BLOCKCHAIN_QUEUE = 'blockchain-queue';


/**
 * Normaliza un nombre de material al código ASCII que espera el contrato:
 * mayúsculas, sin acentos ni espacios ("Cartón" -> "CARTON").
 */
export function normalizeMaterialCode(material: string): string {
  return material.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}

export const MATERIAL_RATES: Record<string, number> = {
  PET: 10,
  CARTON: 5,
  CARTÓN: 5,
  VIDRIO: 3,
  PLASTICO: 10,
  PLÁSTICO: 10,
  ALUMINIO: 15,
  TETRAPAK: 4,
  PAPEL: 5,
};

export const DEFAULT_MATERIAL_RATE = 5;

export const DUMMY_IPFS_HASH = 'QmDummyIpfsHashForTestingPurposesOnly123456';

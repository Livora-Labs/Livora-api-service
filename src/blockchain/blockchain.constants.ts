export const BLOCKCHAIN_QUEUE = 'blockchain-queue';

export const ECO_BATCH_REGISTRY_ABI = [
  'function registerBatch(bytes32 batchId, string ipfsCid, address[] recipients, uint256[] amounts) external returns (bool)',
  'function registerBatchWeighed(bytes32 batchId, string ipfsCid, address collector, address[] households, bytes32[] materialCodes, uint256[] weightsGrams) external returns (bool)',
  'function isBatchProcessed(bytes32 batchId) external view returns (bool)',
  'function materialRate(bytes32 materialCode) external view returns (uint256)',
  'function collectorShare() external view returns (uint256)',
  'event BatchRegistered(bytes32 indexed batchId, string ipfsCid, address indexed worker, uint256 totalReward, uint32 recipientsCount, uint64 timestamp)',
  'event BatchWeighed(bytes32 indexed batchId, uint256 totalWeightGrams, uint256 totalReward, uint256 collectorReward, uint32 householdsCount)',
];

/**
 * Normaliza un nombre de material al código ASCII que espera el contrato:
 * mayúsculas, sin acentos ni espacios ("Cartón" -> "CARTON").
 */
export function normalizeMaterialCode(material: string): string {
  return material
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
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

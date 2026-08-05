export const BLOCKCHAIN_QUEUE = 'blockchain-queue';

export const ECO_BATCH_REGISTRY_ABI = [
  'function registerBatch(bytes32 batchId, string ipfsCid, address[] recipients, uint256[] amounts) external returns (bool)',
  'function isBatchProcessed(bytes32 batchId) external view returns (bool)',
  'event BatchRegistered(bytes32 indexed batchId, string ipfsCid, address indexed worker, uint256 totalReward, uint32 recipientsCount, uint64 timestamp)',
];


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

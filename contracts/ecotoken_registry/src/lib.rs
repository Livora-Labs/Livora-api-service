#![cfg_attr(not(feature = "export-abi"), no_main)]
extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use stylus_sdk::alloy_primitives::{Address, U256, B256, U64, U32};
use stylus_sdk::alloy_sol_types::{sol, SolError};
use stylus_sdk::{block, evm, msg, prelude::*};

sol! {
    // --- Events ---
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event BatchRegistered(
        bytes32 indexed batch_id,
        string ipfs_cid,
        address indexed worker,
        uint256 total_reward,
        uint32 recipients_count,
        uint64 timestamp
    );
    event WorkerUpdated(address indexed old_worker, address indexed new_worker);
    event MaterialRateUpdated(bytes32 indexed material_code, uint256 rate_wei_per_kg);
    event BatchWeighed(
        bytes32 indexed batch_id,
        uint256 total_weight_grams,
        uint256 total_reward,
        uint256 collector_reward,
        uint32 households_count
    );

    // --- Custom Errors ---
    error Unauthorized(address caller);
    error BatchAlreadyExists(bytes32 batch_id);
    error InvalidBatchId();
    error InvalidInputLength();
    error InvalidRecipient();
    error ZeroAmount();
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 needed);
}

sol_storage! {
    #[entrypoint]
    pub struct EcoBatchRegistry {
        address owner;
        address worker_address;

        uint256 total_supply;
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;

        mapping(bytes32 => bool) processed_batches;
        mapping(bytes32 => uint64) batch_timestamps;
        mapping(bytes32 => uint256) batch_total_rewards;
        mapping(bytes32 => uint32) batch_recipients_counts;

        // On-chain incentive economics (wei ECO per kg, keyed by ASCII bytes32 code)
        mapping(bytes32 => uint256) material_rates;
        uint256 default_rate;
        uint256 collector_share_bps;
    }
}

/// 1 ECO = 1e18 wei
const ONE_ECO: u64 = 1_000_000_000_000_000_000;
/// Basis points denominator (10000 = 100%)
const BPS_DENOMINATOR: u64 = 10_000;

#[public]
impl EcoBatchRegistry {
    /// Initialize owner and worker_address upon deployment.
    pub fn init(&mut self, worker: Address) -> Result<(), Vec<u8>> {
        if self.owner.get() != Address::ZERO {
            return Ok(());
        }
        let sender = msg::sender();
        self.owner.set(sender);
        self.worker_address.set(worker);

        // Seed incentive economics: rates in wei ECO per kg
        let eco = U256::from(ONE_ECO);
        self.default_rate.set(U256::from(5u64) * eco);
        self.collector_share_bps.set(U256::from(2_000u64)); // 20% collector / 80% households
        let presets: [(&[u8], u64); 7] = [
            (b"PET", 10),
            (b"CARTON", 5),
            (b"VIDRIO", 3),
            (b"PLASTICO", 10),
            (b"ALUMINIO", 15),
            (b"TETRAPAK", 4),
            (b"PAPEL", 5),
        ];
        for (name, rate) in presets {
            let code = Self::material_code(name);
            let rate_wei = U256::from(rate) * eco;
            self.material_rates.insert(code, rate_wei);
            evm::log(MaterialRateUpdated {
                material_code: code,
                rate_wei_per_kg: rate_wei,
            });
        }

        evm::log(WorkerUpdated {
            old_worker: Address::ZERO,
            new_worker: worker,
        });
        Ok(())
    }

    /// Update the authorized worker address.
    pub fn set_worker(&mut self, new_worker: Address) -> Result<(), Vec<u8>> {
        let sender = msg::sender();
        if sender != self.owner.get() && sender != self.worker_address.get() {
            return Err(Unauthorized { caller: sender }.abi_encode());
        }
        if new_worker == Address::ZERO {
            return Err(InvalidRecipient {}.abi_encode());
        }
        let old_worker = self.worker_address.get();
        self.worker_address.set(new_worker);
        evm::log(WorkerUpdated { old_worker, new_worker });
        Ok(())
    }

    /// View owner address.
    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// View authorized worker backend address.
    pub fn worker_address(&self) -> Address {
        self.worker_address.get()
    }

    // --- ERC-20 Standard Metadata & Operations ---

    pub fn name(&self) -> String {
        String::from("EcoToken")
    }

    pub fn symbol(&self) -> String {
        String::from("ECO")
    }

    pub fn decimals(&self) -> u8 {
        18
    }

    pub fn total_supply(&self) -> U256 {
        self.total_supply.get()
    }

    pub fn balance_of(&self, account: Address) -> U256 {
        self.balances.get(account)
    }

    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.get(owner).get(spender)
    }

    pub fn transfer(&mut self, to: Address, amount: U256) -> Result<bool, Vec<u8>> {
        let sender = msg::sender();
        self.internal_transfer(sender, to, amount)?;
        Ok(true)
    }

    pub fn approve(&mut self, spender: Address, amount: U256) -> Result<bool, Vec<u8>> {
        let owner = msg::sender();
        self.allowances.setter(owner).insert(spender, amount);
        evm::log(Approval { owner, spender, value: amount });
        Ok(true)
    }

    pub fn transfer_from(&mut self, from: Address, to: Address, amount: U256) -> Result<bool, Vec<u8>> {
        let spender = msg::sender();
        let current_allowance = self.allowances.get(from).get(spender);
        if current_allowance < amount {
            return Err(InsufficientAllowance {
                owner: from,
                spender,
                allowance: current_allowance,
                needed: amount,
            }.abi_encode());
        }
        self.allowances.setter(from).insert(spender, current_allowance - amount);
        self.internal_transfer(from, to, amount)?;
        Ok(true)
    }

    /// Direct minting restricted to authorized worker_address or owner.
    pub fn mint(&mut self, to: Address, amount: U256) -> Result<bool, Vec<u8>> {
        self.require_worker_or_owner()?;
        if to == Address::ZERO {
            return Err(InvalidRecipient {}.abi_encode());
        }
        if amount == U256::ZERO {
            return Err(ZeroAmount {}.abi_encode());
        }
        self.internal_mint(to, amount);
        Ok(true)
    }

    // --- BatchRegistry (Traceability & Vectorized Minting) ---

    /// Registers a consolidated batch and distributes rewards to multiple recipients
    /// (e.g. households and collector) in a single atomic transaction.
    pub fn register_batch(
        &mut self,
        batch_id: B256,
        ipfs_cid: String,
        recipients: Vec<Address>,
        amounts: Vec<U256>,
    ) -> Result<bool, Vec<u8>> {
        // 1. Role-Based Access Control: Worker or Owner only
        self.require_worker_or_owner()?;

        // 2. Idempotency Check: Revert if batch_id already registered
        if self.processed_batches.get(batch_id) {
            return Err(BatchAlreadyExists { batch_id }.abi_encode());
        }
        if batch_id == B256::ZERO {
            return Err(InvalidBatchId {}.abi_encode());
        }

        // 3. Validation: Recipient & amount arrays must match and not be empty
        if recipients.len() != amounts.len() || recipients.is_empty() {
            return Err(InvalidInputLength {}.abi_encode());
        }

        // 4. Atomic Vector Minting & Reward Distribution
        let mut total_batch_reward = U256::ZERO;
        let now = block::timestamp();

        for i in 0..recipients.len() {
            let recipient = recipients[i];
            let amount = amounts[i];

            if recipient == Address::ZERO {
                return Err(InvalidRecipient {}.abi_encode());
            }
            if amount == U256::ZERO {
                return Err(ZeroAmount {}.abi_encode());
            }

            self.internal_mint(recipient, amount);
            total_batch_reward += amount;
        }

        // 5. Store Traceability Record
        self.processed_batches.insert(batch_id, true);
        self.batch_timestamps.insert(batch_id, U64::from(now));
        self.batch_total_rewards.insert(batch_id, total_batch_reward);
        self.batch_recipients_counts.insert(batch_id, U32::from(recipients.len()));

        // 6. Emit BatchRegistered Log
        evm::log(BatchRegistered {
            batch_id,
            ipfs_cid,
            worker: msg::sender(),
            total_reward: total_batch_reward,
            recipients_count: recipients.len() as u32,
            timestamp: now,
        });

        Ok(true)
    }

    /// Registers a batch from raw material weights: the CONTRACT computes the
    /// rewards on-chain (rate per material × weight, then 80/20 split), so the
    /// backend can no longer dictate arbitrary mint amounts — token issuance is
    /// verifiably derived from the weighed materials anchored in the IPFS manifest.
    ///
    /// * `material_codes` — ASCII bytes32 codes (e.g. "PET"), normalized uppercase without accents.
    /// * `weights_grams`  — integer weights in grams (kg × 1000), parallel to `material_codes`.
    pub fn register_batch_weighed(
        &mut self,
        batch_id: B256,
        ipfs_cid: String,
        collector: Address,
        households: Vec<Address>,
        material_codes: Vec<B256>,
        weights_grams: Vec<U256>,
    ) -> Result<bool, Vec<u8>> {
        // 1. Access control + idempotency (same 3-layer guarantee as register_batch)
        self.require_worker_or_owner()?;
        if self.processed_batches.get(batch_id) {
            return Err(BatchAlreadyExists { batch_id }.abi_encode());
        }
        if batch_id == B256::ZERO {
            return Err(InvalidBatchId {}.abi_encode());
        }
        if collector == Address::ZERO {
            return Err(InvalidRecipient {}.abi_encode());
        }
        if material_codes.len() != weights_grams.len() || material_codes.is_empty() {
            return Err(InvalidInputLength {}.abi_encode());
        }

        // 2. On-chain incentive math: total = Σ weight_g × rate_wei_per_kg / 1000
        let grams_per_kg = U256::from(1_000u64);
        let mut total_reward = U256::ZERO;
        let mut total_weight_grams = U256::ZERO;
        for i in 0..material_codes.len() {
            let weight = weights_grams[i];
            if weight == U256::ZERO {
                return Err(ZeroAmount {}.abi_encode());
            }
            let rate = self.effective_rate(material_codes[i]);
            total_reward += weight * rate / grams_per_kg;
            total_weight_grams += weight;
        }
        if total_reward == U256::ZERO {
            return Err(ZeroAmount {}.abi_encode());
        }

        // 3. Distribution: collector takes `collector_share_bps`; households split the
        //    rest equally; rounding dust goes to the collector so supply is conserved.
        //    With no households the collector receives 100% (defensive edge case).
        let households_count = households.len();
        let mut collector_reward = total_reward;
        let mut per_household = U256::ZERO;
        if households_count > 0 {
            collector_reward =
                total_reward * self.collector_share_bps.get() / U256::from(BPS_DENOMINATOR);
            let households_total = total_reward - collector_reward;
            per_household = households_total / U256::from(households_count as u64);
            collector_reward +=
                households_total - per_household * U256::from(households_count as u64);
        }

        // 4. Atomic vectorized minting
        let now = block::timestamp();
        if per_household > U256::ZERO {
            for household in households.iter() {
                if *household == Address::ZERO {
                    return Err(InvalidRecipient {}.abi_encode());
                }
                self.internal_mint(*household, per_household);
            }
        }
        if collector_reward > U256::ZERO {
            self.internal_mint(collector, collector_reward);
        }

        // 5. Traceability record (collector + households)
        let recipients_count = (households_count as u32) + 1;
        self.processed_batches.insert(batch_id, true);
        self.batch_timestamps.insert(batch_id, U64::from(now));
        self.batch_total_rewards.insert(batch_id, total_reward);
        self.batch_recipients_counts.insert(batch_id, U32::from(recipients_count));

        // 6. On-chain audit trail
        evm::log(BatchWeighed {
            batch_id,
            total_weight_grams,
            total_reward,
            collector_reward,
            households_count: households_count as u32,
        });
        evm::log(BatchRegistered {
            batch_id,
            ipfs_cid,
            worker: msg::sender(),
            total_reward,
            recipients_count,
            timestamp: now,
        });

        Ok(true)
    }

    // --- On-chain incentive economics (owner/worker governed) ---

    /// Set the reward rate (wei ECO per kg) for a material code.
    pub fn set_material_rate(&mut self, material_code: B256, rate_wei_per_kg: U256) -> Result<(), Vec<u8>> {
        self.require_worker_or_owner()?;
        self.material_rates.insert(material_code, rate_wei_per_kg);
        evm::log(MaterialRateUpdated { material_code, rate_wei_per_kg });
        Ok(())
    }

    /// Set the fallback rate for uncatalogued materials.
    pub fn set_default_rate(&mut self, rate_wei_per_kg: U256) -> Result<(), Vec<u8>> {
        self.require_worker_or_owner()?;
        self.default_rate.set(rate_wei_per_kg);
        Ok(())
    }

    /// Set the collector share in basis points (2000 = 20%).
    pub fn set_collector_share_bps(&mut self, bps: U256) -> Result<(), Vec<u8>> {
        self.require_worker_or_owner()?;
        if bps > U256::from(BPS_DENOMINATOR) {
            return Err(InvalidInputLength {}.abi_encode());
        }
        self.collector_share_bps.set(bps);
        Ok(())
    }

    /// Effective rate (wei ECO per kg) for a material code; falls back to default_rate.
    pub fn material_rate(&self, material_code: B256) -> U256 {
        self.effective_rate(material_code)
    }

    /// Current collector share in basis points.
    pub fn collector_share(&self) -> U256 {
        self.collector_share_bps.get()
    }

    /// Check if a batch_id has already been processed.
    pub fn is_batch_processed(&self, batch_id: B256) -> bool {
        self.processed_batches.get(batch_id)
    }

    /// Get details for a registered batch.
    pub fn get_batch(&self, batch_id: B256) -> (u64, U256, u32, bool) {
        let processed = self.processed_batches.get(batch_id);
        if !processed {
            return (0, U256::ZERO, 0, false);
        }
        let ts = self.batch_timestamps.get(batch_id).to::<u64>();
        let total = self.batch_total_rewards.get(batch_id);
        let count = self.batch_recipients_counts.get(batch_id).to::<u32>();

        (ts, total, count, true)
    }
}

// --- Internal Helper Functions ---
impl EcoBatchRegistry {
    /// ASCII name → bytes32 code (left-aligned, zero-padded), matching
    /// ethers.encodeBytes32String on the backend side.
    fn material_code(name: &[u8]) -> B256 {
        let mut buf = [0u8; 32];
        let n = name.len().min(32);
        buf[..n].copy_from_slice(&name[..n]);
        B256::from(buf)
    }

    fn effective_rate(&self, code: B256) -> U256 {
        let stored = self.material_rates.get(code);
        if stored == U256::ZERO {
            self.default_rate.get()
        } else {
            stored
        }
    }

    fn require_worker_or_owner(&self) -> Result<(), Vec<u8>> {
        let sender = msg::sender();
        let worker = self.worker_address.get();
        let owner = self.owner.get();
        if sender != worker && sender != owner {
            return Err(Unauthorized { caller: sender }.abi_encode());
        }
        Ok(())
    }

    fn internal_mint(&mut self, to: Address, amount: U256) {
        let new_supply = self.total_supply.get() + amount;
        self.total_supply.set(new_supply);

        let current_bal = self.balances.get(to);
        self.balances.insert(to, current_bal + amount);

        evm::log(Transfer {
            from: Address::ZERO,
            to,
            value: amount,
        });
    }

    fn internal_transfer(&mut self, from: Address, to: Address, amount: U256) -> Result<(), Vec<u8>> {
        if to == Address::ZERO {
            return Err(InvalidRecipient {}.abi_encode());
        }
        let sender_bal = self.balances.get(from);
        if sender_bal < amount {
            return Err(InsufficientBalance {
                account: from,
                balance: sender_bal,
                needed: amount,
            }.abi_encode());
        }
        self.balances.insert(from, sender_bal - amount);
        let recipient_bal = self.balances.get(to);
        self.balances.insert(to, recipient_bal + amount);

        evm::log(Transfer { from, to, value: amount });
        Ok(())
    }
}

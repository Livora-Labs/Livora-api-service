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
    }
}

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

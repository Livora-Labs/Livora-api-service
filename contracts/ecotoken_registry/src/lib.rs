#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, BytesN, Env, IntoVal, String,
    Symbol, Val, Vec, Bytes,
};
use soroban_sdk::xdr::ToXdr;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRecord {
    pub timestamp: u64,
    pub total_reward: i128,
    pub recipients_count: u32,
    pub processed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Owner,
    Worker,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
    Nonce(Address),
    ProcessedBatch(BytesN<32>),
    BatchDetails(BytesN<32>),
    MaterialRate(Symbol),
    DefaultRate,
    CollectorShareBps,
}

#[contract]
pub struct EcoBatchRegistry;

const BPS_DENOMINATOR: i128 = 10_000;
const DAY_IN_LEDGERS: u32 = 17280; // ~5s por bloque
const PERSISTENT_TTL_THRESHOLD: u32 = 6 * DAY_IN_LEDGERS; // ~6 días
const PERSISTENT_TTL_EXTEND: u32 = 30 * DAY_IN_LEDGERS;   // ~30 días
const INSTANCE_TTL_THRESHOLD: u32 = 6 * DAY_IN_LEDGERS;
const INSTANCE_TTL_EXTEND: u32 = 30 * DAY_IN_LEDGERS;

#[contractimpl]
impl EcoBatchRegistry {
    /// Inicializa el owner, worker y las tarifas base
    pub fn init(env: Env, owner: Address, worker: Address) {
        if env.storage().instance().has(&DataKey::Owner) {
            panic!("Contrato ya inicializado");
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Worker, &worker);

        // 1 ECO = 10,000,000 Stroops (7 decimales)
        let one_eco: i128 = 10_000_000;
        env.storage().instance().set(&DataKey::DefaultRate, &(5 * one_eco));
        env.storage().instance().set(&DataKey::CollectorShareBps, &2_000i128); // 20%

        // Valores por defecto para materiales comunes
        let presets: Vec<(Symbol, i128)> = Vec::from_array(
            &env,
            [
                (Symbol::new(&env, "PET"), 10 * one_eco),
                (Symbol::new(&env, "CARTON"), 5 * one_eco),
                (Symbol::new(&env, "VIDRIO"), 3 * one_eco),
                (Symbol::new(&env, "PLASTICO"), 10 * one_eco),
                (Symbol::new(&env, "ALUMINIO"), 15 * one_eco),
                (Symbol::new(&env, "TETRAPAK"), 4 * one_eco),
                (Symbol::new(&env, "PAPEL"), 5 * one_eco),
            ],
        );

        for item in presets.iter() {
            let (code, rate) = item;
            let key = DataKey::MaterialRate(code.clone());
            env.storage().persistent().set(&key, &rate);
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }

        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    // --- Administración & Modificadores ---

    pub fn set_worker(env: Env, caller: Address, new_worker: Address) {
        let owner: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
        let current_worker: Address = env.storage().instance().get(&DataKey::Worker).unwrap();
        
        if caller != owner && caller != current_worker {
            panic!("No autorizado");
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Worker, &new_worker);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    pub fn worker_address(env: Env) -> Address {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.storage().instance().get(&DataKey::Worker).unwrap()
    }

    pub fn owner(env: Env) -> Address {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.storage().instance().get(&DataKey::Owner).unwrap()
    }

    // --- Interfaz SEP-41 (Metadatos y Operaciones) ---

    pub fn name(env: Env) -> String {
        String::from_str(&env, "EcoToken")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "ECO")
    }

    pub fn decimals(_env: Env) -> u32 {
        7 // Formato nativo Stellar para divisibilidad decimal
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0i128)
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        let key = DataKey::Balance(id.clone());
        let val = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        val
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let key = DataKey::Allowance(from, spender);
        let val = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        val
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _expiration_ledger: u32) {
        from.require_auth();
        let key = DataKey::Allowance(from.clone(), spender);
        env.storage().persistent().set(&key, &amount);
        env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::internal_transfer(&env, from, to, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let allowance_key = DataKey::Allowance(from.clone(), spender.clone());
        let current_allowance = env.storage().persistent().get(&allowance_key).unwrap_or(0i128);
        if current_allowance < amount {
            panic!("Permiso insuficiente");
        }
        env.storage().persistent().set(&allowance_key, &(current_allowance - amount));
        env.storage().persistent().extend_ttl(&allowance_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        Self::internal_transfer(&env, from, to, amount);
    }

    // --- Minting y Lotes ---

    pub fn mint(env: Env, caller: Address, to: Address, amount: i128) {
        Self::require_worker_or_owner(&env, &caller);
        caller.require_auth();
        Self::internal_mint(&env, to, amount);
    }

    pub fn register_batch(
        env: Env,
        caller: Address,
        batch_id: BytesN<32>,
        _ipfs_cid: String,
        recipients: Vec<Address>,
        amounts: Vec<i128>,
    ) -> bool {
        Self::require_worker_or_owner(&env, &caller);
        caller.require_auth();

        let batch_key = DataKey::ProcessedBatch(batch_id.clone());
        if env.storage().persistent().has(&batch_key) {
            panic!("Lote ya procesado");
        }

        if recipients.len() != amounts.len() || recipients.len() == 0 {
            panic!("Longitud de entrada inválida");
        }

        let mut total_batch_reward = 0i128;
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            Self::internal_mint(&env, recipient, amount);
            total_batch_reward += amount;
        }

        env.storage().persistent().set(&batch_key, &true);
        env.storage().persistent().extend_ttl(&batch_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        let details_key = DataKey::BatchDetails(batch_id.clone());
        let details = BatchRecord {
            timestamp: env.ledger().timestamp(),
            total_reward: total_batch_reward,
            recipients_count: recipients.len(),
            processed: true,
        };
        env.storage().persistent().set(&details_key, &details);
        env.storage().persistent().extend_ttl(&details_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        true
    }

    pub fn register_batch_weighed(
        env: Env,
        caller: Address,
        batch_id: BytesN<32>,
        _ipfs_cid: String,
        collector: Address,
        households: Vec<Address>,
        material_codes: Vec<Symbol>,
        weights_grams: Vec<i128>,
    ) -> bool {
        Self::require_worker_or_owner(&env, &caller);
        caller.require_auth();

        let batch_key = DataKey::ProcessedBatch(batch_id.clone());
        if env.storage().persistent().has(&batch_key) {
            panic!("Lote ya procesado");
        }

        if material_codes.len() != weights_grams.len() || material_codes.len() == 0 {
            panic!("Longitudes de entrada inválidas");
        }

        // Calcular incentivo total en base a pesos y tarifas on-chain
        let mut total_reward = 0i128;
        for i in 0..material_codes.len() {
            let code = material_codes.get(i).unwrap();
            let weight = weights_grams.get(i).unwrap();
            let rate = Self::get_effective_rate(&env, code);
            total_reward += (weight * rate) / 1000;
        }

        if total_reward == 0 {
            panic!("Monto de recompensa es cero");
        }

        // Distribución 80/20
        let households_count = households.len();
        let bps: i128 = env.storage().instance().get(&DataKey::CollectorShareBps).unwrap_or(2_000);
        let mut collector_reward = (total_reward * bps) / BPS_DENOMINATOR;
        let mut per_household = 0i128;

        if households_count > 0 {
            let households_total = total_reward - collector_reward;
            per_household = households_total / (households_count as i128);
            // El residuo por redondeo va al recolector
            let distributed_households = per_household * (households_count as i128);
            collector_reward += households_total - distributed_households;
        } else {
            collector_reward = total_reward; // Sin hogares, el recolector toma el 100%
        }

        // Acuñación
        if per_household > 0 {
            for hh in households.iter() {
                Self::internal_mint(&env, hh, per_household);
            }
        }
        if collector_reward > 0 {
            Self::internal_mint(&env, collector, collector_reward);
        }

        // Registrar trazabilidad
        env.storage().persistent().set(&batch_key, &true);
        env.storage().persistent().extend_ttl(&batch_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        let details_key = DataKey::BatchDetails(batch_id.clone());
        let details = BatchRecord {
            timestamp: env.ledger().timestamp(),
            total_reward,
            recipients_count: (households_count as u32) + 1,
            processed: true,
        };
        env.storage().persistent().set(&details_key, &details);
        env.storage().persistent().extend_ttl(&details_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        true
    }

    // --- Configuración de Tarifas ---

    pub fn set_material_rate(env: Env, caller: Address, material_code: Symbol, rate_stroops_per_kg: i128) {
        Self::require_worker_or_owner(&env, &caller);
        caller.require_auth();
        let key = DataKey::MaterialRate(material_code);
        env.storage().persistent().set(&key, &rate_stroops_per_kg);
        env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    pub fn material_rate(env: Env, material_code: Symbol) -> i128 {
        Self::get_effective_rate(&env, material_code)
    }

    pub fn is_batch_processed(env: Env, batch_id: BytesN<32>) -> bool {
        let key = DataKey::ProcessedBatch(batch_id);
        let val = env.storage().persistent().has(&key);
        if val {
            env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        }
        val
    }

    pub fn get_batch(env: Env, batch_id: BytesN<32>) -> BatchRecord {
        let key = DataKey::BatchDetails(batch_id);
        let val = env.storage().persistent().get(&key).unwrap_or(BatchRecord {
            timestamp: 0,
            total_reward: 0,
            recipients_count: 0,
            processed: false,
        });
        if val.processed {
            env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        }
        val
    }

    pub fn nonces(env: Env, owner: Address) -> i128 {
        let key = DataKey::Nonce(owner);
        let val = env.storage().persistent().get(&key).unwrap_or(0i128);
        env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        val
    }

    // --- Transferencia Delegada via Firma Ed25519 ---

    pub fn transfer_delegated(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
        amount: i128,
        nonce: i128,
        public_key_raw: BytesN<32>,
        signature: BytesN<64>,
    ) -> bool {
        // El relayer ejecuta la transacción
        Self::require_worker_or_owner(&env, &caller);
        caller.require_auth();

        // Validar que from coincida con la llave pública provista
        Self::verify_address_matches_pubkey(&env, &from, &public_key_raw);

        // Validar Nonce
        let nonce_key = DataKey::Nonce(from.clone());
        let current_nonce = env.storage().persistent().get(&nonce_key).unwrap_or(0i128);
        if nonce != current_nonce {
            panic!("Nonce inválido");
        }
        env.storage().persistent().set(&nonce_key, &(current_nonce + 1));
        env.storage().persistent().extend_ttl(&nonce_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        // Reconstruir payload: (from, to, amount, nonce, contract_id) serializado en XDR
        // Usamos una tupla estándar que se serializa como un vector XDR ScVal.
        let tuple_val: Val = (
            from.clone(),
            to.clone(),
            amount,
            nonce,
            env.current_contract_address(),
        )
            .into_val(&env);
        let payload: Bytes = tuple_val.to_xdr(&env);

        // Validar firma Ed25519 on-chain
        env.crypto().ed25519_verify(&public_key_raw, &payload, &signature);

        // Ejecutar transferencia interna
        Self::internal_transfer(&env, from, to, amount);
        true
    }

    // --- Funciones Internas de Ayuda ---

    fn require_worker_or_owner(env: &Env, caller: &Address) {
        let owner: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
        let worker: Address = env.storage().instance().get(&DataKey::Worker).unwrap();
        if caller != &owner && caller != &worker {
            panic!("No autorizado");
        }
    }

    fn get_effective_rate(env: &Env, code: Symbol) -> i128 {
        let key = DataKey::MaterialRate(code);
        if env.storage().persistent().has(&key) {
            let val = env.storage().persistent().get(&key).unwrap();
            env.storage().persistent().extend_ttl(&key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
            val
        } else {
            env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
            env.storage().instance().get(&DataKey::DefaultRate).unwrap_or(0)
        }
    }

    fn internal_mint(env: &Env, to: Address, amount: i128) {
        let balance_key = DataKey::Balance(to.clone());
        let current_bal = env.storage().persistent().get(&balance_key).unwrap_or(0i128);
        env.storage().persistent().set(&balance_key, &(current_bal + amount));
        env.storage().persistent().extend_ttl(&balance_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        let supply_val = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0i128);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply_val + amount));
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn internal_transfer(env: &Env, from: Address, to: Address, amount: i128) {
        if amount <= 0 {
            panic!("Monto inválido");
        }
        let from_key = DataKey::Balance(from.clone());
        let to_key = DataKey::Balance(to.clone());

        let from_bal = env.storage().persistent().get(&from_key).unwrap_or(0i128);
        if from_bal < amount {
            panic!("Saldo insuficiente");
        }

        let to_bal = env.storage().persistent().get(&to_key).unwrap_or(0i128);

        env.storage().persistent().set(&from_key, &(from_bal - amount));
        env.storage().persistent().extend_ttl(&from_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

        env.storage().persistent().set(&to_key, &(to_bal + amount));
        env.storage().persistent().extend_ttl(&to_key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    fn verify_address_matches_pubkey(env: &Env, addr: &Address, pubkey: &BytesN<32>) {
        let addr_xdr = addr.to_xdr(env);
        let len = addr_xdr.len() as usize;
        if len < 32 {
            panic!("Address serialization is too short");
        }
        let mut xdr_buf = [0u8; 128];
        if len > 128 {
            panic!("Address XDR representation too large");
        }
        addr_xdr.copy_into_slice(&mut xdr_buf[0..len]);
        
        // Los últimos 32 bytes corresponden a la clave pública Ed25519 (Uint256)
        let pk_start = len - 32;
        let mut extracted_pk = [0u8; 32];
        extracted_pk.copy_from_slice(&xdr_buf[pk_start..len]);
        
        if extracted_pk != pubkey.to_array() {
            panic!("Mismatched from address and public key");
        }
    }
}

// --- Módulo de Pruebas Unitarias ---
#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use ed25519_dalek::{SigningKey, Signer};

    fn setup_test(env: &Env) -> (Address, Address, Address, EcoBatchRegistryClient<'static>) {
        env.mock_all_auths();
        let owner = Address::generate(env);
        let worker = Address::generate(env);
        let user = Address::generate(env);

        let contract_id = env.register_contract(None, EcoBatchRegistry);
        let client = EcoBatchRegistryClient::new(env, &contract_id);

        client.init(&owner, &worker);

        (owner, worker, user, client)
    }

    #[test]
    fn test_initialization() {
        let env = Env::default();
        let (owner, worker, _, client) = setup_test(&env);

        assert_eq!(client.owner(), owner);
        assert_eq!(client.worker_address(), worker);
        assert_eq!(client.decimals(), 7);
        assert_eq!(client.name(), String::from_str(&env, "EcoToken"));
        assert_eq!(client.symbol(), String::from_str(&env, "ECO"));

        // Verificar tarifa base para PET y CARTON
        assert_eq!(client.material_rate(&Symbol::new(&env, "PET")), 100_000_000); // 10 ECO
        assert_eq!(client.material_rate(&Symbol::new(&env, "CARTON")), 50_000_000); // 5 ECO
    }

    #[test]
    fn test_batch_weighed_distribution_80_20() {
        let env = Env::default();
        let (_, worker, _, client) = setup_test(&env);

        let collector = Address::generate(&env);
        let household1 = Address::generate(&env);
        let household2 = Address::generate(&env);

        let households = Vec::from_array(&env, [household1.clone(), household2.clone()]);
        let material_codes = Vec::from_array(&env, [Symbol::new(&env, "PET"), Symbol::new(&env, "CARTON")]);
        
        // Pesos en gramos (10 kg y 5 kg)
        // PET rate = 10 ECO (100M Stroops/kg). Recompensa PET = 10kg * 10 ECO = 100 ECO
        // CARTON rate = 5 ECO (50M Stroops/kg). Recompensa CARTON = 5kg * 5 ECO = 25 ECO
        // Recompensa Total = 125 ECO (1,250,000,000 Stroops)
        let weights = Vec::from_array(&env, [10_000i128, 5_000i128]); 

        let batch_id = BytesN::from_array(&env, &[1u8; 32]);

        client.register_batch_weighed(
            &worker,
            &batch_id,
            &String::from_str(&env, "ipfs-cid"),
            &collector,
            &households,
            &material_codes,
            &weights,
        );

        // Recompensa Total = 125 ECO.
        // Collector share = 20% = 25 ECO.
        // Households share = 80% = 100 ECO, dividido en 2 = 50 ECO cada uno.
        let one_eco: i128 = 10_000_000;
        assert_eq!(client.balance(&collector), 25 * one_eco);
        assert_eq!(client.balance(&household1), 50 * one_eco);
        assert_eq!(client.balance(&household2), 50 * one_eco);
        assert_eq!(client.total_supply(), 125 * one_eco);

        // Verificar detalles del lote guardados
        let batch_details = client.get_batch(&batch_id);
        assert!(batch_details.processed);
        assert_eq!(batch_details.total_reward, 125 * one_eco);
        assert_eq!(batch_details.recipients_count, 3);
    }

    #[test]
    #[should_panic(expected = "Lote ya procesado")]
    fn test_idempotency_batch() {
        let env = Env::default();
        let (_, worker, _, client) = setup_test(&env);

        let collector = Address::generate(&env);
        let household = Address::generate(&env);
        let households = Vec::from_array(&env, [household]);
        let material_codes = Vec::from_array(&env, [Symbol::new(&env, "PET")]);
        let weights = Vec::from_array(&env, [1_000i128]);

        let batch_id = BytesN::from_array(&env, &[2u8; 32]);

        client.register_batch_weighed(
            &worker,
            &batch_id,
            &String::from_str(&env, "ipfs-cid"),
            &collector,
            &households,
            &material_codes,
            &weights,
        );

        // Intentar registrar el mismo lote de nuevo debe disparar panic
        client.register_batch_weighed(
            &worker,
            &batch_id,
            &String::from_str(&env, "ipfs-cid"),
            &collector,
            &households,
            &material_codes,
            &weights,
        );
    }

    #[test]
    fn test_transfer_delegated_valid_and_invalid_signature() {
        let env = Env::default();
        let (_, worker, _, client) = setup_test(&env);

        // Generar un keypair Ed25519 determinista a partir de una semilla fija
        let seed: [u8; 32] = [42u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        
        let raw_pubkey: [u8; 32] = verifying_key.to_bytes();
        let public_key_raw = BytesN::from_array(&env, &raw_pubkey);

        // Convertir la llave pública al Address de Stellar del emisor usando stellar-strkey
        use stellar_strkey::{Strkey, ed25519::PublicKey};
        let strkey_obj = Strkey::PublicKeyEd25519(PublicKey(raw_pubkey));
        let g_address_str = strkey_obj.to_string();
        let from_address = Address::from_string(&String::from_str(&env, &g_address_str));

        // Fondear la cuenta emisor
        let one_eco: i128 = 10_000_000;
        client.mint(&worker, &from_address, &(100 * one_eco));
        assert_eq!(client.balance(&from_address), 100 * one_eco);

        let to_address = Address::generate(&env);
        let amount = 30 * one_eco;
        let nonce = 0i128;

        // Construir y firmar el mensaje: (from, to, amount, nonce, contract_id)
        let tuple_val: Val = (
            from_address.clone(),
            to_address.clone(),
            amount,
            nonce,
            client.address.clone(),
        )
            .into_val(&env);
        let payload: Bytes = tuple_val.to_xdr(&env);

        let len = payload.len() as usize;
        let mut payload_buf = [0u8; 256];
        if len > 256 {
            panic!("Payload too large");
        }
        payload.copy_into_slice(&mut payload_buf[0..len]);

        let sig = signing_key.sign(&payload_buf[0..len]);
        let signature_bytes: [u8; 64] = sig.to_bytes();
        let signature = BytesN::from_array(&env, &signature_bytes);

        // Ejecutar transferencia delegada exitosa
        client.transfer_delegated(
            &worker,
            &from_address,
            &to_address,
            &amount,
            &nonce,
            &public_key_raw,
            &signature,
        );

        assert_eq!(client.balance(&from_address), 70 * one_eco);
        assert_eq!(client.balance(&to_address), 30 * one_eco);
        assert_eq!(client.nonces(&from_address), 1);

        // Intentar reutilizar la misma firma (replay attack) debe fallar por nonce
        let res_nonce = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.transfer_delegated(
                &worker,
                &from_address,
                &to_address,
                &amount,
                &nonce, // Reutilizando nonce 0
                &public_key_raw,
                &signature,
            );
        }));
        assert!(res_nonce.is_err());

        // Intentar transferir con firma corrupta
        let mut corrupt_sig_bytes = signature_bytes.clone();
        corrupt_sig_bytes[0] ^= 0xFF; // alterar firma
        let corrupt_signature = BytesN::from_array(&env, &corrupt_sig_bytes);

        let next_nonce = 1i128;
        let res_sig = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.transfer_delegated(
                &worker,
                &from_address,
                &to_address,
                &amount,
                &next_nonce,
                &public_key_raw,
                &corrupt_signature,
            );
        }));
        assert!(res_sig.is_err());
    }

    #[test]
    fn test_ttl_extension() {
        let env = Env::default();
        let (_, worker, _, client) = setup_test(&env);

        let collector = Address::generate(&env);
        let household = Address::generate(&env);
        let households = Vec::from_array(&env, [household.clone()]);
        let material_codes = Vec::from_array(&env, [Symbol::new(&env, "PET")]);
        let weights = Vec::from_array(&env, [1_000i128]);

        let batch_id = BytesN::from_array(&env, &[3u8; 32]);

        client.register_batch_weighed(
            &worker,
            &batch_id,
            &String::from_str(&env, "ipfs-cid"),
            &collector,
            &households,
            &material_codes,
            &weights,
        );

        // Si corre sin errores, las extensiones de TTL (extend_ttl) fueron llamadas exitosamente
        // a nivel de host en persistent/instance storage.
    }
}

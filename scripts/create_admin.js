/**
 * ==============================================================================
 * LIVORA - SCRIPT DE GENERACIÓN Y GESTIÓN DE ADMINISTRADORES
 * ==============================================================================
 * Crea o promueve usuarios al rol ADMIN en el sistema Livora:
 *  1. Registra o actualiza el usuario en Supabase Auth con confirmación automática.
 *  2. Genera una billetera Web3 en Stellar y cifra la clave privada con AES-256-GCM
 *     (PBKDF2-SHA512 NIST standard compatible con CryptoUtil del backend).
 *  3. Crea o actualiza el registro en PostgreSQL (Prisma) asignando rol ADMIN y estado ACTIVE.
 *  4. Asegura la creación de la cuenta de doble partida (Account: USER_WALLET, LIVORA).
 * 
 * USO:
 *   # Modo interactivo:
 *   node scripts/create_admin.js
 * 
 *   # Modo por argumentos CLI:
 *   node scripts/create_admin.js --email admin@livora.pe --password "MiClaveSegura2026!*" --name "Administrador Principal" --phone "+51987654321"
 * 
 *   # Modo producción (carga .env.production):
 *   node scripts/create_admin.js --prod --email admin@livora.pe --password "MiClaveSegura2026!*" --name "Admin Prod"
 * 
 *   # Modo lote (JSON):
 *   node scripts/create_admin.js --batch ./admins.json
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const dotenv = require('dotenv');

// ==============================================================================
// 1. AYUDA INMEDIATA (--help)
// ==============================================================================
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
====================================================================
         LIVORA - GENERADOR SEGURO DE ADMINISTRADORES               
====================================================================
Uso:
  node scripts/create_admin.js [opciones]

Opciones:
  --email <email>         Correo electrónico del administrador (requerido en modo CLI)
  --password <password>   Contraseña del administrador (mínimo 8 caracteres)
  --name <nombre>         Nombre completo del administrador
  --phone <telefono>      Número telefónico (ej. +51987654321)
  --address <direccion>   Dirección física (opcional)
  --batch <archivo.json>  Ruta a archivo JSON con array de administradores
  --prod, --production    Utiliza el archivo .env.production
  --env-file <archivo>    Especifica la ruta de un archivo de entorno personalizado
  --help, -h              Muestra esta pantalla de ayuda

Ejemplos:
  # Interactivo (te solicita email y contraseña en la consola):
  npm run admin:create

  # Por comando directo:
  node scripts/create_admin.js --email admin@livora.pe --password "Admin2026!*" --name "Super Admin"

  # En producción:
  node scripts/create_admin.js --prod --email admin@livora.pe --password "Admin2026!*"
====================================================================
`);
  process.exit(0);
}

// ==============================================================================
// 2. CARGA DE VARIABLES DE ENTORNO
// ==============================================================================
function getArgValue(flag) {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return null;
}

const isProdFlag = args.includes('--prod') || args.includes('--production') || process.env.NODE_ENV === 'production';
const customEnv = getArgValue('--env-file');

function resolveEnvFile() {
  if (customEnv) return customEnv;
  if (isProdFlag) return '.env.production';
  // Si no se especificó nada, preferir .env, pero si solo existe .env.production, usarlo
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '..', '.env'),
  ];
  const hasEnv = candidates.some((c) => fs.existsSync(c));
  if (!hasEnv) {
    const prodCandidates = [
      path.resolve(process.cwd(), '.env.production'),
      path.resolve(__dirname, '.env.production'),
      path.resolve(__dirname, '..', '.env.production'),
    ];
    if (prodCandidates.some((c) => fs.existsSync(c))) {
      return '.env.production';
    }
  }
  return '.env';
}

const envFile = resolveEnvFile();
const possibleEnvPaths = [
  path.resolve(process.cwd(), envFile),
  path.resolve(__dirname, envFile),
  path.resolve(__dirname, '..', envFile),
  path.resolve(process.cwd(), 'Livora-api-service', envFile),
];

let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`[ENV] Archivo de configuración cargado desde: ${envPath}`);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  dotenv.config();
  console.log('[ENV] Cargando variables por defecto del entorno.');
}

// ==============================================================================
// 2. RESOLUCIÓN DE MÓDULOS DE BACKEND (Local o Global)
// ==============================================================================
function findBackendModules() {
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(process.cwd(), 'node_modules'),
    path.resolve(process.cwd(), 'Livora-api-service', 'node_modules'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '@prisma', 'client'))) {
      return c;
    }
  }
  return candidates[0];
}

const backendModulesPath = findBackendModules();
function loadModule(name) {
  try {
    return require(name);
  } catch {
    return require(path.join(backendModulesPath, name));
  }
}

const { PrismaClient } = loadModule('@prisma/client');
const { PrismaPg } = loadModule('@prisma/adapter-pg');
const { Pool } = loadModule('pg');
const { createClient } = loadModule('@supabase/supabase-js');
const { Keypair } = loadModule('@stellar/stellar-sdk');

// ==============================================================================
// 3. CRIPTOGRAFÍA AES-256-GCM (Estándar CryptoUtil de Livora)
// ==============================================================================
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;

function deriveKeyPbkdf2(secretKey, salt) {
  return crypto.pbkdf2Sync(
    String(secretKey),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );
}

function encryptPrivateKey(text, secretKey) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKeyPbkdf2(secretKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  key.fill(0); // Limpieza de memoria inmediata

  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function getMasterEncryptionKey() {
  const key =
    process.env.ENCRYPTION_MASTER_KEY ||
    process.env.WALLET_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY;

  if (!key || key.trim() === '') {
    throw new Error('FATAL: ENCRYPTION_MASTER_KEY o WALLET_ENCRYPTION_KEY debe estar definido en el .env');
  }
  return key.trim();
}

// ==============================================================================
// 4. INTERACCIÓN POR CONSOLA
// ==============================================================================
function promptQuestion(query, isPassword = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (isPassword) {
      process.stdout.write(query);
      let pass = '';
      const onData = (char) => {
        char = char + '';
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            process.stdin.removeListener('data', onData);
            break;
          default:
            pass += char;
            break;
        }
      };
      process.stdin.on('data', onData);
      rl.question('', () => {
        rl.close();
        resolve(pass.trim());
      });
    } else {
      rl.question(query, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    }
  });
}

// ==============================================================================
// 5. LÓGICA PRINCIPAL DE CREACIÓN DE ADMINISTRADOR
// ==============================================================================
async function createOrPromoteAdmin({ email, password, name, phone, address }, { prisma, supabase, encryptionKey }) {
  console.log(`\n--------------------------------------------------------------------`);
  console.log(`[PROCESANDO] Administrador: ${email}`);
  console.log(`--------------------------------------------------------------------`);

  let authUserId = null;
  let isExistingUserInAuth = false;

  // 1. Buscar si el usuario ya existe en Supabase Auth
  try {
    const { data: listData, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (!listError && listData?.users) {
      const existing = listData.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (existing) {
        authUserId = existing.id;
        isExistingUserInAuth = true;
        console.log(`  ℹ Usuario encontrado en Supabase Auth (ID: ${authUserId}). Actualizando credenciales...`);
        
        const updatePayload = {
          email_confirm: true,
          user_metadata: {
            role: 'ADMIN',
            name: name || existing.user_metadata?.name || 'Administrador Livora',
          },
        };
        if (password) {
          updatePayload.password = password;
        }

        const { error: updateError } = await supabase.auth.admin.updateUserById(authUserId, updatePayload);
        if (updateError) {
          throw new Error(`Error actualizando usuario en Supabase Auth: ${updateError.message}`);
        }
        console.log(`  ✔ Usuario actualizado con rol ADMIN en Supabase Auth.`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Aviso al listar Supabase Auth: ${err.message}`);
  }

  // 2. Si no existe en Supabase Auth, crearlo
  if (!isExistingUserInAuth) {
    if (!password) {
      throw new Error(`Para un nuevo usuario administrador se requiere una contraseña (--password).`);
    }
    console.log(`  --> Creando usuario en Supabase Auth...`);
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: 'ADMIN',
        name: name || 'Administrador Livora',
      },
    });

    if (createError || !createData?.user) {
      throw new Error(`Error al crear usuario en Supabase Auth: ${createError?.message}`);
    }

    authUserId = createData.user.id;
    console.log(`  ✔ Administrador creado en Supabase Auth (ID: ${authUserId}).`);
  }

  // 3. Verificar si el usuario ya existe en PostgreSQL
  const existingDbUser = await prisma.user.findFirst({
    where: {
      OR: [
        { id: authUserId },
        { email: email.toLowerCase() },
      ],
    },
    include: { accounts: true },
  });

  let walletAddress = existingDbUser?.walletAddress;
  let encryptedPrivateKey = existingDbUser?.encryptedPrivateKey;

  // 4. Si no tiene billetera Web3 asignada, generar una nueva
  if (!walletAddress || !encryptedPrivateKey) {
    console.log(`  --> Generando par de claves Stellar Web3 para el Administrador...`);
    const keypair = Keypair.random();
    walletAddress = keypair.publicKey();
    encryptedPrivateKey = encryptPrivateKey(keypair.secret(), encryptionKey);
    console.log(`  ✔ Billetera Stellar generada: ${walletAddress}`);
  } else {
    console.log(`  ℹ Billetera Stellar existente conservada: ${walletAddress}`);
  }

  // 5. Crear o actualizar en PostgreSQL
  let dbUser;
  if (existingDbUser) {
    console.log(`  --> Actualizando rol a ADMIN y activando en PostgreSQL...`);
    dbUser = await prisma.user.update({
      where: { id: existingDbUser.id },
      data: {
        id: authUserId, // Sincroniza UUID con Supabase Auth si hubiese divergencia
        email: email.toLowerCase(),
        name: name || existingDbUser.name || 'Administrador Livora',
        phone: phone || existingDbUser.phone,
        address: address || existingDbUser.address,
        role: 'ADMIN',
        userStatus: 'ACTIVE',
        isActive: true,
        walletAddress,
        encryptedPrivateKey,
      },
    });
    console.log(`  ✔ Registro en PostgreSQL actualizado.`);
  } else {
    console.log(`  --> Creando registro de Administrador en PostgreSQL...`);
    dbUser = await prisma.user.create({
      data: {
        id: authUserId,
        email: email.toLowerCase(),
        name: name || 'Administrador Livora',
        phone: phone || null,
        address: address || null,
        role: 'ADMIN',
        userStatus: 'ACTIVE',
        isActive: true,
        walletAddress,
        encryptedPrivateKey,
        marketingAccepted: false,
      },
    });
    console.log(`  ✔ Administrador registrado en PostgreSQL.`);
  }

  // 6. Asegurar Cuenta contable (USER_WALLET) en el Libro Mayor
  const userAccount = await prisma.account.findFirst({
    where: {
      userId: dbUser.id,
      currency: 'LIVORA',
    },
  });

  if (!userAccount) {
    console.log(`  --> Inicializando cuenta de doble partida (USER_WALLET)...`);
    await prisma.account.create({
      data: {
        userId: dbUser.id,
        accountType: 'USER_WALLET',
        status: 'ACTIVE',
        currency: 'LIVORA',
        cachedBalance: 0,
      },
    });
    console.log(`  ✔ Cuenta contable creada.`);
  } else {
    console.log(`  ℹ Cuenta contable existente: Balance cached = ${userAccount.cachedBalance}`);
  }

  return {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role,
    walletAddress: dbUser.walletAddress,
    status: dbUser.userStatus,
  };
}

// ==============================================================================
// 6. EJECUCIÓN PRINCIPAL
// ==============================================================================
async function main() {
  console.log('====================================================================');
  console.log('         LIVORA - GENERADOR SEGURO DE ADMINISTRADORES               ');
  console.log('====================================================================');

  // Validar variables críticas
  let databaseUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL no está configurado en el entorno.');
  }

  // Detección de ejecución en Host de Lightsail (fuera de contenedor Docker)
  // Si la URL apunta al nombre interno del contenedor Docker 'livora_postgres:5432',
  // se mapea automáticamente al puerto expuesto en el host (127.0.0.1:5434).
  const isInsideDocker = fs.existsSync('/.dockerenv');
  if (!isInsideDocker && databaseUrl.includes('livora_postgres:5432')) {
    const hostPort = process.env.DB_PORT || '5434';
    databaseUrl = databaseUrl.replace('livora_postgres:5432', `127.0.0.1:${hostPort}`);
    console.log(`[HOST DOCKER BRIDGE] Ejecutando fuera de Docker: redirigiendo conexión PostgreSQL a 127.0.0.1:${hostPort}`);
  }

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY deben estar configurados.');
  }

  const encryptionKey = getMasterEncryptionKey();

  // Inicializar clientes
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 10000,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const context = { prisma, supabase, encryptionKey };

  try {
    const batchFile = getArgValue('--batch');
    const createdAdmins = [];

    if (batchFile) {
      // Modo lote desde JSON
      const fullPath = path.resolve(process.cwd(), batchFile);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Archivo batch no encontrado: ${fullPath}`);
      }
      const rawData = fs.readFileSync(fullPath, 'utf8');
      const adminList = JSON.parse(rawData);
      if (!Array.isArray(adminList)) {
        throw new Error('El archivo batch debe contener un array JSON de administradores.');
      }
      console.log(`[BATCH] Procesando ${adminList.length} administrador(es)...`);
      for (const item of adminList) {
        if (!item.email || !item.password) {
          console.error(`  ❌ Omitiendo entrada inválida: falta email o password`, item);
          continue;
        }
        const res = await createOrPromoteAdmin(item, context);
        createdAdmins.push(res);
      }
    } else {
      // Modo individual (CLI o interactivo)
      let email = getArgValue('--email');
      let password = getArgValue('--password');
      let name = getArgValue('--name');
      let phone = getArgValue('--phone');
      let address = getArgValue('--address');

      if (!email) {
        console.log('\n[MODO INTERACTIVO] Ingresa los datos del nuevo Administrador:');
        email = await promptQuestion('Correo electrónico (Email): ');
        password = await promptQuestion('Contraseña (mínimo 8 caracteres): ');
        name = await promptQuestion('Nombre completo: ');
        phone = await promptQuestion('Teléfono (opcional, ej. +51987654321): ');
        address = await promptQuestion('Dirección (opcional): ');
      }

      if (!email || !email.includes('@')) {
        throw new Error('Debes proporcionar un correo electrónico válido.');
      }
      if (!password || password.length < 8) {
        throw new Error('La contraseña debe contener al menos 8 caracteres.');
      }

      const res = await createOrPromoteAdmin({ email, password, name, phone, address }, context);
      createdAdmins.push(res);
    }

    console.log('\n====================================================================');
    console.log('             RESUMEN DE ADMINISTRADORES REGISTRADOS                 ');
    console.log('====================================================================');
    for (const a of createdAdmins) {
      console.log(`• ID:         ${a.id}`);
      console.log(`  Email:      ${a.email}`);
      console.log(`  Nombre:     ${a.name}`);
      console.log(`  Rol:        ${a.role}`);
      console.log(`  Estado:     ${a.status}`);
      console.log(`  Wallet Pub: ${a.walletAddress}`);
      console.log('--------------------------------------------------------------------');
    }
    console.log(`✔ Proceso completado exitosamente (${createdAdmins.length} administradores procesados).`);

  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n❌ ERROR DURANTE LA GENERACIÓN DE ADMINISTRADORES:');
  console.error(err.message || err);
  process.exit(1);
});

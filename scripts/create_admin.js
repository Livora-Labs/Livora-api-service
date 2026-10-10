/**
 * ==============================================================================
 * LIVORA - SCRIPT DE GENERACIÓN Y GESTIÓN DE ADMINISTRADORES (NATIVO POSTGRESQL)
 * ==============================================================================
 * Crea o promueve usuarios al rol ADMIN en el sistema Livora:
 *  1. Registra o actualiza el usuario en PostgreSQL (Prisma) con rol ADMIN y estado ACTIVE.
 *  2. Hashea la contraseña con Bcrypt (12 rondas OWASP) en UserCredential.
 *  3. Genera una billetera Web3 en Stellar y almacena la clave cifrada en WalletVault
 *     (PBKDF2-SHA512 + AES-256-GCM compatible con CryptoUtil del backend).
 *  4. Asegura la creación de la cuenta contable de doble partida (Account: USER_WALLET, LIVORA).
 * 
 * USO:
 *   # Modo interactivo:
 *   npm run admin:create
 * 
 *   # Modo por argumentos CLI:
 *   node scripts/create_admin.js --email admin@livora.pe --password "MiClaveSegura2026!*" --name "Administrador Principal"
 * 
 *   # Modo producción (carga .env.production):
 *   node scripts/create_admin.js --prod --email admin@livora.pe --password "MiClaveSegura2026!*"
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
  # Interactivo:
  npm run admin:create

  # Por comando directo:
  node scripts/create_admin.js --email admin@livora.pe --password "Admin2026!*" --name "Super Admin"
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
// 3. RESOLUCIÓN DE MÓDULOS DE BACKEND
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
const { Keypair } = loadModule('@stellar/stellar-sdk');
const bcrypt = loadModule('bcryptjs');

// ==============================================================================
// 4. CRIPTOGRAFÍA AES-256-GCM (Estándar CryptoUtil de Livora)
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

  key.fill(0);

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
// 5. INTERACCIÓN POR CONSOLA
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
// 6. LÓGICA PRINCIPAL DE CREACIÓN DE ADMINISTRADOR
// ==============================================================================
async function createOrPromoteAdmin({ email, password, name, phone, address }, { prisma, encryptionKey }) {
  console.log(`\n--------------------------------------------------------------------`);
  console.log(`[PROCESANDO] Administrador: ${email}`);
  console.log(`--------------------------------------------------------------------`);

  // 1. Verificar si el usuario ya existe en PostgreSQL
  const existingDbUser = await prisma.user.findFirst({
    where: { email: email.toLowerCase() },
    include: { accounts: true, credentials: true },
  });

  // 2. Verificar o generar clave Web3
  let walletAddress = existingDbUser?.walletAddress;
  let newEncryptedPrivateKey = null;

  const existingVault = existingDbUser
    ? await prisma.walletVault.findUnique({ where: { userId: existingDbUser.id } })
    : null;

  if (!walletAddress || !existingVault) {
    console.log(`  --> Generando par de claves Stellar Web3 para el Administrador...`);
    const keypair = Keypair.random();
    walletAddress = keypair.publicKey();
    newEncryptedPrivateKey = encryptPrivateKey(keypair.secret(), encryptionKey);
    console.log(`  ✔ Billetera Stellar generada: ${walletAddress}`);
  } else {
    console.log(`  ℹ Billetera Stellar existente conservada: ${walletAddress}`);
  }

  // 3. Crear o actualizar usuario en PostgreSQL
  let dbUser;
  if (existingDbUser) {
    console.log(`  --> Actualizando rol a ADMIN y activando en PostgreSQL...`);
    dbUser = await prisma.user.update({
      where: { id: existingDbUser.id },
      data: {
        email: email.toLowerCase(),
        name: name || existingDbUser.name || 'Administrador Livora',
        phone: phone || existingDbUser.phone,
        address: address || existingDbUser.address,
        role: 'ADMIN',
        userStatus: 'ACTIVE',
        isActive: true,
        walletAddress,
      },
    });
    console.log(`  ✔ Registro en PostgreSQL actualizado.`);
  } else {
    if (!password) {
      throw new Error(`Para un nuevo usuario administrador se requiere una contraseña (--password).`);
    }
    const newUserId = crypto.randomUUID();
    console.log(`  --> Creando registro de Administrador en PostgreSQL...`);
    dbUser = await prisma.user.create({
      data: {
        id: newUserId,
        email: email.toLowerCase(),
        name: name || 'Administrador Livora',
        phone: phone || null,
        address: address || null,
        role: 'ADMIN',
        userStatus: 'ACTIVE',
        isActive: true,
        walletAddress,
        marketingAccepted: false,
      },
    });
    console.log(`  ✔ Administrador registrado en PostgreSQL (ID: ${dbUser.id}).`);
  }

  // 4. Actualizar WalletVault si se generó una nueva clave
  if (newEncryptedPrivateKey) {
    await prisma.walletVault.upsert({
      where: { userId: dbUser.id },
      update: {
        encryptedPrivateKey: newEncryptedPrivateKey,
      },
      create: {
        userId: dbUser.id,
        encryptedPrivateKey: newEncryptedPrivateKey,
      },
    });
    console.log(`  ✔ WalletVault seguro actualizado.`);
  }

  // 5. Actualizar UserCredential si se proporcionó contraseña
  if (password) {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.userCredential.upsert({
      where: { userId: dbUser.id },
      update: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        lastPasswordChange: new Date(),
      },
      create: {
        userId: dbUser.id,
        passwordHash,
        lastPasswordChange: new Date(),
      },
    });
    console.log(`  ✔ Credencial de acceso (Bcrypt) actualizada.`);
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
// 7. EJECUCIÓN PRINCIPAL
// ==============================================================================
async function main() {
  console.log('====================================================================');
  console.log('         LIVORA - GENERADOR SEGURO DE ADMINISTRADORES               ');
  console.log('====================================================================');

  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL no está configurado en el entorno.');
  }

  const isInsideDocker = fs.existsSync('/.dockerenv');
  if (!isInsideDocker && databaseUrl.includes('livora_postgres:5432')) {
    const hostPort = process.env.DB_PORT || '5434';
    databaseUrl = databaseUrl.replace('livora_postgres:5432', `127.0.0.1:${hostPort}`);
    console.log(`[HOST DOCKER BRIDGE] Redirigiendo conexión PostgreSQL a 127.0.0.1:${hostPort}`);
  }

  const encryptionKey = getMasterEncryptionKey();

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 10000,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const context = { prisma, encryptionKey };

  try {
    const batchFile = getArgValue('--batch');
    const createdAdmins = [];

    if (batchFile) {
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
      let email = getArgValue('--email');
      let password = getArgValue('--password');
      let name = getArgValue('--name');
      let phone = getArgValue('--phone');
      let address = getArgValue('--address');

      if (!email) {
        console.log('\n[MODO INTERACTIVO] Ingresa los datos solicitados:');
        email = await promptQuestion('  Correo electrónico del Administrador: ');
      }

      if (!email || !email.includes('@')) {
        throw new Error('El correo electrónico proporcionado no es válido.');
      }

      if (!password) {
        password = await promptQuestion('  Contraseña (mínimo 8 caracteres): ', true);
        console.log('');
      }

      if (password && password.length < 8) {
        throw new Error('La contraseña debe contener al menos 8 caracteres.');
      }

      if (!name) {
        name = await promptQuestion('  Nombre completo (opcional, Enter para omitir): ');
      }

      const res = await createOrPromoteAdmin({ email, password, name, phone, address }, context);
      createdAdmins.push(res);
    }

    console.log('\n====================================================================');
    console.log('                     RESUMEN DE OPERACIÓN                           ');
    console.log('====================================================================');
    for (const a of createdAdmins) {
      console.log(`  • ID:             ${a.id}`);
      console.log(`    Email:          ${a.email}`);
      console.log(`    Nombre:         ${a.name}`);
      console.log(`    Rol:            ${a.role}`);
      console.log(`    Estado:         ${a.status}`);
      console.log(`    Billetera Web3: ${a.walletAddress}`);
      console.log('--------------------------------------------------------------------');
    }
    console.log(`\n✔ Proceso completado exitosamente (${createdAdmins.length} administradores procesados).`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n❌ ERROR FATAL:', err.message);
  process.exit(1);
});

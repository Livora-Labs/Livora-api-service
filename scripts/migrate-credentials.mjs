import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MIGRATED_USERS = [
  {
    id: "67b59446-27b1-44e0-8b1a-04110a894c98",
    email: "huarique8@gmail.com",
    encrypted_password: "$2a$10$3O8REEMxwYx0YCHgBG6XF.ak5lXBKF/TxECbhRduuSd6s1ZH6/4DC"
  },
  {
    id: "c4dcfd2e-da63-415f-9415-6b3b67fc1815",
    email: "zalvaxperu@gmail.com",
    encrypted_password: "$2a$10$N13vQRg.vUM0GwrtcerJN.fYOAfhrb0i6ighAgBbYS94X4iArhgae"
  },
  {
    id: "ebcc58fe-e3c0-44d8-b430-d82ec4a69c9d",
    email: "mentadelperu3@gmail.com",
    encrypted_password: "$2a$10$MEjVFRCjUE.z8qn1o6/1je8MKDNClIclx4fpOK3IrWWSE4MaMW1kK"
  },
  {
    id: "af2f6327-14fd-4eb5-9013-4ab398da2528",
    email: "jfayulo@hotmail.com",
    encrypted_password: "$2a$10$jB76Te3Dwv2kLWHszu7lvONm2LjsExDAITbHOmB68vTd.qq0E2ugW"
  },
  {
    id: "ac09998f-c342-4730-b4c6-aee219487119",
    email: "almeida.daniel@pucp.edu.pe",
    encrypted_password: "$2a$10$Z5aW68ydj0cX/ihaue/c4.8pvparIVZM6IvDQ7VZcx/nt3ICAN4E."
  },
  {
    id: "f7c58ae5-2d09-435c-a845-cf72155ea7f7",
    email: "e85747226@gmail.com",
    encrypted_password: "$2a$10$.rL5IN4NQdNEo9C/HERg.e.nC/t.M/zQBlkDVbu3GCSb7cdCbsBLC"
  },
  {
    id: "279e9874-038c-4a88-b68e-c66159e902e8",
    email: "ciriacodeveloper@gmail.com",
    encrypted_password: "$2a$10$HW7wWy1Eb7wSb7p57QPzXunbuIwKEBGjipF67bLlSdiONlc7A6cUu"
  },
  {
    id: "015be7b7-e26a-451b-889a-427729969918",
    email: "danielarmando023@gmail.com",
    encrypted_password: "$2a$10$PCj27qPgOwlOFCyhmnFMlutf1SIZ0u918fQvyguMjPKWNLm8ykrSO"
  },
  {
    id: "abba658f-7205-4008-9ac1-3b098f0b0f06",
    email: "recolector131@gmail.com",
    encrypted_password: "$2a$10$jTuFdr74eHnExDu8N.CpDuShjh/3fR86v6UUmeqVoPRt8VqaE4vBC"
  },
  {
    id: "13f44e46-8316-4f79-b211-92b3ae254d37",
    email: "playstore.review@livora.pe",
    encrypted_password: "$2a$10$qwNHL3bL6WDj8Dqkhm8mye8fiDf7zVGAIQdwb2fJFDZDNHJGq.1yy"
  },
  {
    id: "8b359161-31d5-4d1d-886e-3d71d3c701d6",
    email: "gruponashira@gmail.com",
    encrypted_password: "$2a$10$KoWOHgNHuFlBcXPH8dSBIOXxb6pShatv3ICKX1n5kMVlz6T7wqhsG"
  },
  {
    id: "2e8baecf-410e-45d2-83a5-cefd7d7f8c21",
    email: "t0943232@gmail.com",
    encrypted_password: "$2a$10$sjtFXAKnjA0l/.Vc9ovSBOVar68h7qX0XUW3978NOKxfe9RzwcQ92"
  },
  {
    id: "7d8a477f-2b8e-4063-a867-8c93ca7bccdc",
    email: "huarique51@gmail.com",
    encrypted_password: "$2a$10$q5E96S8eCC1SgV0mChfSNezNLWY9ko/ON28xVxk1/gLCrx5z9fPPS"
  },
  {
    id: "a9c2de65-835a-42d4-9bab-523593e629b4",
    email: "grupolivoralabs@gmail.com",
    encrypted_password: "$2a$10$muTDh9Of2kXTyoti2H9Vb.Vz6SpJKm7iW8srGLVOwq4rQOuEvtgUq"
  },
  {
    id: "69371b7a-d301-47a7-8704-0791071c1285",
    email: "adrianzarate252@gmail.com",
    encrypted_password: "$2a$10$WzMPrUT4Xm6lLKwJpAUhB.iaqRX749nMZFaMHUfYsQs9gKXD7rv1O"
  }
];

async function main() {
  console.log(`Iniciando migración segura de credenciales para ${MIGRATED_USERS.length} usuarios...`);

  let count = 0;
  for (const user of MIGRATED_USERS) {
    // Verificar si el usuario existe en PostgreSQL
    const existingUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true },
    });

    if (!existingUser) {
      console.warn(`Usuario ${user.email} (${user.id}) no encontrado en PostgreSQL. Omitiendo.`);
      continue;
    }

    await prisma.userCredential.upsert({
      where: { userId: user.id },
      update: {
        passwordHash: user.encrypted_password,
        failedAttempts: 0,
        lockedUntil: null,
      },
      create: {
        userId: user.id,
        passwordHash: user.encrypted_password,
        failedAttempts: 0,
      },
    });

    console.log(`✔ Credencial migrada con éxito: ${user.email}`);
    count++;
  }

  console.log(`\nMigración finalizada exitosamente. ${count} credenciales creadas/actualizadas.`);
}

main()
  .catch((e) => {
    console.error('Error durante la migración de credenciales:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

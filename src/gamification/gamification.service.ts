import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimRewardDto } from './dto/claim-reward.dto';
import { Role } from '@prisma/client';

export interface WeeklyQuestResult {
  id: string;
  title: string;
  description: string;
  isCompleted: boolean;
  progressLabel: string;
  progressPercent: number;
}

export interface WeeklyTreeStateResponse {
  stage: number;
  stageTitle: string;
  stageSubtitle: string;
  quests: WeeklyQuestResult[];
  completedQuestsCount: number;
  progressPercent: number;
  claimedStage3Reward: boolean;
  claimedStage4Reward: boolean;
  daysLeftInWeek: number;
  weekLabel: string;
  weekKey: string;
  kycStatus: string;
  canClaimStage3: boolean;
  canClaimStage4: boolean;
}

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retorna el lunes 00:00:00 de la semana en curso (hora local Lima UTC-5).
   */
  private getStartOfWeek(date: Date = new Date()): Date {
    const d = new Date(date);
    const day = d.getDay(); // 0 es domingo, 1 es lunes...
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  /**
   * Retorna el domingo 23:59:59 de la semana en curso.
   */
  private getEndOfWeek(date: Date = new Date()): Date {
    const monday = this.getStartOfWeek(date);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return sunday;
  }

  /**
   * Identificador unívoco de la semana (ej. "2026-W40")
   */
  private getWeekKey(date: Date = new Date()): string {
    const monday = this.getStartOfWeek(date);
    const yearStart = new Date(monday.getFullYear(), 0, 1);
    const diffDays = Math.floor(
      (monday.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000),
    );
    const weekNum = Math.ceil((diffDays + yearStart.getDay() + 1) / 7);
    return `${monday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }

  private getWeekLabel(date: Date = new Date()): string {
    const start = this.getStartOfWeek(date);
    const end = this.getEndOfWeek(date);
    const months = [
      'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
      'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic',
    ];
    return `${start.getDate()} ${months[start.getMonth()]} - ${end.getDate()} ${months[end.getMonth()]}`;
  }

  /**
   * Evalúa de forma estricta las 6 misiones semanales para el Hogar.
   */
  async getWeeklyForestState(userId: string): Promise<WeeklyTreeStateResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, kycStatus: true, email: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== Role.HOGAR) {
      throw new ForbiddenException(
        'El ecosistema Mi Bosque está reservado exclusivamente para cuentas de Hogar.',
      );
    }

    const now = new Date();
    const startOfWeek = this.getStartOfWeek(now);
    const endOfWeek = this.getEndOfWeek(now);
    const weekKey = this.getWeekKey(now);
    const daysLeft = Math.max(
      1,
      Math.ceil((endOfWeek.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    );

    // 1. Solicitudes de recolección de esta semana
    const weeklyRequests = await this.prisma.collectionRequest.findMany({
      where: {
        householdId: userId,
        createdAt: {
          gte: startOfWeek,
          lte: endOfWeek,
        },
      },
    });

    const completedWeeklyRequests = weeklyRequests.filter(
      (r) => r.status === 'COMPLETED',
    );

    // 2. Canjes o compras en tiendas asociadas de esta semana
    const weeklyRedemptions = await this.prisma.redemptionTransaction.findMany({
      where: {
        userId,
        status: 'COMPLETED',
        createdAt: {
          gte: startOfWeek,
          lte: endOfWeek,
        },
      },
    });

    // --- EVALUACIÓN DE LAS 6 MISIONES ---

    // Misión 1: Entrega Real Verificada
    const completedCount = completedWeeklyRequests.length;
    const quest1: WeeklyQuestResult = {
      id: 'quest_1_completed_batch',
      title: 'Entrega Real Verificada',
      description: 'Completa al menos 1 entrega formal con pesaje del recolector.',
      isCompleted: completedCount >= 1,
      progressLabel: `${completedCount} / 1 entrega`,
      progressPercent: completedCount >= 1 ? 1.0 : 0.0,
    };

    // Misión 2: Entrega Impecable (calificación de 5 estrellas o sin incidencias)
    const topRated = completedWeeklyRequests.filter(
      (r) => (r.rating ?? 5) >= 5,
    ).length;
    const quest2: WeeklyQuestResult = {
      id: 'quest_2_clean_delivery',
      title: 'Entrega Impecable',
      description: 'Lote separado y entregado con máxima valoración o sin observaciones.',
      isCompleted: topRated >= 1,
      progressLabel: `${topRated} / 1 entrega`,
      progressPercent: topRated >= 1 ? 1.0 : 0.0,
    };

    // Misión 3: Volumen de Impacto (≥ 5.0 kg pesados en la semana)
    let weeklyKg = 0.0;
    for (const r of completedWeeklyRequests) {
      const actual = (r.actualWeights as Record<string, number>) || {};
      if (Object.keys(actual).length > 0) {
        weeklyKg += Object.values(actual).reduce(
          (sum, val) => sum + (Number(val) || 0),
          0,
        );
      } else {
        const est = (r.itemsEstimated as Record<string, number>) || {};
        weeklyKg += Object.values(est).reduce(
          (sum, val) => sum + (Number(val) || 0),
          0,
        );
      }
    }
    const quest3: WeeklyQuestResult = {
      id: 'quest_3_volume',
      title: 'Volumen de Impacto (≥ 5 kg)',
      description: 'Alcanza al menos 5.0 kg pesados acumulados durante la semana.',
      isCompleted: weeklyKg >= 5.0,
      progressLabel: `${weeklyKg.toFixed(1)} / 5.0 kg`,
      progressPercent: Math.min(1.0, weeklyKg / 5.0),
    };

    // Misión 4: Separación Multimaterial (≥ 2 categorías distintas)
    const materialCategories = new Set<string>();
    for (const r of completedWeeklyRequests) {
      const actual = (r.actualWeights as Record<string, number>) || {};
      const targetObj =
        Object.keys(actual).length > 0
          ? actual
          : ((r.itemsEstimated as Record<string, number>) || {});
      for (const k of Object.keys(targetObj)) {
        materialCategories.add(k.toUpperCase().trim());
      }
    }
    const matCount = materialCategories.size;
    const quest4: WeeklyQuestResult = {
      id: 'quest_4_multi_material',
      title: 'Separación Multimaterial',
      description: 'Entrega al menos 2 materiales distintos valorizables (ej. Plástico y Cartón).',
      isCompleted: matCount >= 2,
      progressLabel: `${matCount} / 2 tipos`,
      progressPercent: Math.min(1.0, matCount / 2.0),
    };

    // Misión 5: Material de Alto Impacto (Vidrio o Metal/Aluminio)
    const hasHighImpact = Array.from(materialCategories).some(
      (m) =>
        m.includes('VIDRIO') ||
        m.includes('ALUMINIO') ||
        m.includes('METAL') ||
        m.includes('LATA'),
    );
    const quest5: WeeklyQuestResult = {
      id: 'quest_5_high_impact_material',
      title: 'Material de Alto Impacto',
      description: 'Incluye al menos un lote con metales (aluminio) o vidrio reciclado.',
      isCompleted: hasHighImpact,
      progressLabel: hasHighImpact ? '1 / 1 cumplido' : '0 / 1 cumplido',
      progressPercent: hasHighImpact ? 1.0 : 0.0,
    };

    // Misión 6: Consumo en Comercio Aliado (Canje con LIVO)
    const redemptionsCount = weeklyRedemptions.length;
    const quest6: WeeklyQuestResult = {
      id: 'quest_6_store_redemption',
      title: 'Consumo en Comercio Aliado',
      description: 'Realiza al menos 1 canje o compra utilizando tokens LIVO en una tienda física.',
      isCompleted: redemptionsCount >= 1,
      progressLabel: `${redemptionsCount} / 1 canje`,
      progressPercent: redemptionsCount >= 1 ? 1.0 : 0.0,
    };

    const quests = [quest1, quest2, quest3, quest4, quest5, quest6];
    const completedQuestsCount = quests.filter((q) => q.isCompleted).length;

    let stage = 1;
    let stageTitle = 'Semilla Brotando';
    let stageSubtitle = 'Siembra tu esfuerzo completando tus primeras misiones.';

    if (completedQuestsCount < 2) {
      stage = 1;
      stageTitle = 'Semilla Brotando';
      stageSubtitle = 'Siembra tu esfuerzo completando tus primeras misiones.';
    } else if (completedQuestsCount < 4) {
      stage = 2;
      stageTitle = 'Brote con Tallo';
      stageSubtitle = 'Tu hábito está echando raíces. Avanza hacia el árbol joven.';
    } else if (completedQuestsCount < 6) {
      stage = 3;
      stageTitle = 'Árbol Joven Floreciendo';
      stageSubtitle = '¡Recompensa intermedia desbloqueada (+0.50 LIVO)! A 2 pasos del Árbol Dorado.';
    } else {
      stage = 4;
      stageTitle = 'Gran Árbol Dorado Frondoso';
      stageSubtitle = '¡Semana Perfecta! Corona dorada y máximo honor en tu Arboleda (+1.00 LIVO extra).';
    }

    // Verificar reclamos previos registrados en transferencias con prefijo FOREST_
    const correlationStage3 = `FOREST_STAGE_3_${weekKey}`;
    const correlationStage4 = `FOREST_STAGE_4_${weekKey}`;

    const previousClaims = await this.prisma.walletTransfer.findMany({
      where: {
        receiverUserId: userId,
        status: 'COMPLETED',
        note: {
          startsWith: 'FOREST_',
        },
      },
    });

    const claimedStage3 = previousClaims.some(
      (p) => p.note === correlationStage3,
    );
    const claimedStage4 = previousClaims.some(
      (p) => p.note === correlationStage4,
    );

    return {
      stage,
      stageTitle,
      stageSubtitle,
      quests,
      completedQuestsCount,
      progressPercent: Math.min(1.0, completedQuestsCount / 6.0),
      claimedStage3Reward: claimedStage3,
      claimedStage4Reward: claimedStage4,
      daysLeftInWeek: daysLeft,
      weekLabel: this.getWeekLabel(now),
      weekKey,
      kycStatus: user.kycStatus,
      canClaimStage3: stage >= 3 && !claimedStage3,
      canClaimStage4: stage >= 4 && !claimedStage4,
    };
  }

  /**
   * Reclama la recompensa de Etapa 3 o Etapa 4 de forma atómica y auditable.
   */
  async claimWeeklyReward(userId: string, dto: ClaimRewardDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== Role.HOGAR) {
      throw new ForbiddenException(
        'Solo cuentas con rol HOGAR pueden reclamar recompensas de Mi Bosque.',
      );
    }

    // REGLA INSTITUCIONAL DE CUMPLIMIENTO:
    // La recompensa exige que la cuenta esté verificada para acreditar tokens LIVO on-chain.
    if (user.kycStatus !== 'APPROVED') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'KYC_REQUIRED',
        message:
          'Para reclamar y retirar tus tokens LIVO, tu identidad debe estar validada conforme a ley. Tus recompensas permanecerán reservadas.',
      });
    }

    const state = await this.getWeeklyForestState(userId);
    const correlationKey = `FOREST_${dto.stage}_${state.weekKey}`;

    if (dto.stage === 'STAGE_3') {
      if (state.stage < 3) {
        throw new BadRequestException(
          'Aún no has completado las 4 misiones necesarias para la Etapa 3.',
        );
      }
      if (state.claimedStage3Reward) {
        throw new BadRequestException(
          'La recompensa de Etapa 3 para esta semana ya fue reclamada.',
        );
      }
    } else if (dto.stage === 'STAGE_4') {
      if (state.stage < 4) {
        throw new BadRequestException(
          'Aún no has completado las 6 misiones requeridas para el Árbol Dorado (Etapa 4).',
        );
      }
      if (state.claimedStage4Reward) {
        throw new BadRequestException(
          'La recompensa de Etapa 4 para esta semana ya fue reclamada.',
        );
      }
    }

    const rewardAmount = dto.stage === 'STAGE_3' ? 0.5 : 1.0;
    const systemWallet = 'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB';

    // Obtener el usuario administrador o tesorería del sistema para ser el remitente
    const systemAdmin = await this.prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true, walletAddress: true },
    });

    // Registrar la recompensa en wallet_transfers como abono formal del sistema hacia el usuario
    const transfer = await this.prisma.walletTransfer.create({
      data: {
        senderUserId: systemAdmin?.id ?? userId,
        receiverUserId: userId,
        fromAddress: systemAdmin?.walletAddress || systemWallet,
        toAddress: user.walletAddress || systemWallet,
        amount: rewardAmount,
        note: correlationKey,
        status: 'COMPLETED',
      },
    });

    this.logger.log(
      `Recompensa de Mi Bosque (${dto.stage}, +${rewardAmount} LIVO) acreditada con éxito para usuario ${userId}. Transfer ID: ${transfer.id}`,
    );

    return {
      status: 'SUCCESS',
      message: `¡Felicitaciones! Has recibido +${rewardAmount.toFixed(2)} LIVO por tu compromiso ambiental.`,
      rewardAmount,
      stage: dto.stage,
      transferId: transfer.id,
      weekKey: state.weekKey,
    };
  }
}

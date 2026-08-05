import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CentersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Genera un PIN aleatorio de 4 dígitos numéricos (1000 - 9999)
   */
  private generatePin(): string {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  /**
   * GET /centers/me/reception-pin (Rol: CENTRO_ACOPIO)
   * Devuelve el PIN de recepción del centro de acopio autenticado. Si no posee uno, lo genera y guarda.
   */
  async getReceptionPin(centerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: centerId },
    });

    if (!user) {
      throw new NotFoundException('Usuario Centro de Acopio no encontrado');
    }

    if (user.receptionPin) {
      return { receptionPin: user.receptionPin };
    }

    // Si no tiene PIN configurado, generar uno por defecto y guardarlo
    const newPin = this.generatePin();
    const updatedUser = await this.prisma.user.update({
      where: { id: centerId },
      data: { receptionPin: newPin },
    });

    return { receptionPin: updatedUser.receptionPin };
  }

  /**
   * POST /centers/me/reception-pin/refresh (Rol: CENTRO_ACOPIO)
   * Genera un nuevo PIN aleatorio de 4 dígitos numéricos, actualiza la BD y lo retorna.
   */
  async refreshReceptionPin(centerId: string) {
    const newPin = this.generatePin();

    const updatedUser = await this.prisma.user.update({
      where: { id: centerId },
      data: { receptionPin: newPin },
    });

    return { receptionPin: updatedUser.receptionPin };
  }
}

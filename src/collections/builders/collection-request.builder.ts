import { BadRequestException } from '@nestjs/common';
import { AssignmentMode, RequestStatus } from '@prisma/client';

export interface ICollectionRequestPayload {
  householdId: string;
  itemsEstimated: Record<string, number>;
  latitude: number;
  longitude: number;
  address?: string;
  description?: string;
  photoUrl?: string;
  verificationPin: string;
  assignmentMode: AssignmentMode;
  status: RequestStatus;
  assignedCenterId?: string;
  agreedRates?: Record<string, number>;
  escrowLocked?: number;
  isDonation: boolean;
  auctionExpiresAt?: Date;
}

/**
 * Patrón Builder (PUCP Disoft Diapositiva 04)
 * Construye de manera incremental y segura el agregado de una solicitud de recolección,
 * asegurando la integridad de datos y encapsulando reglas de validación complejas.
 */
export class CollectionRequestBuilder {
  private payload: Partial<ICollectionRequestPayload> = {
    assignmentMode: AssignmentMode.AUTOMATIC,
    status: RequestStatus.PENDING,
    isDonation: false,
    escrowLocked: 0,
  };

  public setHousehold(householdId: string): this {
    if (!householdId) {
      throw new BadRequestException('El ID del hogar solicitante es obligatorio');
    }
    this.payload.householdId = householdId;
    return this;
  }

  public setCoordinates(lat: number, lon: number): this {
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      throw new BadRequestException('Coordenadas geográficas inválidas');
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new BadRequestException('Coordenadas fuera del rango WGS-84');
    }
    this.payload.latitude = lat;
    this.payload.longitude = lon;
    return this;
  }

  public setItems(items: Record<string, number>): this {
    if (!items || Object.keys(items).length === 0) {
      throw new BadRequestException('Debe declarar al menos un material a recolectar');
    }
    for (const [mat, weight] of Object.entries(items)) {
      const w = Number(weight);
      if (isNaN(w) || w <= 0) {
        throw new BadRequestException(`El peso estimado para ${mat} debe ser mayor a 0`);
      }
    }
    this.payload.itemsEstimated = items;
    return this;
  }

  public setAddress(address?: string): this {
    this.payload.address = address?.trim();
    return this;
  }

  public setDescription(desc?: string): this {
    this.payload.description = desc?.trim();
    return this;
  }

  public setPhotoUrl(photoUrl?: string): this {
    this.payload.photoUrl = photoUrl;
    return this;
  }

  public setVerificationPin(pin: string): this {
    if (!pin || pin.length < 4) {
      throw new BadRequestException('El PIN de verificación debe tener al menos 4 dígitos');
    }
    this.payload.verificationPin = pin;
    return this;
  }

  public setAssignmentMode(mode: AssignmentMode, auctionDurationMinutes?: number): this {
    this.payload.assignmentMode = mode;
    if (mode === AssignmentMode.AUCTION) {
      this.payload.status = RequestStatus.AUCTION_ACTIVE;
      const duration = auctionDurationMinutes || 120;
      this.payload.auctionExpiresAt = new Date(Date.now() + duration * 60 * 1000);
    }
    return this;
  }

  public setAssignedCenter(centerId?: string, rates?: Record<string, number>): this {
    if (centerId) {
      this.payload.assignedCenterId = centerId;
    }
    if (rates) {
      this.payload.agreedRates = rates;
    }
    return this;
  }

  public setIsDonation(isDonation: boolean): this {
    this.payload.isDonation = isDonation;
    return this;
  }

  public build(): ICollectionRequestPayload {
    if (!this.payload.householdId) {
      throw new BadRequestException('householdId es requerido para construir la solicitud');
    }
    if (this.payload.latitude === undefined || this.payload.longitude === undefined) {
      throw new BadRequestException('Coordenadas geográficas son requeridas');
    }
    if (!this.payload.itemsEstimated) {
      throw new BadRequestException('itemsEstimated es requerido');
    }
    if (!this.payload.verificationPin) {
      throw new BadRequestException('verificationPin es requerido');
    }

    return this.payload as ICollectionRequestPayload;
  }
}

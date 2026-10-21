import { BadRequestException } from '@nestjs/common';
import { AssignmentMode, RequestStatus } from '@prisma/client';
import { CollectionRequestBuilder } from './collection-request.builder';

describe('Patrón Builder: CollectionRequestBuilder (PUCP Disoft Diapositiva 04)', () => {
  let builder: CollectionRequestBuilder;

  beforeEach(() => {
    builder = new CollectionRequestBuilder();
  });

  it('debe construir una solicitud válida con todos los atributos mandatorios', () => {
    const payload = builder
      .setHousehold('user-household-123')
      .setCoordinates(-12.0694, -77.0805)
      .setItems({ PLASTIC: 5.5, CARTON: 10 })
      .setVerificationPin('4829')
      .setAddress('Av. Universitaria 1801, San Miguel')
      .setDescription('3 bolsas rotuladas de botellas y cartón limpio')
      .setIsDonation(false)
      .build();

    expect(payload.householdId).toBe('user-household-123');
    expect(payload.latitude).toBe(-12.0694);
    expect(payload.longitude).toBe(-77.0805);
    expect(payload.verificationPin).toBe('4829');
    expect(payload.assignmentMode).toBe(AssignmentMode.AUTOMATIC);
    expect(payload.status).toBe(RequestStatus.PENDING);
    expect(payload.isDonation).toBe(false);
  });

  it('debe configurar correctamente el modo subasta y tiempo de expiración', () => {
    const payload = builder
      .setHousehold('user-household-123')
      .setCoordinates(-12.0694, -77.0805)
      .setItems({ PLASTIC: 5.5 })
      .setVerificationPin('1234')
      .setAssignmentMode(AssignmentMode.AUCTION, 30)
      .build();

    expect(payload.assignmentMode).toBe(AssignmentMode.AUCTION);
    expect(payload.status).toBe(RequestStatus.AUCTION_ACTIVE);
    expect(payload.auctionExpiresAt).toBeDefined();
    expect(payload.auctionExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('debe lanzar BadRequestException si falta el householdId', () => {
    builder
      .setCoordinates(-12.0694, -77.0805)
      .setItems({ PLASTIC: 5.5 })
      .setVerificationPin('1234');

    expect(() => builder.build()).toThrow(BadRequestException);
  });

  it('debe lanzar BadRequestException si las coordenadas están fuera de rango WGS-84', () => {
    expect(() => builder.setCoordinates(195.0, -77.0)).toThrow(
      BadRequestException,
    );
    expect(() => builder.setCoordinates(-12.0, -200.0)).toThrow(
      BadRequestException,
    );
  });

  it('debe lanzar BadRequestException si los items están vacíos o peso es 0', () => {
    expect(() => builder.setItems({})).toThrow(BadRequestException);
    expect(() => builder.setItems({ PLASTIC: 0 })).toThrow(
      BadRequestException,
    );
  });
});

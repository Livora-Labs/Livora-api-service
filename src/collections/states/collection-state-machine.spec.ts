import { ConflictException } from '@nestjs/common';
import { RequestStatus } from '@prisma/client';
import { CollectionStateMachine } from './collection-state-machine';

describe('Patrón Estado: CollectionStateMachine (PUCP Disoft Diapositiva 06)', () => {
  it('debe permitir transiciones legales válidas', () => {
    // PENDING -> ACCEPTED
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.PENDING,
        RequestStatus.ACCEPTED,
      ),
    ).not.toThrow();

    // ACCEPTED -> EN_ROUTE
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.ACCEPTED,
        RequestStatus.EN_ROUTE,
      ),
    ).not.toThrow();

    // EN_ROUTE -> ARRIVED
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.EN_ROUTE,
        RequestStatus.ARRIVED,
      ),
    ).not.toThrow();

    // ARRIVED -> COMPLETED
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.ARRIVED,
        RequestStatus.COMPLETED,
      ),
    ).not.toThrow();
  });

  it('debe rechazar con ConflictException transiciones ilegales arbitrarias', () => {
    // No se puede saltar directamente de PENDING a COMPLETED
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.PENDING,
        RequestStatus.COMPLETED,
      ),
    ).toThrow(ConflictException);

    // No se puede modificar una solicitud ya completada
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.COMPLETED,
        RequestStatus.PENDING,
      ),
    ).toThrow(ConflictException);

    // No se puede pasar de CANCELLED a EN_ROUTE
    expect(() =>
      CollectionStateMachine.validateTransition(
        RequestStatus.CANCELLED,
        RequestStatus.EN_ROUTE,
      ),
    ).toThrow(ConflictException);
  });

  it('debe evaluar correctamente estados terminales', () => {
    expect(CollectionStateMachine.isTerminal(RequestStatus.COMPLETED)).toBe(true);
    expect(CollectionStateMachine.isTerminal(RequestStatus.CANCELLED)).toBe(true);
    expect(CollectionStateMachine.isTerminal(RequestStatus.UNATTENDED)).toBe(true);
    expect(CollectionStateMachine.isTerminal(RequestStatus.REJECTED_ON_SITE)).toBe(true);
    expect(CollectionStateMachine.isTerminal(RequestStatus.ACCEPTED)).toBe(false);
  });

  it('debe determinar correctamente si se puede verificar el PIN en campo', () => {
    expect(CollectionStateMachine.canVerifyPin(RequestStatus.ACCEPTED)).toBe(true);
    expect(CollectionStateMachine.canVerifyPin(RequestStatus.EN_ROUTE)).toBe(true);
    expect(CollectionStateMachine.canVerifyPin(RequestStatus.ARRIVED)).toBe(true);
    expect(CollectionStateMachine.canVerifyPin(RequestStatus.PENDING)).toBe(false);
    expect(CollectionStateMachine.canVerifyPin(RequestStatus.COMPLETED)).toBe(false);
  });
});

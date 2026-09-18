import { Reflector } from '@nestjs/core';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { Role } from '@prisma/client';

describe('InventoryController Roles & Authorization Spec', () => {
  let controller: InventoryController;
  const reflector = new Reflector();

  beforeEach(() => {
    const mockService = {} as any;
    controller = new InventoryController(mockService);
  });

  it('debe contener TIENDA y CENTRO_ACOPIO en getInventory y excluir ALMACEN', () => {
    const roles = reflector.get<Role[]>('roles', controller.getInventory);
    expect(roles).toContain(Role.CENTRO_ACOPIO);
    expect(roles).toContain(Role.TIENDA);
    expect(roles).toContain(Role.ADMIN);
    // TypeScript impide usar Role.ALMACEN porque fue purgado
    expect((Role as any).ALMACEN).toBeUndefined();
  });

  it('debe contener TIENDA y CENTRO_ACOPIO en getMovements', () => {
    const roles = reflector.get<Role[]>('roles', controller.getMovements);
    expect(roles).toContain(Role.CENTRO_ACOPIO);
    expect(roles).toContain(Role.TIENDA);
    expect(roles).toContain(Role.ADMIN);
  });

  it('debe contener TIENDA y CENTRO_ACOPIO en createMovement', () => {
    const roles = reflector.get<Role[]>('roles', controller.createMovement);
    expect(roles).toContain(Role.CENTRO_ACOPIO);
    expect(roles).toContain(Role.TIENDA);
  });
});

import { User, ConsentAudit } from '@prisma/client';
import { RegisterDto } from '../../auth/dto/register.dto';
import { UpdateUserDto } from '../dto/update-user.dto';

/**
 * Patrón Data Mapper / Repositorio de Usuarios (PUCP Disoft Diapositivas 08 y 09)
 * Interfaz común para el repositorio concreto y el Proxy de caché.
 */
export interface IUsersRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(data: any): Promise<User>;
  update(id: string, data: any): Promise<User>;
  updateFcmToken(id: string, fcmToken: string): Promise<User>;
  getConsentAudits(userId: string): Promise<ConsentAudit[]>;
}

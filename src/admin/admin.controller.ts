import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AdminService } from './admin.service';
import { CreateKycApplicationDto } from '../kyc/dto/create-kyc-application.dto';
import { CreateB2bApplicationDto } from '../b2b/dto/create-b2b-application.dto';
import { UpdateKycStatusDto } from './dto/update-kyc-status.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateComplaintStatusDto } from '../complaints/dto/update-complaint-status.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { FindUsersAdminQueryDto } from './dto/find-users-admin-query.dto';
import { LedgerAuditQueryDto, ServerLogsQueryDto } from './dto/audit-query.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Admin & KYC')
@Controller()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('collectors/kyc-applications')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Enviar solicitud de verificación KYC (Rol: RECOLECTOR)',
  })
  async createKycApplication(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateKycApplicationDto,
  ) {
    return this.adminService.createKycApplication(userId, dto);
  }

  @Get('collectors/me/kyc-application')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Consultar mi estado de verificación KYC (Rol: RECOLECTOR)',
  })
  async getMyKycApplication(@CurrentUser('id') userId: string) {
    return this.adminService.getMyKycApplication(userId);
  }

  @Post('b2b/applications')
  @ApiOperation({ summary: 'Registrar solicitud de afiliación B2B (Público)' })
  async createB2bApplication(@Body() dto: CreateB2bApplicationDto) {
    return this.adminService.createB2bApplication(dto);
  }

  @Get('admin/kyc-applications')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Listar solicitudes KYC pendientes (Rol: ADMIN)' })
  async getKycApplications(@Query() query: PaginationQueryDto) {
    return this.adminService.getKycApplications(query);
  }

  @Get('admin/users')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Listar todos los usuarios registrados del sistema con paginación y filtros (Rol: ADMIN)',
  })
  async getUsers(@Query() query: FindUsersAdminQueryDto) {
    return this.adminService.getUsers(query);
  }

  @Patch('users/:id/kyc-status')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Actualizar estado de verificación KYC de usuario (Rol: ADMIN)',
  })
  async updateUserKycStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKycStatusDto,
  ) {
    return this.adminService.updateUserKycStatus(id, dto);
  }

  @Patch('users/:id/status')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Baneo o activación de estado de usuario (Rol: ADMIN)',
  })
  async updateUserStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(id, dto);
  }

  @Get('admin/blockchain/health')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Obtener estado de salud en tiempo real del cluster RPC Stellar (Rol: ADMIN)',
  })
  async getBlockchainHealth() {
    return this.adminService.getBlockchainHealth();
  }

  @Get('admin/audit/reconciliation')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Auditoría de conciliación contable de partida doble Zero Loss (Rol: ADMIN)',
  })
  async getFinancialReconciliation() {
    return this.adminService.getFinancialReconciliation();
  }

  @Get('admin/audit/ledger')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Auditoría paginada y filtrada del Libro Mayor de cuentas y tokens (Rol: ADMIN)',
  })
  async getLedgerAudit(@Query() query: LedgerAuditQueryDto) {
    return this.adminService.getLedgerAudit(query);
  }

  @Get('admin/audit/queues')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Inspección de colas BullMQ, Dead-Letter Queue (DLQ) y eventos Outbox (Rol: ADMIN)',
  })
  async getQueueAudit() {
    return this.adminService.getQueueAudit();
  }

  @Post('admin/audit/queues/retry-job/:jobId')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Reintentar manualmente un trabajo de la cola BullMQ o DLQ (Rol: ADMIN)',
  })
  async retryQueueJob(@Param('jobId') jobId: string) {
    return this.adminService.retryQueueJob(jobId);
  }

  @Post('admin/audit/outbox/retry-event/:id')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Restablecer evento Outbox a PENDING para reprocesamiento (Rol: ADMIN)',
  })
  async retryOutboxEvent(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.retryOutboxEvent(id);
  }

  @Get('admin/audit/logs')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Consultar buffer circular de logs operativos del servidor con filtros de severidad (Rol: ADMIN)',
  })
  async getServerLogs(@Query() query: ServerLogsQueryDto) {
    return this.adminService.getServerLogs(query);
  }

  @Patch('complaints/:id')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Actualizar estado de un reclamo/queja (Rol: ADMIN)',
  })
  async updateComplaintStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.adminService.updateComplaintStatus(id, dto);
  }

  @Post('admin/payments/:id/retry-mint')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Re-ejecución administrativa de minteo de tokens para pagos con cobro fiduciario confirmado (Rol: ADMIN)',
  })
  async retryPaymentMint(@Param('id') id: string) {
    return this.adminService.retryPaymentMint(id);
  }
}

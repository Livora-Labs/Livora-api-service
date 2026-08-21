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
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
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
    summary: 'Obtener estado de salud del nodo Blockchain (Rol: ADMIN)',
  })
  async getBlockchainHealth() {
    return this.adminService.getBlockchainHealth();
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
}

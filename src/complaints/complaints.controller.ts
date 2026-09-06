import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { ComplaintsService } from './complaints.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Libro de Reclamaciones')
@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ complaints: { limit: 30, ttl: 3600000 } })
  @ApiOperation({
    summary:
      'Registrar una nueva queja o reclamo en el Libro de Reclamaciones Virtual (Ley 29571 / Indecopi) — Máx. 3 por hora por IP',
  })
  @ApiResponse({
    status: 201,
    description: 'Reclamación registrada exitosamente',
  })
  @ApiResponse({
    status: 429,
    description: 'Límite de reclamos excedido. Máximo 3 por hora por IP.',
  })
  async create(
    @Body() createComplaintDto: CreateComplaintDto,
    @Req() req: FastifyRequest,
  ) {
    const authenticatedUser = (req as any).user;
    return this.complaintsService.createComplaint(
      createComplaintDto,
      authenticatedUser?.id,
    );
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @ApiOperation({
    summary: 'Obtener el estado y detalle de una reclamación por ID (Titular o Admin)',
  })
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    const complaint = await this.complaintsService.getComplaintById(id);
    if (user.role !== Role.ADMIN && complaint.userId !== user.id) {
      throw new ForbiddenException(
        'No tienes autorización para consultar esta reclamación',
      );
    }
    return complaint;
  }

  @Get('correlative/:correlativeNumber')
  @ApiOperation({
    summary:
      'Consultar una reclamación por su número correlativo oficial (Consulta pública de seguimiento / Ley 29571)',
  })
  async getByCorrelative(
    @Param('correlativeNumber') correlativeNumber: string,
  ) {
    return this.complaintsService.getComplaintByCorrelative(correlativeNumber);
  }

  @Get(':id/pdf')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Descargar copia en PDF de la Hoja de Reclamación (Titular o Admin)' })
  async downloadPdfById(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<StreamableFile> {
    const complaint = await this.complaintsService.getComplaintById(id);
    if (user.role !== Role.ADMIN && complaint.userId !== user.id) {
      throw new ForbiddenException(
        'No tienes autorización para descargar esta reclamación',
      );
    }
    const pdfBuffer =
      await this.complaintsService.generateComplaintPdf(complaint);
    return new StreamableFile(pdfBuffer, {
      type: 'application/pdf',
      disposition: `inline; filename="Hoja-Reclamacion-${complaint.correlativeNumber}.pdf"`,
    });
  }

  @Get('correlative/:correlativeNumber/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({
    summary: 'Descargar copia en PDF de la Hoja de Reclamación por correlativo (Consulta pública / Ley 29571)',
  })
  async downloadPdfByCorrelative(
    @Param('correlativeNumber') correlativeNumber: string,
  ): Promise<StreamableFile> {
    const complaint =
      await this.complaintsService.getComplaintByCorrelative(correlativeNumber);
    const pdfBuffer =
      await this.complaintsService.generateComplaintPdf(complaint);
    return new StreamableFile(pdfBuffer, {
      type: 'application/pdf',
      disposition: `inline; filename="Hoja-Reclamacion-${complaint.correlativeNumber}.pdf"`,
    });
  }

  @Patch(':id/status')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Actualizar el estado del ciclo de vida y sustento legal de una reclamación (Rol: ADMIN)',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado de reclamación actualizado con éxito',
  })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.complaintsService.updateComplaintStatus(id, dto);
  }
}

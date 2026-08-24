import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ComplaintsService } from './complaints.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';

@ApiTags('Libro de Reclamaciones')
@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ complaints: { limit: 3, ttl: 3600000 } })
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
  async create(@Body() createComplaintDto: CreateComplaintDto) {
    return this.complaintsService.createComplaint(createComplaintDto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener el estado y detalle de una reclamación por ID',
  })
  async getById(@Param('id') id: string) {
    return this.complaintsService.getComplaintById(id);
  }

  @Get('correlative/:correlativeNumber')
  @ApiOperation({
    summary:
      'Consultar una reclamación por su número correlativo oficial (ej. R-00001-2026)',
  })
  async getByCorrelative(
    @Param('correlativeNumber') correlativeNumber: string,
  ) {
    return this.complaintsService.getComplaintByCorrelative(correlativeNumber);
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Descargar copia en PDF de la Hoja de Reclamación' })
  async downloadPdfById(@Param('id') id: string): Promise<StreamableFile> {
    const complaint = await this.complaintsService.getComplaintById(id);
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
    summary: 'Descargar copia en PDF de la Hoja de Reclamación por correlativo',
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
}

import { Body, Controller, Get, HttpCode, HttpStatus, ParseFloatPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RoutingService } from './routing.service';
import { RoutingRequestDto } from './dto/routing-request.dto';
import { RoutingResponseDto } from './dto/routing-response.dto';
import { OptimizeTripDto } from './dto/optimize-trip.dto';

@ApiTags('Routing')
@ApiBearerAuth()
@Controller('routing')
@UseGuards(JwtAuthGuard)
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calcula ruta A->B mediante proxy OSRM con caché Redis y fallback Haversine',
  })
  @ApiResponse({
    status: 200,
    description: 'Polilínea GeoJSON y estimación calculada exitosamente',
    type: RoutingResponseDto,
  })
  async getRoute(@Body() dto: RoutingRequestDto): Promise<RoutingResponseDto> {
    return this.routingService.calculateRoute(dto);
  }

  @Post('optimize-trip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Optimización de ruta multi-parada (VRP / Traveling Salesperson) para recolectores en ruta',
  })
  async optimizeTrip(@Body() dto: OptimizeTripDto) {
    return this.routingService.optimizeTrip(dto);
  }

  @Get('geocode/search')
  @ApiOperation({
    summary: 'Búsqueda predictiva de direcciones con proxy seguro y caché Redis',
  })
  async searchGeocode(@Query('q') q: string) {
    return this.routingService.searchAddress(q || '');
  }

  @Get('geocode/reverse')
  @ApiOperation({
    summary: 'Geocodificación inversa con proxy seguro y caché Redis',
  })
  async reverseGeocode(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
  ) {
    return this.routingService.reverseGeocode(lat, lng);
  }
}

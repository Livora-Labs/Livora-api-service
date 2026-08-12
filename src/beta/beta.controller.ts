import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BetaService } from './beta.service';
import { CreateBetaSignupDto } from './dto/create-beta-signup.dto';

@ApiTags('Beta')
@Controller('beta-signups')
export class BetaController {
  constructor(private readonly betaService: BetaService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Registro público en la lista de espera de la beta (landing)' })
  async create(@Body() dto: CreateBetaSignupDto) {
    await this.betaService.register(dto.email);
    return { success: true };
  }
}

import { Controller, Get } from '@nestjs/common';

/**
 * The platform checks these every few seconds to decide whether to restart the service or
 * send it traffic. They aren't logged, so the logs show real traffic.
 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: string } {
    return { status: 'ok' };
  }
}

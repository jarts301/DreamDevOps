import { Module } from '@nestjs/common';
import { ApiController } from './api.controller.ts';
import { Greeter } from './greeter.ts';
import { HealthController } from './health.controller.ts';

@Module({
  controllers: [HealthController, ApiController],
  providers: [Greeter],
})
export class AppModule {}

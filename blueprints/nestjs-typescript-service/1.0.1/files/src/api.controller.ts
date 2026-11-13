import { BadRequestException, Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Greeter } from './greeter.ts';

/** The service's own routes. Each logs with its request, which carries the request's trace. */
@Controller('api')
export class ApiController {
  // Injected by name, rather than from the parameter's type, so it doesn't depend on decorator metadata.
  constructor(@Inject(Greeter) private readonly greeter: Greeter) {}

  /** Answers without doing anything, to check the service can be reached, and logs that it was. */
  @Get('ping')
  ping(@Req() request: Request): { status: string; time: string } {
    request.log.info('Ping received');
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Get('hello')
  hello(@Req() request: Request, @Query('name') name: unknown = 'world'): { message: string } {
    if (typeof name !== 'string' || name.length < 1 || name.length > 100) {
      throw new BadRequestException('name must be between 1 and 100 characters.');
    }
    request.log.info({ greeted: name }, 'Greeting sent');
    return { message: this.greeter.greet(name) };
  }
}

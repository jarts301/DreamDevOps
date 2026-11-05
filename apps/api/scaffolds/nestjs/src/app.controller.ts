import { Controller, Get } from '@nestjs/common';
import about from './about.json' with { type: 'json' };

@Controller()
export class AppController {
  @Get()
  about(): { name: string; description: string } {
    return about;
  }
}

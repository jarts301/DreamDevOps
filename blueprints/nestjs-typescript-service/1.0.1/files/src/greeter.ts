import { Injectable } from '@nestjs/common';

/** Makes greetings. Routes get it injected, as a Nest provider. */
@Injectable()
export class Greeter {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

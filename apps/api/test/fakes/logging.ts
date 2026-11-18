import type { Logger } from '@dreamdevops/shared-kernel';

/** A logger that keeps what it's told, so tests can check what operators would see. */
export class RecordingLogger implements Logger {
  readonly lines: string[] = [];

  log(message: string): void {
    this.lines.push(`log: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  error(message: string, stack?: string): void {
    this.lines.push(`error: ${message}${stack === undefined ? '' : ` ${stack}`}`);
  }
}

import { HttpErrorResponse } from '@angular/common/http';

/** Turns a failed request into a message for the user. The API's messages are safe to show. */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return "We can't reach the server. Check your connection and try again.";
    }
    const body = error.error as { detail?: unknown; title?: unknown } | null;
    if (typeof body?.detail === 'string') {
      return body.detail;
    }
    if (typeof body?.title === 'string') {
      return body.title;
    }
  }
  return 'Something went wrong. Try again.';
}

import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { SessionService } from './session.service';

/** When a session ends mid-use, goes back to login. Asking who is signed in may answer 401. */
export const sessionExpiredInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(SessionService);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && !request.url.endsWith('/auth/me')) {
        session.signIn();
      }
      return throwError(() => error);
    }),
  );
};

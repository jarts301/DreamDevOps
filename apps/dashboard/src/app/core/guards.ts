import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { PendingInvitation } from './pending-invitation';
import { SessionService } from './session.service';

/** Sends anonymous users to login, and returns people who were accepting an invitation to it. */
export const authGuard: CanActivateFn = async () => {
  const session = inject(SessionService);
  const pendingInvitation = inject(PendingInvitation);
  const router = inject(Router);

  if ((await session.load()) === null) {
    session.signIn();
    return false;
  }
  return pendingInvitation.get() === null ? true : router.parseUrl('/invitations/accept');
};

/**
 * Hides screens the user can't use. This is for the user's convenience only: the API
 * checks every request, so changing anything in the browser grants nothing.
 */
export const permissionGuard =
  (permission: string): CanActivateFn =>
  async () => {
    // Angular only allows inject() before the first await.
    const session = inject(SessionService);
    const router = inject(Router);
    await session.load();
    return session.can(permission) ? true : router.parseUrl('/not-allowed');
  };

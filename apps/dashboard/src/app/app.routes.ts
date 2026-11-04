import type { Routes } from '@angular/router';
import { authGuard, permissionGuard } from './core/guards';
import { Shell } from './shell/shell';

export const routes: Routes = [
  {
    // Outside the main guard, because it must see the token before any login redirect.
    path: 'invitations/accept',
    title: 'Join a company · DreamDevOps',
    loadComponent: () =>
      import('./features/identity-access/accept-invitation').then((module) => module.AcceptInvitation),
  },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Overview · DreamDevOps',
        loadComponent: () => import('./features/overview/overview').then((module) => module.Overview),
      },
      {
        path: 'team',
        title: 'Team · DreamDevOps',
        canActivate: [permissionGuard('company-users:manage')],
        loadComponent: () => import('./features/identity-access/team').then((module) => module.Team),
      },
      {
        path: 'platform/start-company',
        title: 'Start a company · DreamDevOps',
        canActivate: [permissionGuard('companies:manage')],
        loadComponent: () => import('./features/identity-access/start-company').then((module) => module.StartCompany),
      },
      {
        path: 'not-allowed',
        title: 'No access · DreamDevOps',
        loadComponent: () => import('./features/messages/messages').then((module) => module.NotAllowed),
      },
      {
        path: '**',
        title: 'Page not found · DreamDevOps',
        loadComponent: () => import('./features/messages/messages').then((module) => module.NotFound),
      },
    ],
  },
];

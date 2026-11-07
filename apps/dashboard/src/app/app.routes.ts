import type { Routes } from '@angular/router';
import { authGuard, companyGuard, permissionGuard } from './core/guards';
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
        path: 'applications',
        title: 'Applications · DreamDevOps',
        canActivate: [companyGuard],
        loadComponent: () => import('./features/catalog/applications').then((module) => module.Applications),
      },
      {
        path: 'team',
        title: 'Team · DreamDevOps',
        canActivate: [permissionGuard('company-users:manage')],
        loadComponent: () => import('./features/identity-access/team').then((module) => module.Team),
      },
      {
        path: 'audit',
        title: 'Audit log · DreamDevOps',
        canActivate: [permissionGuard('audit:read')],
        loadComponent: () => import('./features/audit/audit-log').then((module) => module.AuditLog),
      },
      {
        path: 'notifications',
        title: 'Notifications · DreamDevOps',
        canActivate: [permissionGuard('notifications:manage')],
        loadComponent: () => import('./features/notifications/notifications').then((module) => module.Notifications),
      },
      {
        path: 'edition',
        title: 'Edition · DreamDevOps',
        canActivate: [companyGuard],
        loadComponent: () => import('./features/editions/company-edition').then((module) => module.CompanyEdition),
      },
      {
        path: 'platform/editions',
        title: 'Editions · DreamDevOps',
        canActivate: [permissionGuard('editions:manage')],
        loadComponent: () =>
          import('./features/editions/platform-editions').then((module) => module.PlatformEditions),
      },
      {
        path: 'platform/activity',
        title: 'My activity · DreamDevOps',
        canActivate: [permissionGuard('audit:read-own')],
        loadComponent: () => import('./features/audit/my-activity').then((module) => module.MyActivity),
      },
      {
        path: 'platform/companies',
        title: 'Companies · DreamDevOps',
        canActivate: [permissionGuard('companies:manage')],
        loadComponent: () => import('./features/tenancy/companies').then((module) => module.Companies),
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

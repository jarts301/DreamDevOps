import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Home',
    loadComponent: () => import('./home/home').then((module) => module.Home),
  },
  {
    path: 'about',
    title: 'About',
    loadComponent: () => import('./about/about').then((module) => module.About),
  },
  { path: '**', redirectTo: '' },
];

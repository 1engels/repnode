import { createRouter, createWebHistory } from 'vue-router';
import { useSessionStore } from './stores/session';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/reports' },
    { path: '/connect', name: 'connect', component: () => import('./views/ConnectView.vue'), meta: { public: true } },
    { path: '/reports', name: 'reports', component: () => import('./views/ReportsView.vue') },
    { path: '/reports/new', name: 'report-new', component: () => import('./views/ReportEditorView.vue') },
    { path: '/reports/:id/edit', name: 'report-edit', component: () => import('./views/ReportEditorView.vue'), props: true },
    { path: '/tags', name: 'tags', component: () => import('./views/TagsView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/reports' },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  if (!session.checked) await session.check().catch(() => {});
  if (!to.meta.public && !session.connected) return { name: 'connect', query: to.fullPath !== '/reports' ? { next: to.fullPath } : undefined };
});

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { onNotConnected } from './lib/api';
import { useSessionStore } from './stores/session';
import { useCatalogStore } from './stores/catalog';
import { useReportsStore } from './stores/reports';
import { useToastStore } from './stores/toast';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// Si el backend se reinició o perdió la conexión, se vuelve a la pantalla de conexión
onNotConnected(() => {
  const session = useSessionStore();
  if (!session.connected) return;
  session.markDisconnected();
  useCatalogStore().reset();
  useReportsStore().reset();
  useToastStore().error('Se perdió la conexión con SQL Server. Vuelve a conectarte.');
  router.push({ name: 'connect' });
});

app.mount('#app');

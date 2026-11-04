import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { onNotAuthenticated, onNotConnected, setReconnectHandler } from './lib/api';
import { useSessionStore } from './stores/session';
import { useCatalogStore } from './stores/catalog';
import { useReportsStore } from './stores/reports';
import { useToastStore } from './stores/toast';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// La sesión del servidor vence tras unos minutos sin uso: se reconecta sola y la petición se repite
setReconnectHandler(() => useSessionStore().reconnect());

// Modo pme: si la sesión de PME terminó, se pide volver a iniciarla (App.vue muestra el aviso)
onNotAuthenticated((loginUrl) => useSessionStore().markAuthLost(loginUrl));

// Si no se pudo reconectar, se vuelve a la pantalla de conexión
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

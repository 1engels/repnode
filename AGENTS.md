# AGENTS.md — Base de conocimiento de RepNode

Guía técnica para agentes de IA y desarrolladores que trabajen en este repositorio. Describe qué hace el sistema, cómo
está organizado, sus flujos, las decisiones de diseño y los problemas ya resueltos. **Léelo antes de modificar código.**

---

## 1. Propósito

RepNode es un backend Node.js más una GUI web. Funciona en dos modos (`REPNODE_AUTH_MODE`, ver 5.12): **local** (un
usuario en `localhost`, por defecto) o **embebido en PME** (varios usuarios de PME, en un iframe de PME, detrás de su IIS
en `https://<servidor>/repnode/`). Se conecta a la base
**ION_Data de Schneider Electric Power Monitoring Expert (PME)** en SQL Server 2016+ y genera **CSV descargables
compatibles con Excel en Windows** con las mediciones de medidores eléctricos.

Reglas de producto (no negociables):

- **Nada se muestra en pantalla**: los datos de mediciones solo se descargan. La GUI muestra progreso y metadatos, nunca valores.
- **Solo lectura** sobre la BD de PME: únicamente `SELECT` parametrizados. Nunca se crean ni modifican objetos (SP, tablas,
  índices) en ION_Data.
- **Sin huecos sorpresa**: antes de generar se valida que cada medidor tenga datos de cada medición en el rango; si no,
  el botón Generar se bloquea y se explica qué falta. El servidor repite la validación. La única forma de generar con
  faltantes es **"Generar de todas formas"**, con confirmación explícita en cada ejecución (`force: true`); el historial
  la marca como "con faltantes".
- El reemplazo optimizado del software anterior debe dar **los mismos datos** que `spDAL_GetLoggedData_SMP_TV`.
- Debe escalar a cientos o miles de medidores; la referencia es 500 medidores, que en el software anterior tardaban más de 30 min.

Flujos de usuario:

1. Conexión a SQL Server → elegir reporte guardado → generar CSV (descarga).
2. Conexión a SQL Server → nuevo reporte → configurar (medidores, mediciones, rango de fechas, zona horaria, archivo) →
   generar CSV (descarga) y/o guardar.

Idioma: la GUI, los mensajes de error, los comentarios del código y la documentación están en **español**.

---

## 2. Stack y requisitos

| Capa | Tecnología |
|---|---|
| Runtime | **Node.js 24+**. Ejecuta `.ts` de forma nativa (type stripping), sin paso de build en el backend |
| Gestor | **pnpm** workspace (probado con pnpm 11) |
| Backend | Fastify 5, `mssql` 12 (driver `tedious`), `node:sqlite` (incluido en Node), `worker_threads`, `p-limit`, `archiver` 8 (ZIP), `zod` 4, `nanoid`, `pino` |
| Frontend | Vite 8 (rolldown), Vue 3.5 (composition API, `<script setup>`), Tailwind CSS v4 (`@tailwindcss/vite`), Pinia 4, vue-router 5, `@vueuse/core`, `@tanstack/vue-virtual`, Vue Flow (`@vue-flow/core`, `background`, `controls`, `minimap`) y `elkjs` para el diagrama de jerarquías, `@tabler/icons-vue` (íconos de tableros) |
| Compartido | `packages/shared`: esquemas zod, tipos DTO y utilidades puras (zonas horarias, rangos, nombres de archivo) |
| Tipos | TypeScript **~6.0**. No subir a 7 mientras `vue-tsc` dependa de la API JS de TypeScript |
| Pruebas | Vitest 5 |

Decisiones de librerías:

- Se usa **`node:sqlite`** y no `better-sqlite3`, porque el pnpm del usuario tiene `ignoreScripts: true` y los módulos
  nativos no compilarían. No agregar dependencias con binarios nativos.
- `archiver` v8 es ESM con clases nombradas: `import { ZipArchive } from 'archiver'` (no hay export default).
- `@tabler/icons-vue` (JS puro, sin scripts de instalación): importar cada ícono por nombre (`IconPlug`…), nunca el
  paquete completo; el mapa está en `lib/panel-icons.ts`.
- Vue Flow y elkjs son JS puro y se cargan solo en la ruta `/hierarchy` (import dinámico). elkjs corre en un web worker:
  `import ELK from 'elkjs/lib/elk-api.js'` + `workerUrl` de `elkjs/lib/elk-worker.min.js?url` (no usar `elk.bundled.js`,
  que bloquea el hilo principal).
- `@vue-flow/core` (última: 1.48.2) declara `@vueuse/core ^10` y con él arrastraba `vue-demi`. Su bundle solo importa
  `vue` en ejecución (el código de VueUse va inlineado); el paquete solo se usa para tipos (`KeyFilter`). Por eso
  `overrides` en `pnpm-workspace.yaml` fuerza `@vueuse/core ^15` para todo el árbol y `vue-demi` ya no se instala.
  Si al actualizar vue-flow vuelve a aparecer (`pnpm why vue-demi`), revisar si el override sigue haciendo falta.
- Código TS del backend y de `shared`: **solo sintaxis "erasable"** (`erasableSyntaxOnly`). Nada de `enum`, `namespace` ni
  propiedades de parámetro en constructores. Los imports relativos llevan **extensión `.ts`**.

---

## 3. Estructura del repositorio

```
repnode/
├─ AGENTS.md                  ← este archivo
├─ README.md                  documentación para usuarios
├─ package.json               scripts raíz: dev, build, start, serve, typecheck, test
├─ pnpm-workspace.yaml        apps/*, packages/*
├─ tsconfig.base.json         strict, noEmit, verbatimModuleSyntax, erasableSyntaxOnly, allowImportingTsExtensions
├─ .claude/launch.json        servidores de preview: repnode-api (3210) y repnode-web (5173; abrir /repnode/)
├─ deploy/iis/web.config.example  regla de URL Rewrite + ARR para publicar /repnode en el sitio de PME
├─ deploy/iis/repnode-auth/    aplicación IIS /repnode-auth (whoami.ashx + web.config): usuario de la sesión de PME
├─ deploy/iis/instalar-repnode-auth.ps1  crea su pool y aplicación (comprueba antes el machineKey)
├─ deploy/iis/publicar-repnode.ps1  aplica la regla de web.config.example con cmdlets de IIS (respaldo, -Quitar)
├─ database/ION_Data-creation-script.sql   esquema de PME (UTF-16 LE, ~3,5 MB) — solo referencia
├─ data/                      (git-ignorado) app.db, master.key, jobs/ (temporales)
├─ packages/shared/src/
│  ├─ schemas.ts              zod: conexión, rango, salida, selección, reporte, job, tags (+ TAG_PALETTE), presets, settings;
│  │                          BASE_PATH ('/repnode')
│  ├─ types.ts                DTOs de API (catálogo, validación, jobs, historial…)
│  ├─ time.ts                 zonas horarias con Intl: tzOffsetMs, localToUtcMs, LocalTimeFormatter (caché 15 min)
│  ├─ range.ts                resolveRange(): rangos fijos y relativos → local + UTC
│  ├─ filename.ts             sanitizeFileName() (Windows) y renderFileName() (plantilla con tokens)
│  ├─ list-selection.ts       clickSelect() (clic/Ctrl/Shift estilo explorador) y checkboxSelect() (+ pruebas)
│  ├─ grid.ts                 grilla para completar filas: makeGrid, gridSlotCount, isOnGrid, MAX_GRID_ROWS (+ pruebas)
│  ├─ timestamp-layout.ts     formato por estampa de tiempo: orden de columnas y reparto en archivos (+ pruebas)
│  ├─ hierarchy.ts            jerarquías: grafo de suministro, árbol de espacios, ciclos, planes al soltar, diagnóstico,
│  │                          árbol aplanado para listas, orden indentado de tableros (+ pruebas)
│  ├─ hierarchy-export.ts     supplyCsvRows/spacesCsvRows: tablas CSV de las jerarquías (+ pruebas)
│  ├─ pme-user.ts             pmeDisplayName(): nombre visible de un IdentityId de PME (+ pruebas)
│  └─ time.test.ts
├─ apps/server/
│  ├─ src/
│  │  ├─ index.ts             Fastify, filtro de Host, manejo de errores, registro de rutas, estáticos en prod
│  │  ├─ config.ts            host/puerto/rutas de datos (variables REPNODE_*), flag --prod, runtimeConfig
│  │  ├─ runtime-config.ts    parseRuntimeConfig(): modo (none|pme), hosts, sesiones, topes, autenticación PME
│  │  ├─ multiuser.test.ts    pruebas de configuración, cookies, PME, CSRF, límite de intentos y sesiones
│  │  ├─ auth/pme-auth.ts     valida la sesión de PME reenviando su cookie a REPNODE_PME_USER_URL (caché 30 s)
│  │  ├─ http/security.ts     hook onRequest (Host, CSRF, sesión, autenticación) y onSend (CSP y encabezados)
│  │  ├─ http/cookies.ts      parseCookies, pickCookieHeader, serializeCookie
│  │  ├─ http/rate-limit.ts   límite de intentos fallidos por IP (conexión manual)
│  │  ├─ sessions/registry.ts sesiones de usuario: creación, vencimiento, desalojo, ownerKey
│  │  ├─ errors.ts            HttpError, describeSqlError (+ pruebas), isTransientSqlError
│  │  ├─ production.ts        parseProductionEnv(): conexión a PME de producción desde variables REPNODE_* (+ pruebas)
│  │  ├─ selection.ts         resolveMeters (directos + tags y nodos dinámicos) y resolveSelection
│  │  ├─ hierarchy.ts         hierarchyDTO(): jerarquías del perfil con medidores resueltos a IDs del catálogo
│  │  ├─ validate.ts          validación previa: classify() puro + validateSelection() SQL + caché
│  │  ├─ security/secrets.ts  clave maestra, HKDF, AES-256-GCM, profileIdFor (SHA-256)
│  │  ├─ store/sqlite.ts      migraciones (PRAGMA user_version) y repositorios
│  │  ├─ mssql/config.ts      buildMssqlConfig() (objeto plano, se pasa a los workers)
│  │  ├─ mssql/session.ts     conexión SQL de una sesión: pool, catálogo compartido, verificación de versión y objetos
│  │  ├─ mssql/catalog.ts     carga de Source/SourceType/Quantity/SourceQuantity
│  │  ├─ mssql/queries.ts     SQL de extracción (dataSql) y cobertura (coverageSql)
│  │  ├─ routes/connection.ts sesión, test, connect, disconnect, perfiles, conexión de producción
│  │  ├─ routes/catalog.ts    catálogo, tags, presets, settings
│  │  ├─ routes/hierarchy.ts  tableros, espacios, quitar de la jerarquía, posiciones del diagrama
│  │  ├─ routes/reports.ts    CRUD de reportes, validate, jobs (crear/SSE/cancelar/descargar), historial
│  │  └─ jobs/
│  │     ├─ job-manager.ts    cola FIFO (1 job a la vez), reparto en shards, workers, progreso, TTL
│  │     ├─ job-worker.ts     worker_thread: pool propio, p-limit, reintentos, cancelación
│  │     ├─ extract.ts        extractMeter(): 1 consulta en streaming por medidor → archivo parcial
│  │     ├─ formats.ts        WideSink (pivot en streaming), KeyedWideSink, LongSink, headerLine
│     ├─ timestamp-merge.ts  LineReader + mergeByTimestamp (k-way por timestamp) para el formato por estampa de tiempo
│  │     ├─ csv.ts            CsvFormatter (RFC 4180, decimal), BufferedWriter (contrapresión), BOM, EOL
│  │     ├─ assemble.ts       une parciales (ancho/largo), arma el ZIP o combina por timestamp
│  │     └─ protocol.ts       mensajes padre↔worker, MeterTask, partPath
│  ├─ .env.example            plantilla de .env.local para el despliegue (modo pme, cuenta de servicio, topes)
│  ├─ scripts/                (requieren .env.test.local)
│  │  ├─ check-vm.ts          verificación contra SQL real: catálogo, paridad, cobertura, extracción
│  │  ├─ bench.ts             benchmark enfoque anterior vs RepNode con combinaciones K×C
│  │  ├─ legacy.ts            réplica de las llamadas del software anterior (EXEC o cuerpo literal del SP)
│  │  └─ test-env.ts          lee TEST_SQL_* del entorno
│  └─ .env.test.example       plantilla; la copia real es .env.test.local (git-ignorada)
└─ apps/web/src/
   ├─ main.ts, App.vue, router.ts, style.css (Tailwind v4 + clases .btn/.input/.card/.chip…)
   ├─ lib/api.ts              fetch JSON, ApiError, onNotConnected
   ├─ lib/useValidation.ts    validación automática con debounce y AbortController
   ├─ lib/useMeterFilters.ts  filtros comunes de medidores (búsqueda, grupo, modelo, tag/"sin tags", con datos)
   ├─ lib/cross-tab-sync.ts   createCrossTabSync(canal): BroadcastChannel + recarga al recuperar el foco
   ├─ lib/tagSync.ts          aviso de cambios de tags entre pestañas (usa cross-tab-sync, canal 'repnode.tags')
   ├─ lib/hierarchy-editor.ts contexto provide/inject del editor (zonas para soltar, resaltado) y tamaños de las cajas
   ├─ lib/hierarchy-layout.ts layout por capas con elkjs en un worker (puertos de entrada con orden fijo)
   ├─ lib/use-meter-drag.ts   arrastrar y soltar medidores (HTML5, tipo application/x-repnode-meters)
   ├─ lib/panel-icons.ts      PanelIcon (shared) → componente de @tabler/icons-vue
   ├─ lib/useJobRunner.ts     crea job, sigue SSE, descarga automática, maneja 422
   ├─ lib/issues.ts           textos de problemas de validación
   ├─ lib/util.ts             búsqueda sin tildes, formatos, clone(), triggerDownload, downloadCsv, nextTagColor
   ├─ stores/                 session (perfiles en localStorage), catalog (+tags, presets), hierarchy, reports, toast
   ├─ views/                  ConnectView, ReportsView, ReportEditorView, TagsView, SettingsView, hierarchy-view
   └─ components/             MeterPicker, meter-tree, meter-picker-modal, MeasurementPicker, DateRangeEditor, OutputEditor,
                              ValidationStatus, ValidationErrorModal, JobProgressModal, RunReportModal, PasteListModal,
                              BaseModal, ToastHost, Icon, MeterLabel, MeterFilterBar, TagChip, TagChooser, ColorPalette,
                              FloatingMenu
      └─ hierarchy/           panel-node, source-node, space-node (cajas del diagrama), supply-edge (arista con carril),
                              panel-detail, space-detail, hierarchy-meter-list
```

---

## 4. Base de datos ION_Data (PME)

El esquema completo está en `database/ION_Data-creation-script.sql`. Está en **UTF-16 LE**: para buscar en él, leerlo con
`[System.IO.File]::ReadAllText(path, [Text.Encoding]::Unicode)` o con ripgrep, que detecta el BOM.

Objetos relevantes:

| Objeto | Uso en RepNode |
|---|---|
| `dbo.Source` (ID int, Name nvarchar(250), DisplayName único, SourceTypeID, NamespaceID, TimeZoneID) | Catálogo de medidores. `Name` tiene forma `GRUPO.MEDIDOR` (p. ej. `OFFLINE.MAIN`). Grupo automático = prefijo antes del primer `.` |
| `dbo.SourceType` | Tipo de fuente (se muestra en la GUI y entra en la búsqueda) |
| `dbo.Quantity` (ID smallint, Name único, Unit…) | Catálogo de mediciones. Hay miles (unas 6.000 en la VM de prueba); la GUI muestra solo las que tienen datos |
| `dbo.SourceQuantity` (SourceID, QuantityID, MinTimestampUtc, MaxTimestampUtc) | Qué mediciones tiene cada medidor y su rango. Se usa para la cobertura en la GUI, el motivo de la validación y el rango sugerido |
| `dbo.DataLog2` (ID, Value float, SourceID, QuantityID, TimestampUTC datetime2(7)) | Datos históricos. **Índice clustered único `(SourceID, QuantityID, TimestampUTC)`**: es la base de la optimización |
| `dbo.Burst` + `dbo.BurstDataLog` | Datos RMS de ráfaga (normalmente vacíos) |
| `dbo.vwDataLog2` | `DataLog2 UNION ALL (Burst JOIN BurstDataLog)`. **Siempre se consulta esta vista** para tener paridad con el SP |
| `dbo.spDAL_GetLoggedData_SMP_TV(@SourceID, @MeasurementID, @StartDateUtc DATETIME, @EndDateUtc DATETIME)` | El SP del software anterior. Es solo `SELECT TimestampUTC, Value FROM vwDataLog2 WHERE SourceID=… AND QuantityID=… AND TimestampUTC > @Start AND TimestampUTC <= @End ORDER BY TimestampUTC` |
| `dbo.IntegerIdList` (TVP) | Existe, pero no se usa |

Restricciones:

- La BD está en **`COMPATIBILITY_LEVEL 110`**, así que **no hay `OPENJSON` ni `STRING_SPLIT`**. Las listas viajan como
  parámetros individuales `@q0..@qN` (máximo 2100 parámetros por consulta; RepNode limita a 1000 mediciones por reporte).
  `DATEDIFF_BIG` sí funciona, pero no conviene: se probó y es más lento.
- **Semántica del rango**: `TimestampUTC > inicio AND TimestampUTC <= fin` (inicio excluido, fin incluido), igual que el SP.
- Software anterior, por medidor con 4 mediciones: `spDAL_GetIDForSource` + 4× `spDAL_GetNameForMeasurement` +
  `spDAL_GetSourceInfo` + 4× `spDAL_GetMeasurements` + 4× `spDAL_GetLoggedData_SMP_TV`, unas 14 llamadas en serie.

Permisos mínimos del login de SQL: `db_datareader` sobre ION_Data. Solo los scripts de paridad y benchmark intentan
hacer `EXEC` de los SP; si reciben el error 229 (sin permiso), ejecutan el cuerpo literal del SP (`scripts/legacy.ts`).

---

## 5. Backend

### 5.1 Arranque y seguridad del servidor (`index.ts`)

- Escucha en **`127.0.0.1:3210`** por defecto (`REPNODE_HOST`, `REPNODE_PORT`). **Todo vive bajo `BASE_PATH` =
  `/repnode`** (shared), también en desarrollo: las rutas de `routes/*` se registran con `prefix` y la GUI compilada se
  sirve en `/repnode/` (`/` y `/repnode` redirigen a `/repnode/`). Así es igual detrás del proxy de IIS de PME.
- `trustProxy` solo para 127.0.0.1/::1 (el IIS del mismo equipo): `req.protocol`/`req.ip` salen de `X-Forwarded-*`.
- Hooks de `http/security.ts`:
  - `onRequest`: 403 si el `Host` no es localhost/127.0.0.1/[::1] ni está en `REPNODE_ALLOWED_HOSTS` (DNS rebinding;
    el proxy de Vite conserva el Host, `changeOrigin: false`). En `/repnode/api/*`: **CSRF** (`isCrossSiteRequest`:
    se rechaza un método no seguro con `Sec-Fetch-Site` cross-site/same-site o con un `Origin` que no es el Host ni un
    host permitido; sin esos encabezados no es un navegador y se acepta), luego la sesión (5.2) y, en modo pme, la
    autenticación (5.12).
  - `onSend`: CSP (`frame-ancestors 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'` por Vue Flow,
    `worker-src 'self' blob:` por elkjs), `nosniff`, `Referrer-Policy`, HSTS si es https y `no-store` en la API.
- Un archivo que no existe bajo `/repnode/` (p. ej. un asset) responde 404; el resto de rutas de la SPA, `index.html`.
  `@fastify/static` va con `wildcard: false`: los archivos de `dist` se registran al arrancar, así que **tras
  `pnpm build` hay que reiniciar el servidor**.
- Manejador de errores: `HttpError` → `{ error, message, details }` con su status; `ZodError` → 400 con mensajes por campo.
- En producción (`--prod` o `NODE_ENV=production`) sirve `apps/web/dist` con fallback SPA a `index.html`.
- `disableRequestLogging: true`, para que los logs no se llenen con cada petición.
- `initJobs()` marca como interrumpidos los jobs del historial que quedaron a medias y borra `data/jobs/*`.

### 5.2 Sesión SQL (`mssql/session.ts`)

- **Una sesión por navegador** (`sessions/registry.ts`): cookie `repnode.sid` (32 bytes aleatorios, `HttpOnly`,
  `SameSite=Strict`, `Path=/repnode`, `Secure` si llega por https), creada en la primera petición a la API. Cada sesión
  tiene **su propio pool de SQL** (`UserSession.sql`, `null` hasta conectarse). Las rutas obtienen la conexión con
  `requireSession(req)` (`req.userSession`); 409 `not_connected` si no hay.
  - Vence tras `REPNODE_SESSION_IDLE_MINUTES` (15) sin peticiones, salvo que su dueño tenga jobs en cola o en curso,
    y siempre a las `REPNODE_SESSION_MAX_HOURS` (12). Se comprueba al leerla y cada minuto; al vencer se cierra su pool.
  - Tope `REPNODE_MAX_SESSIONS` (100): se desaloja la más inactiva sin conexión ni jobs; si no hay, 503 `too_many_sessions`.
  - Pool de cada sesión: `REPNODE_SESSION_POOL_MAX` o, si no está, `max(8, concurrency × 2)`. Con `min: 0` e
    `idleTimeoutMillis: 30 s`, una sesión inactiva no retiene conexiones físicas.
  - El **catálogo se comparte** entre sesiones de la misma base y login (`catalogKey`, con conteo de referencias);
    `refreshCatalog(s)` lo recarga para todas.
  - Si el backend se reinicia, las sesiones se pierden; la GUI se reconecta sola (ver 6, reconexión transparente).
- `openPool()` verifica tres cosas: versión ≥ 13 (SQL 2016), que existan `Source`, `Quantity`, `SourceQuantity`,
  `DataLog2` y `vwDataLog2` en `dbo`, y luego carga el catálogo.
- `buildMssqlConfig()`: `useUTC: true`, `packetSize: 32768`, `appName: 'RepNode'`.
  - **Si hay puerto, se usa el puerto y se ignora la instancia** (no depende de SQL Server Browser, UDP 1434). Si solo hay
    instancia, se usa `instanceName`.
  - Autenticación NTLM: se activa al pasar `domain`.
- `describeSqlError()` (`errors.ts`): en errores `ESOCKET`/`ECONNCLOSED` busca el error de red que tedious esconde en
  `originalError.cause` (un `AggregateError` con un error por dirección probada; su mensaje solo dice "Could not connect
  (sequence)") y agrega el código con una explicación: `ECONNREFUSED` (nada escucha en el puerto: instancia con otro
  puerto o TCP/IP deshabilitado), `EHOSTUNREACH`/`ENETUNREACH`, `ENOTFOUND`/`EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`.
- **Conexión de producción** (`production.ts`, rutas en `routes/connection.ts`): variables de entorno del servidor
  `REPNODE_SERVER`, `REPNODE_AUTH_USER`, `REPNODE_AUTH_PASS` (obligatorias), `REPNODE_INSTANCE`, `REPNODE_DB_PORT`
  (1433 si no hay puerto ni instancia; un puerto explícito gana sobre la instancia) y `REPNODE_DB_NAME` (`ION_Data`).
  Siempre usuario SQL, `trustServerCertificate: true` y `encrypt: false` (como el formulario por defecto). Se leen de
  `process.env` en cada petición (el `dev`/`start` carga `apps/server/.env.local`). La contraseña nunca sale del servidor.
  - `GET /api/connection/production` hace `testConnection` y reutiliza el resultado 60 s (y la promesa en curso);
    `?refresh=1` fuerza otra prueba.
  - Al conectar, el `profileId` es el de una conexión recordada con los mismos parámetros o, si no hay, su hash
    (`profileIdFor`). No se guarda en `connection_profiles` (no hay contraseña que cifrar), pero sus reportes, tags y
    jerarquías persisten por ese id.

### 5.3 Catálogo (`mssql/catalog.ts`)

Tres `SELECT ... WITH (NOLOCK)` en paralelo: Source+SourceType, Quantity y SourceQuantity. Se guardan en memoria con
mapas por ID y por nombre y una cobertura `Map<sourceId, Map<quantityId, {min,max}>>` en ms UTC.
`GET /api/catalog` devuelve medidores, **solo las mediciones presentes en SourceQuantity** y `sourceQuantities`
(sourceId → quantityIds). Se refresca con `POST /api/catalog/refresh`.

### 5.4 Persistencia local (`store/sqlite.ts`, `data/app.db`)

Migraciones versionadas con `PRAGMA user_version`; para cambiar el esquema, **agregar un string nuevo al arreglo
`migrations`**, nunca editar uno ya publicado. Tablas:

- `connection_profiles`: incluye `pwd_cipher`, `pwd_iv`, `pwd_tag`. El id nace como SHA-256 de
  server|port|instance|database|domain|username, pero **no cambia al editar el perfil** (p. ej. cambió la IP): todo lo
  del perfil (reportes, tags, jerarquías, historial) cuelga de ese id. Por eso una conexión nueva usa `idForNewProfile`
  (`security/secrets.ts`): reutiliza el id del perfil que hoy tiene esos parámetros, o genera uno aleatorio si el hash lo
  ocupa un perfil editado con otros parámetros.
- `tags` y `tag_members`: los miembros se guardan por **`Source.Name`** (estable), no por ID. Todo va por perfil.
  El nombre admite espacios (los repetidos se reducen a uno) y es único por perfil.
- `tag_colors` (migración v2): paleta personalizada de colores por perfil (máx. 24, los más recientes primero). Un tag
  creado o editado con un color fuera de `TAG_PALETTE` (shared, 8 colores base) agrega ese color automáticamente.
- `measurement_presets`: guarda **nombres** de Quantity en JSON y los resuelve a IDs con el catálogo.
- `reports`: `definition_json` validado con `reportDefinitionSchema`. Todo va por perfil. Al leerlo se vuelve a pasar por
  el esquema (`parseDefinition`) para completar campos nuevos con su valor por defecto (p. ej. `panelIds`, `spaceIds`).
- Jerarquías (migraciones v4 y v5), miembros por **`Source.Name`** como los tags y **un lugar por medidor y por
  jerarquía**. En Suministro un medidor es: una **salida** de un tablero, el medidor de una **entrada externa** de un
  tablero, o su **totalizador**. La entrada de Y que viene de X **referencia una salida de X** (el medidor está
  físicamente en X): quitar o desconectar la entrada nunca saca el medidor de X. Una salida puede alimentar entradas
  de **varios tableros** (derivación, N destinos): `SupplyPlace.feeds` es una lista (`FeedRef[]`).
  - `panels` (nombre único por perfil, `mode` = `sum`|`ats`, `description`, `x`/`y` del diagrama; null = layout
    automático; v5: `totalizer_name` = totalizador interno; v6: `color` (#rrggbb o null) e `icon` (`PANEL_ICONS`:
    other, hvac, plug, lighting, store, elevator, motor; por defecto `other`; un valor desconocido se lee como `other`)).
  - `panel_inputs`: entradas ordenadas (`position`); `from_panel_id` (ON DELETE SET NULL) u `origin` (fuente externa),
    `label` y `source_name` (medidor asociado). La primera entrada que viene de un tablero es la **primaria**.
  - `panel_loads` (salidas) con `UNIQUE(profile_id, source_name)`. La v5 convirtió los medidores de entradas desde otro
    tablero en salidas de ese tablero.
  - Reglas (`supplySaveConflicts`/`planSupply` en shared, aplicadas en las rutas y en la GUI): al guardar entradas y
    totalizador (`setInputs`), el medidor de una entrada desde X pasa a ser salida de X; el de una entrada externa y el
    totalizador dejan de ser salidas. No se puede usar lo que es entrada externa o totalizador de otro tablero. Una
    salida que ya alimenta a otros tableros **se comparte** en una entrada que venga de su mismo tablero (derivación),
    pero no en una entrada desde otro origen, una entrada externa, un totalizador, una salida de otro tablero ni en dos
    entradas del mismo tablero (409 `meter_in_use`). `addLoads` mueve el medidor desde otro tablero, entrada externa o
    totalizador; `removeLoads` deja sin medidor todas las entradas que esa salida alimentaba. Sin cambio de esquema:
    `panel_inputs.source_name` no es único.
  - `spaces` (`parent_id`, `type` libre con sugerencias `SPACE_TYPES`, `x`/`y`) y `space_members` con
    `UNIQUE(profile_id, source_name)`. Nombre único entre hermanos (se valida en la ruta).
  - Eliminar un tablero convierte las entradas que venían de él en fuentes externas con su nombre. Eliminar un espacio
    sube sus subespacios y medidores al padre (sin padre, los medidores quedan sin ubicar).
- `job_history`: estado, filas, bytes, resumen de validación y error. Migración v3: `forced` (generado pese a errores de
  validación) y `off_grid_rows` (filas extra fuera de la grilla). v7: `user_name` (usuario de PME que lo generó).
- `settings`: clave/valor JSON. Valores por defecto: `workers = min(2, núcleos-1)`, `concurrency = 4`,
  `readUncommitted = true`, `downloadTtlMinutes = 60`, `requestTimeoutSeconds = 1800`.

`node:sqlite` no acepta booleanos: convertir a 0/1.

### 5.5 Credenciales (`security/secrets.ts`)

Una contraseña que se debe reutilizar para conectar **no se puede hashear**, así que se cifra:

- `data/master.key`: 32 bytes aleatorios generados en el primer arranque (base64).
- El navegador genera un `clientSecret` aleatorio (32 bytes, base64) y lo guarda en `localStorage` (`repnode.profiles`).
- Clave = `HKDF-SHA256(masterKey, salt=clientSecret, info='repnode/pwd/v1/' + profileId)`. La contraseña se cifra con
  **AES-256-GCM** con `profileId` como AAD.
- Ninguno de los dos almacenes por sí solo permite descifrar. El navegador **nunca** guarda la contraseña.
- Si el secreto es incorrecto o se borró `localStorage`, la respuesta es 401 `decrypt_failed` y la GUI pide la contraseña de nuevo.

### 5.6 Selección efectiva (`selection.ts`)

Medidores efectivos = `sourceIds` directos ∪ miembros actuales de los `tagIds` (**tags dinámicos**, resueltos al
ejecutar) ∪ medidores actuales de los **nodos dinámicos**: `panelIds` (entradas y cargas del tablero y de todo su
aguas abajo, `panelSourceIds`) y `spaceIds` (el espacio y sus subespacios, `spaceSourceIds`). Se ordenan como el
catálogo (alfabético por DisplayName). La GUI usa las mismas funciones de shared en `catalog.effectiveSourceIds()`. El rango se resuelve con `resolveRange()` en la
zona horaria del reporte. Un `rangeOverride` reemplaza el rango solo para esa ejecución.

### 5.7 Validación previa (`validate.ts`)

- `coverageSql`: para cada medidor, con todas sus mediciones, hace 2 seeks por par (`TOP 1 ASC` y `TOP 1 DESC`) sobre
  `vwDataLog2` usando `FROM (VALUES (@q0),(@q1)…)`. **No usar `MIN/MAX` con `GROUP BY`**: recorrería todo el rango.
- Se consulta **cada par**, aunque SourceQuantity no tenga la fila, por si esa tabla está desactualizada.
- `classify()` es pura y tiene pruebas. Estados por par:
  - `ok`.
  - `partial`: el primer dato es más de 1 día posterior al inicio, o el último es más de 1 día anterior a `min(fin, ahora)`.
    Es advertencia y no bloquea.
  - `missing_quantity`: no hay datos y SourceQuantity no tiene la fila. Bloquea.
  - `no_data_in_range`: no hay datos, pero SourceQuantity sí tiene la fila. Bloquea.
- `suggestedRange`: solo si no hay `missing_quantity`. Es la intersección del rango pedido con `[max(min), min(max)]` de
  SourceQuantity, redondeada a días locales completos.
- Caché de 10 min por selección (perfil, rango UTC, mediciones, medidores): el endpoint de validación consulta siempre
  (`fresh = true`) y el job reutiliza un resultado reciente si no tenía errores.
- La concurrencia de la validación es `min(workers × concurrency, 16)` sobre el pool de la sesión. Se cancela si el
  navegador cierra la petición.

### 5.8 Motor de extracción (`jobs/*`)

```
POST /api/jobs → resolveSelection → tope de grilla (400) → validateCached (422 si hay errores y no hay force) → createJob
  job-manager: cola FIFO, hasta REPNODE_MAX_CONCURRENT_JOBS (1) a la vez → reparte medidores round-robin en K shards
    └─ K worker_threads (job-worker.ts), cada uno con su ConnectionPool (max = C) y p-limit(C)
         └─ extractMeter(): UNA consulta en streaming por medidor (todas sus mediciones)
              → RowSink (WideSink / LongSink) → BufferedWriter → data/jobs/<id>/<index>.part
  → assemble(): BOM + encabezado + parciales en orden → output.csv   |   ZipArchive → output.zip
  → SSE de progreso → GET /download → los archivos se borran tras downloadTtlMinutes
```

Detalles clave:

- **Dueño**: cada job guarda `owner` = `ownerKey(sesión)` (`pme:<usuario>` en modo pme, `local` en modo local).
  `getJob`/`cancelJob`/`subscribe` exigen ese dueño: para otro usuario el job no existe (404). Un usuario puede tener
  hasta `REPNODE_MAX_JOBS_PER_USER` (2) en cola o en curso (429 `too_many_jobs`). `JobState.queuePosition` dice
  cuántos hay antes; `hasActiveJobs(owner)` evita que su sesión venza por inactividad.
- `dataSql`: `ORDER BY TimestampUTC, QuantityID` para ancho y ZIP (pivot en streaming) o `QuantityID, TimestampUTC`
  para largo (orden del índice). Lleva **`OPTION (OPTIMIZE FOR UNKNOWN)`**. **No usar `OPTION (RECOMPILE)`**: duplicaba
  el costo de cada consulta chica (medido: 15,7 vs 7,2 ms).
- Prefijo `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;` si `readUncommitted` está activo (por defecto), para no
  bloquear la ingesta de PME.
- **Contrapresión**: `BufferedWriter` agrupa en bloques de 64 KB; si `ws.write()` devuelve false, se pausa el request
  de mssql y se reanuda con `drain`.
- **Reintentos**: hasta 3 intentos con backoff de 1 s, 3 s y 9 s ante errores transitorios (ETIMEOUT, ESOCKET,
  ECONNRESET, deadlock 1205…). Otros errores abortan el job (mensaje `fatal`).
- **Cancelación**: `{type:'cancel'}` → `request.cancel()` en los requests activos; `worker.terminate()` a los 3 s si no responde.
- **Memoria**: workers con `resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 }`. Sin tope,
  V8 dejaba crecer cada worker a ~250 MB de basura; con tope, el RSS total baja de ~1 GB a ~350 MB sin perder velocidad.
- **Ensamblado**: copia manual con `for await` + `once(out,'drain')`. **No usar `pipeline(..., {end:false})` en un bucle
  sobre el mismo destino**: acumula listeners (MaxListenersExceededWarning) con muchos medidores.
- Al terminar, el worker hace `parentPort.unref()` para que el listener de mensajes no mantenga vivo el hilo.
- Los workers se crean con `new Worker(new URL('./job-worker.ts', import.meta.url))`; funciona porque Node 24 ejecuta TS nativo.
- Progreso: `publish()` con throttle de 200 ms; ETA = (tiempo transcurrido / medidores listos) × medidores restantes.

### 5.9 Formato CSV

- **UTF-8 con BOM** (`﻿`), saltos **CRLF** y comillas RFC 4180 (cuando el campo contiene el separador, comillas,
  saltos de línea o espacios al borde).
- Separador `;` `,` o tabulación; decimal `,` o `.`. La combinación `,` + `,` está prohibida por el esquema. Por defecto:
  `;` y `,`, para Excel en español.
- `decimals: null` deja la precisión completa (`String(v)`); un número N usa `toFixed(N)`. Los valores nulos o no
  finitos quedan como celda vacía.
- Fecha `yyyy-MM-dd HH:mm:ss` en la zona del reporte; `includeUtc` agrega la columna `FechaHoraUTC`.
- Formatos:
  - `wide`: `Medidor;FechaHora;[FechaHoraUTC;]<Medición [unidad]>…`, una fila por medidor y timestamp.
  - `long`: `Medidor;Medicion;Unidad;FechaHora;[FechaHoraUTC;]Valor`.
  - `zip`: un CSV ancho por medidor, sin columna Medidor, llamado `<label saneado>.csv`; los duplicados llevan ` (n)`.
  - `timestamp` (**por estampa de tiempo**): `FechaHora;[FechaHoraUTC;]<GRUPO.MEDIDOR.Medición [unidad]>…`, una fila por
    timestamp con todos los medidores. Siempre usa `Source.Name` (ignora `meterLabel`) y ordena los medidores por nombre.
    - `columnsByQuantity` (casilla): `false` = por medidor (M1.q1, M1.q2, M2.q1…); `true` = por medición (M1.q1, M2.q1…).
    - Extracción igual que el ancho, pero el parcial lleva el timestamp en ms (`KeyedWideSink`: `ts;v1;…`). Al
      ensamblar, `mergeByTimestamp` combina los parciales con un montículo mínimo y una lectura con buffer propio;
      con más de 256 parciales combina en dos niveles (grupos de 256 → parciales intermedios) para no abrir cientos de
      archivos. Un medidor sin ese timestamp deja sus celdas vacías. El ensamblado corre en el hilo principal.
    - Columnas por archivo: máximo `MAX_FILE_COLUMNS` = 16.000 (Excel admite 16.384). Si se supera, `splitColumns`
      reparte en varios CSV (sin partir un medidor o una medición si cabe entero) dentro de un ZIP:
      `<nombre> (parte k de K).csv`. La GUI lo avisa en el paso 4 y la extensión de descarga pasa a `.zip`.
    - `JobState.rows` toma las filas combinadas (no la suma de los parciales). Con "Completar filas", todos los
      medidores comparten la misma grilla, así que hay una fila por casillero.
- **Completar filas** (`output.fillGaps` + `output.intervalMinutes` ∈ `GRID_INTERVALS` = 1, 5, 10, 15, 30, 60; por defecto
  apagado y 15 min): los sinks reciben un `TimeGrid` y escriben una fila por casillero sin datos, con el valor en blanco.
  - Casilleros = `inicio + k·intervalo` dentro de `(inicio, fin]` (misma semántica del rango): un día a 15 min da
    96 filas, de 00:15 a 00:00 del día siguiente.
  - Ancho y ZIP: filas en blanco antes, entre y después de los datos; un medidor sin datos recibe la grilla completa.
  - Largo: cada medición recibe su grilla completa, también las que no tienen datos, en orden de QuantityID (el de la
    consulta).
  - Un timestamp con datos que no cae en la grilla **se conserva como fila extra** (no se mueve ni se descarta) y se
    cuenta en `offGrid` → `JobState.offGridRows` → aviso en JobProgressModal e historial.
  - Tope: `MAX_GRID_ROWS` = 50 M filas estimadas (medidores × casilleros × mediciones si es largo; solo casilleros en
    el formato por estampa de tiempo); por encima, 400
    `grid_too_large`. La GUI muestra la estimación en el paso 4.
- Nombre de archivo: plantilla con `{reporte}` `{desde}` `{hasta}` `{generado}` (formato `YYYYMMDD` o `YYYYMMDD-HHmm`),
  saneada para Windows. La descarga usa `Content-Disposition` con `filename` ASCII más `filename*=UTF-8''…`.

### 5.10 Zonas horarias (`shared/time.ts`, `shared/range.ts`)

- Solo `Intl`, sin librerías. `tzOffsetMs()` usa `formatToParts`; `localToUtcMs()` hace dos pasadas para manejar
  transiciones de horario de verano.
- `LocalTimeFormatter` cachea el offset por **bloques de 15 minutos** (cubre zonas con medias horas, como Lord Howe).
- Relativos: `today`, `yesterday`, `lastNDays`, `currentWeek`/`previousWeek` (semana desde el lunes),
  `currentMonth`/`previousMonth`, `currentYear`/`previousYear`. Son días completos `[00:00, 00:00)` en hora local.
- La GUI ingresa fechas locales `YYYY-MM-DDTHH:mm` y la consulta usa UTC. Ejemplo: 2025-01-01 00:00 en America/Lima
  equivale a 05:00 UTC, igual que en el software original.

### 5.11 API REST

Todas las rutas van bajo `/repnode` (p. ej. `GET /repnode/api/session`); la tabla las muestra sin el prefijo.

| Método y ruta | Descripción |
|---|---|
| `GET /api/session` | Estado de la conexión, `mode` (`none`/`pme`), `user` (de PME) e `idleMinutes` |
| `POST /api/connection/test` | Prueba de conexión, con `{params,password}` o `{profileId,clientSecret}`; al editar, `{params,password:'',profileId,clientSecret}` usa la contraseña guardada |
| `POST /api/connection/connect` | Conexión nueva (`params`, `password`, `remember`, `clientSecret`), edición de un perfil (lo mismo + `profileId`: conserva el id, siempre se guarda; `password` vacía = la guardada) o con perfil (`profileId`, `clientSecret`) |
| `GET /api/connection/production` | `ProductionStatusDTO`: si está configurada (`missing` = variables que faltan) y si se pudo conectar (`available`, `error`); `?refresh=1` vuelve a probar |
| `POST /api/connection/production/connect` | Conecta con las variables de entorno; 400 `production_not_configured` si faltan |
| `POST /api/connection/disconnect` | Cierra el pool |
| `GET /api/profiles` · `DELETE /api/profiles/:id` | Perfiles guardados en el servidor. En modo pme, `test`, `connect` y los perfiles responden 403 `manual_connection_disabled`; `test`/`connect` admiten 10 fallos por IP cada 5 min (429 `too_many_attempts`) |
| `GET /api/catalog` · `POST /api/catalog/refresh` | Catálogo |
| `GET/POST /api/tags`, `PUT/DELETE /api/tags/:id`, `POST /api/tags/:id/members` | Tags (`{sourceIds, action:'add'|'remove'}`); `POST` acepta `sourceIds` iniciales; cada operación devuelve la lista completa |
| `GET/POST /api/tag-colors`, `DELETE /api/tag-colors/:hex` | Paleta personalizada (`{color:'#rrggbb'}`; en el DELETE, el hex va sin `#`); devuelven la lista |
| `GET/POST /api/presets`, `DELETE /api/presets/:id` | Presets de mediciones (POST hace upsert por nombre) |
| `GET /api/hierarchy` | `{panels, spaces}` con medidores resueltos a IDs (`missing`/`missingMeter` = guardados que ya no existen). Todas las rutas de jerarquías devuelven este objeto completo |
| `POST /api/panels`, `PUT/DELETE /api/panels/:id` | Tablero (`name`, `mode`, `description`, `inputs[]` = reemplazo completo, `totalizerSourceId`, `color`, `icon`). `POST` acepta `sourceIds` (salidas iniciales) y `x`/`y`. 400 `cycle`, 409 `duplicate`, 409 `meter_in_use` |
| `POST /api/panels/:id/loads` | Salidas `{sourceIds, action:'add'|'remove'}`; agregar mueve desde otro lugar libre; quitar deja sin medidor las entradas que alimentaba. Entrada externa/totalizador de otro tablero o salida que alimenta a otro → 409 `meter_in_use` |
| `POST /api/spaces`, `PUT/DELETE /api/spaces/:id`, `POST /api/spaces/:id/members` | Espacios (`name`, `type`, `parentId`); `POST` acepta `sourceIds`, `x`, `y`. 400 `cycle`, 409 `duplicate` (entre hermanos) |
| `POST /api/hierarchy/unassign` | `{kind, sourceIds}`: saca medidores de una jerarquía (en Suministro, una entrada queda sin medidor) |
| `PUT /api/hierarchy/layout` | `{kind, positions:[{id,x,y}], reset?}`: posiciones de las cajas del diagrama |
| `GET/PUT /api/settings` | Rendimiento y TTL |
| `GET/POST /api/reports`, `GET/PUT/DELETE /api/reports/:id` | Reportes |
| `POST /api/reports/validate` | `{selection, rangeOverride?}` o `{reportId, rangeOverride?}` → `ValidationResult` |
| `POST /api/jobs` | `{reportId, rangeOverride?, force?}` o `{definition, rangeOverride?, force?}`. Sin `force`, responde 422 `validation_failed` con `details` = `ValidationResult` si hay errores; 400 `grid_too_large` si la grilla supera el tope |
| `GET /api/jobs/:id` · `GET /api/jobs/:id/events` (SSE) · `POST /api/jobs/:id/cancel` · `GET /api/jobs/:id/download` | Ciclo de vida del job |
| `GET /api/history` | Últimas 50 ejecuciones del perfil |

Códigos de error frecuentes: `not_connected` (409), `not_authenticated` (401, modo pme; `details.loginUrl`),
`pme_unavailable` (503), `too_many_sessions` (503), `too_many_jobs` (429), `too_many_attempts` (429),
`manual_connection_disabled` (403), `forbidden` / `forbidden_origin` (403), `connect_failed`, `invalid_database`, `unsupported_version`,
`decrypt_failed` (401), `profile_not_found`, `production_not_configured` (400), `validation_failed` (422), `grid_too_large` (400), `invalid_input` (400), `not_found`,
`cycle` (400), `meter_in_use` (409), `duplicate` (409).

### 5.12 Multiusuario embebido en PME (`REPNODE_AUTH_MODE=pme`)

Despliegue: RepNode en el servidor de PME escuchando en 127.0.0.1:3210; el IIS de PME (URL Rewrite + ARR, regla en
`deploy/iis/web.config.example`) publica `https://<servidor>/repnode/` → `http://127.0.0.1:3210/repnode/`, con
`X-Forwarded-Proto: https`, Host conservado, búfer de respuesta 0 (SSE) y sin compresión dinámica en `/repnode`.
Mismo origen que PME: no hay cookies de terceros, `SameSite=Strict` funciona dentro del iframe y el `localStorage` no
queda aislado. La regla `^repnode(/.*)?$` no captura `/repnode-auth`. Hallazgos del servidor de PME (13.2, IIS 10): Forms Authentication de ASP.NET con la cookie
`.APPLICATIONFRAMEWORK` (`Path=/`, HttpOnly, Secure) y `machineKey` compartido por sus aplicaciones; el iframe de PME
(`webHostAppFrame`) no tiene `sandbox`; la CSP de PME tiene `frame-src *`.

- **Autenticación** (`auth/pme-auth.ts`): RepNode no descifra la cookie de PME (no usa el `machineKey`). La reenvía
  (solo las cookies de `REPNODE_PME_COOKIES`; la de RepNode nunca sale) a `REPNODE_PME_USER_URL`, un endpoint de PME
  que exige sesión y devuelve el usuario en JSON (`REPNODE_PME_USER_FIELD` = ruta con puntos). 2xx con usuario → válida;
  3xx/401/403 o sin usuario (p. ej. HTML del login) → 401 `not_authenticated`; otro error → 503 `pme_unavailable`, pero
  una sesión ya validada con las mismas cookies sigue sirviendo. Resultados en caché 30 s por hash de cookie.
  TLS: `REPNODE_PME_CA_FILE` o `REPNODE_PME_TLS_INSECURE=1` (solo si la URL es de este equipo).
  - La sesión guarda el hash de las cookies de PME y se reconfirma cada `REPNODE_PME_RECHECK_SECONDS` (120). Si cambia
    el usuario de PME en ese navegador, se cierra la sesión anterior y se crea otra. Sin cookie de PME → 401.
  - **PME no expone un JSON con el usuario actual** (se buscó en el Network del navegador). Por eso el endpoint por
    defecto es `http://127.0.0.1/repnode-auth/whoami.ashx` (campo `user`): una aplicación IIS propia (.NET 4.8, pool
    `RepNodeAuth`) con `<forms name=".APPLICATIONFRAMEWORK" protection="All">` que hereda el `machineKey` del
    `web.config` raíz del sitio (no se copian claves). **El `machineKey` de PME es `AutoGenerate`** (claves generadas
    por Windows por identidad del pool; los pools de PME corren como NetworkService y por eso comparten la cookie): el
    pool de `/repnode-auth` debe tener **la misma identidad que el de `/Web`**. Con ApplicationPoolIdentity la cookie
    no se descifraba (401); con NetworkService, verificado en SRVSLVPMEAPP (PME 13.2): `decrypt ok`, ticket versión 2,
    `AutoGenerate` sin `IsolateApps`. (`pme.compatibilityMode` sale como Framework20SP1 porque se lee del archivo, no
    del valor efectivo en ejecución; no impide descifrar). El instalador copia la identidad del pool de `/Web` (o usa ese pool si no se puede replicar)
    y avisa si hay `IsolateApps`. `whoami.ashx?diag=1` (solo local) informa si llegó la cookie, el resultado de
    `FormsAuthentication.Decrypt`, la identidad del pool y la configuración de `machineKey`/forms de ambos lados. Responde
    `{"user":"..."}`, 401 sin sesión y 403 a peticiones que no son de este equipo (`Request.IsLocal`); no renueva la
    cookie (`slidingExpiration="false"`). Va por http en loopback, así no hay problema con el certificado autofirmado.
  - El usuario es el **IdentityId de PME**, p. ej. `internal:database:<GUID>:supervisor` (tipo de cuenta, GUID,
    nombre). Se guarda y compara completo (`UserSession.user`, `ownerKey`, `job_history.user_name`); la GUI y el
    historial muestran `pmeDisplayName()` (último tramo, "supervisor"). `SystemDataService/Security/ValidateCredentials`
    devuelve el mismo `IdentityId`, pero es la respuesta del inicio de sesión (POST con credenciales): no se usa.
    Limitación: valida el ticket de Forms (vigente hasta su vencimiento); un cierre de sesión en PME borra la cookie
    del navegador y RepNode deja de recibirla.
- **SQL**: todos usan la cuenta de servicio (`REPNODE_SERVER`… de `production.ts`), cada sesión con su pool. La GUI se
  conecta sola. Sin esas variables o con `REPNODE_PME_USER_URL` inválida, el servidor no arranca.
- Tags, jerarquías y reportes se comparten (todos usan el mismo `profile_id` de la conexión de producción). Roles
  (quién edita) quedan para la fase 2.

---

## 6. Frontend

- Ruta base `/repnode/`: Vite `base` (de `BASE_PATH`), `createWebHistory(import.meta.env.BASE_URL)` y `apiUrl()` en
  `lib/api.ts`, que antepone la base a `/api/...` (también para `EventSource` y descargas). Las imágenes de `public/`
  se referencian con `import.meta.env.BASE_URL` (Vue no reescribe `src="/..."`).
- Rutas: `/connect` (pública), `/reports`, `/reports/new`, `/reports/:id/edit`, `/tags`, `/hierarchy` (`meta.wide`: el
  `<main>` usa todo el ancho), `/settings`. El guard redirige a `/connect` si no hay sesión; en modo pme antes intenta
  `session.autoConnect()` (conexión del servidor).
- **Reconexión transparente** (`setReconnectHandler` en `main.ts` → `session.reconnect()`): ante un 409
  `not_connected`, `api()` reconecta una vez (modo pme: conexión del servidor; local: lo último que usó la pestaña,
  `sessionStorage` `repnode.lastConnection`, perfil recordado o producción) y repite la petición, así no se pierde lo
  que se estaba editando. Si no puede, `onNotConnected` vuelve a `/connect`. Un 401 `not_authenticated` muestra el
  aviso "Sesión de PME terminada" (App.vue), que lleva la ventana principal al login de PME con `ReturnUrl`.
- **Orden y etiqueta de medidores en la GUI**: el store ordena por `Source.Name` (`GRUPO.MEDIDOR`, orden natural) y
  `MeterLabel` muestra el nombre con el **modelo** (`SourceType.Name`) al lado en gris claro; el DisplayName solo si
  difiere. El servidor sigue ordenando por DisplayName (orden de filas en el CSV).
- **ConnectView**: en modo pme solo muestra la conexión del servidor y su error (sin formulario ni perfiles), y el
  encabezado muestra el usuario de PME sin botón Desconectar. En modo local: botón verde **Conectar con PME de producción** arriba de "Conexiones recordadas": se consulta su estado
  al abrir la vista (spinner "Comprobando…"); solo se habilita si `available`. Si no, muestra el motivo (variables que
  faltan o error de conexión) y "Reintentar" (`refresh`). Perfiles recordados (de `localStorage`, con conexión en un clic); perfiles del servidor sin secreto en
  este navegador ("ingresa la contraseña de nuevo"); formulario (instancia y puerto se excluyen entre sí en la GUI,
  SQL o NTLM, TLS, confiar en el certificado, Recordar); "Probar conexión".
  - **Editar** una conexión recordada (o "Usar" una sin llave, o un fallo al conectar con un perfil) pone el formulario
    en modo edición (`ProfileEdit` del store `session`): aviso "Editando «nombre»", "Guardar y conectar" y botón
    "Nueva conexión" para salir. Al conectar se actualiza ese perfil con su mismo id (no se crea otro ni se pierden sus
    datos). Con la llave en este navegador, la contraseña en blanco reutiliza la guardada.
- **ReportsView**: tarjetas de reportes (Generar CSV, Editar, Duplicar, Eliminar) e historial. "Generar" abre
  **RunReportModal**: resumen, rango alternativo opcional, validación automática y generación; con errores muestra
  "Generar de todas formas…", que abre el modal de problemas para confirmar. El historial marca con chips las
  ejecuciones "con faltantes" y las que tuvieron filas "fuera de intervalo".
- **ReportEditorView**: asistente de 4 pasos con navegación libre y barra inferior fija con `ValidationStatus`,
  Anterior/Siguiente, Guardar y Generar CSV. Avisa si hay cambios sin guardar al salir.
  1. **MeterPicker**: una sola lista virtualizada con casillas (selección directa = `sourceIds`).
     - "Tags del reporte" (dinámicos, `tagIds`) como chips con X y un select para agregar; botón **Editar tags** que
       abre `/tags` en una pestaña nueva. Los tags no se crean ni se editan aquí.
     - `MeterFilterBar` (búsqueda sin tildes por varias palabras, grupo, modelo, tag o "Sin tags", "solo con datos") y
       vista *Todos / Seleccionados / Con problemas*; seleccionar o deseleccionar los filtrados; Shift+clic para rangos;
       pegar lista (nombre o DisplayName, informa los no encontrados).
     - Filas incluidas solo por un tag dinámico se ven marcadas (casilla atenuada) y no se pueden desmarcar una a una.
       Marcas rojas o amarillas con tooltip por medición; chips de los tags de cada medidor (máx. 3 + "+N").
     - Conmutador **Lista | Árbol** (+ Suministro / Comercial, recordado en `localStorage` `repnode.meterPicker.layout`).
       El árbol (`meter-tree.vue`) es una lista virtualizada de `flattenSupplyTree`/`flattenSpaceTree` (shared): un tablero
       con varias entradas va completo bajo su entrada primaria y como **fila vínculo** bajo los demás padres (clic → lo
       expande, desplaza y resalta). Al final, grupo "Sin ubicar". Con búsqueda, grupo, modelo, tag o vista distinta de
       *Todos* se podan los nodos sin coincidencias y se expande todo cada vez que cambian los resultados, pero cada nodo
       se puede contraer; al quitar los filtros vuelve lo expandido antes. "Solo con datos" no cuenta como filtro del
       árbol (es el valor por defecto: antes, desmarcarlo dejaba todo expandido sin poder contraer).
     - Casilla de nodo = **nodo dinámico** (`panelIds`/`spaceIds`); los nodos aguas abajo/subespacios se ven cubiertos y
       los medidores incluidos, atenuados. Las casillas de los nodos **no** muestran estado parcial por los medidores de
       abajo (parecía que se seleccionaba la ruta hacia arriba).
     - Un medidor aparece en varias filas (salida de su tablero y entrada de cada tablero al que alimenta). Solo se marca
       **una fila** (`meterState`): la que el usuario clicó (`pickedRow`, si no la de su lugar físico `m:<id>`); si lo
       incluye un nodo, las filas dentro de ese nodo; si lo incluye un tag, la de su lugar físico. Las demás dicen "en el
       reporte por otra fila" y un clic mueve la marca a esa fila sin quitarlo del reporte. Los chips de tableros y espacios van junto a los de tags; botón
       **Editar jerarquías** abre `/hierarchy` en otra pestaña.
  2. **MeasurementPicker**: muestra solo las mediciones de los medidores elegidos, con cobertura `n/N` (verde, ámbar o
     rojo); búsqueda; presets (usar, sumar, guardar, eliminar). **El orden de la lista es el orden de las columnas.**
  3. **DateRangeEditor**: rango fijo (`datetime-local` más atajos) o relativo; zona IANA con datalist; muestra la
     consulta en UTC.
  4. **OutputEditor**: formato (Ancho, Largo, ZIP por medidor, Por estampa de tiempo; este último con la casilla
     "Agrupar columnas por medición", el total de columnas y el aviso de varios archivos), separadores, decimales,
     nombre del medidor (DisplayName o Name; deshabilitado en el formato por estampa de tiempo), columna UTC,
     "Completar filas faltantes" con intervalo (filas por día, por medidor y total estimado; aviso si supera el tope) y
     plantilla de nombre con vista previa.
- **Validación en la GUI** (`useValidation`): se dispara con un debounce de 500 ms cada vez que cambia la selección y
  cancela la petición anterior. Generar queda visualmente deshabilitado mientras haya errores (`aria-disabled`), pero al
  hacer clic abre el modal.
  - **ValidationErrorModal**: resumen, columnas "Paso 1/2/3: dónde revisar", detalle por medidor y medición con motivo.
  - Acciones rápidas: quitar medidores sin datos (si vienen de un tag o nodo dinámico, los convierte en selección fija),
    quitar mediciones sin datos, ajustar al rango sugerido, ir al paso, exportar la lista de problemas (CSV) y
    **Generar de todas formas** (`canForce`; pide `confirm()` y relanza el job con `force: true`).
  - Se abre solo cuando aparece un error nuevo estando en los pasos 3 o 4.
- **Jobs** (`useJobRunner`): `POST /api/jobs` → `EventSource` → al llegar `done`, la descarga se dispara con un `<a download>`
  oculto. **JobProgressModal** muestra avance, filas, tamaño, tiempo, ETA, Cancelar y "Descargar de nuevo", más avisos si se
  generó con faltantes (`forced`) o hubo filas fuera de la grilla (`offGridRows`). En cola muestra cuántos reportes hay
  antes (`queuePosition`). Un 422 abre el modal de validación. El historial muestra "por <usuario>" en modo pme.
- **TagsView** (`/tags`): configuración de tags fuera del flujo de reportes.
  - Panel lateral con dos tarjetas: **Nuevo tag** (nombre con espacios; `ColorPalette` = los 8 colores de `TAG_PALETTE`
    + un 9.º círculo con `<input type="color">`, que muestra el color elegido si no es de la base ni de los guardados,
    + fila "Personalizados" del servidor; "Crear y asignar a N seleccionados") y **Tags creados** (clic = filtrar,
    editar con la misma paleta, eliminar; buscador si hay más de 8).
  - Lista de todos los medidores (virtualizada con altura medida, los chips pueden ocupar varias líneas): chips de tags
    con X para quitar y botón **Agregar tag** que abre `TagChooser` (buscar, alternar, crear al vuelo).
  - Filtro extra por **tablero** (slot `selects` de `MeterFilterBar`): tableros indentados por padre primario
    (`supplyPanelOrder`), "Sin tablero" y, al elegir uno, solo sus entradas, salidas y totalizador
    (`panelSourceIds(..., { downstream: false })`, sin aguas abajo).
  - Selección múltiple con `clickSelect`/`checkboxSelect` de shared: clic, Ctrl+clic, Shift+clic, casillas, Ctrl+A y Esc.
    Al cambiar los filtros, la selección se recorta a lo visible (las acciones nunca tocan medidores ocultos).
  - Clic derecho o "Tags de la selección" abre `FloatingMenu` con `TagChooser` (estado todos/algunos/ninguno; clic
    agrega a todos o, si todos lo tienen, lo quita), "Quitar todos sus tags", "Copiar nombres", seleccionar/limpiar.
- **Jerarquías** (`/hierarchy`, `hierarchy-view.vue`): pestañas Suministro | Comercial (`?tab=`), con tres columnas:
  lista de medidores (`hierarchy-meter-list`: filtros + "Sin ubicar/Ubicados", selección múltiple, filas
  de tres líneas: `GRUPO.MEDIDOR`, modelo en letra chica y lugar actual o "sin tablero"/"sin espacio"; doble clic =
  centrar su nodo), lienzo Vue Flow y panel de detalle + **Problemas del diseño**
  (`diagnoseSupply`/`diagnoseSpaces` de shared; clic centra el nodo; contador en la pestaña). Una derivación genera la
  advertencia `shared_feeder` en el tablero de origen: el medidor mide la suma de sus destinos, no cada entrada (los
  futuros cálculos de balance no deben sumarlo una vez por tablero). `DesignIssue.sourceId` identifica ese medidor.
  - **Descargar CSV** (barra del lienzo): se arma en el navegador con `downloadCsv` (sin endpoint) y exporta la
    pestaña activa, `suministro-AAAAMMDD-HHmm.csv` o `comercial-…`.
    - Suministro (`supplyCsvRows`): una fila por **lugar** de cada medidor, en el orden de `supplyPanelOrder`. Por
      tablero: entradas externas, totalizador, alimentadores (una fila por destino; una derivación da N filas con
      `Destinos` = N) y salidas; también las conexiones sin medidor, una fila "Tablero sin medidores" si no tiene filas
      propias y, al final, los medidores "Sin ubicar". Columnas en `SUPPLY_CSV_COLUMNS`: datos del medidor, rol,
      tablero donde está físicamente (modo, nivel, raíz y ruta por el padre primario), entrada destino (en una entrada
      externa, la del propio tablero), origen externo, ruta del espacio en Comercial, problemas de la fila
      (entrada, totalizador o derivación) y problemas del tablero (repetidos en todas sus filas).
    - Comercial (`spacesCsvRows`): una fila por medidor de cada espacio (orden de árbol), una por espacio vacío y los
      sin ubicar al final, con su tablero y rol en Suministro (`SPACES_CSV_COLUMNS`).
  - Cajas: `panel-node` (encabezado con el **ícono** del tablero a la izquierda y su **color** al 50 % de opacidad,
    sufijo alfa `80`; terminales de entrada arriba como *handles* `in-0…in-N` + `in-new`; zona **Σ Totalizador**
    con su medidor y la fórmula "= E1 + E2" o "activa: E1 | E2"; **Salidas** (`panelOutputs` de shared): una fila por
    medidor con todos sus destinos "(B · E1, C · E2)" clicables (ícono ámbar si es derivación); también "sin medidor
    (Destino · E#)"; *handle* `out`), `source-node` (fuente
    externa, hija de su tablero en Vue Flow: posición relativa, se mueve con él) y `space-node`.
  - **Vínculo por clics**: "+ entrada" (o el origen de una entrada) inicia el modo vínculo (`editor.link`): línea
    punteada desde el terminal hasta el puntero (SVG sobre el lienzo, recalculada por `requestAnimationFrame`), aviso
    abajo, tableros válidos con anillo verde y los de aguas abajo atenuados; Esc/clic en el lienzo/clic derecho cancelan.
    El clic se captura en la raíz de `panel-node`: **clic en una salida libre** (fila con `data-out-source`, marcada en
    verde) vincula con ese medidor como el de la entrada (`completeLink(from, sourceId)` → `connectPanels`); si ya
    alimenta a otros tableros se comparte (derivación); si ya alimenta otra entrada del mismo tablero se rechaza con
    aviso y el modo sigue activo; clic en otra parte del tablero crea la entrada sin medidor.
  - Conectar `out` → `in-k`/`in-new` crea o cambia la entrada (`isValidConnection` rechaza ciclos antes de soltar).
    **Va en cada `<Handle>`, no como prop de `<VueFlow>`**: la prop global también valida las aristas existentes y
    descartaba en silencio las de fuentes externas (`x:` → tablero), que dejaban de verse;
    clic en una arista + Supr (o "Desconectar") la deja como fuente externa sin origen. En Comercial, conectar anida.
    Aristas punteadas = tablero en modo ATS; ámbar = entrada sin medidor.
    Las aristas de Suministro son de tipo `supply` (`supply-edge.vue`): `edgeLanes` (shared) agrupa las que salen del
    mismo tablero hacia cada lado y les da un carril (la del destino más lejano dobla primero, así no se cruzan); el
    tramo horizontal va a la altura de su carril, centrado entre las cajas (24 px entre carriles, 26 px de margen), y la
    etiqueta del medidor va en ese tramo con fondo blanco (`label-show-bg`: en `BaseEdge` el booleano omitido es
    false). Los carriles se calculan con las posiciones de `nodes` (guardadas o del layout). `delete-key-code` en null: Vue Flow nunca borra
    nodos por su cuenta.
  - Layout: `layoutGraph` (elkjs, capas hacia abajo separadas 150 px para que quepan los carriles, puertos con
    posición fija) incluye las fuentes externas; los nodos con
    `x`/`y` guardados se respetan; arrastrar una caja guarda su posición; "Reorganizar" borra todas (`reset`).
    `fitWhenMeasured()` espera a que Vue Flow mida los nodos antes de `fitView`.
  - Arrastrar y soltar (`use-meter-drag`, nativo HTML5): desde la lista (si la fila está seleccionada, va toda la
    selección) o desde un medidor de una caja. Soltar sobre una entrada = su medidor (uno solo), sobre "+ entrada" = una
    entrada nueva por medidor, sobre la caja = cargas/miembros, en el lienzo vacío = crear nodo con esos medidores
    (nombre en un `FloatingMenu`), en "Soltar aquí para sacar…" = sin ubicar. `planPanelLoads`/`planPanelInputs`/
    `planSpaceMembers` (shared) colorean el destino (válido/bloqueado) y arman el toast resumen.
  - Clic en un nodo: detalle (columna de 420 px) y resalta la cadena aguas arriba/abajo (el resto atenuado).
    - `panel-detail`: **solo nombre y descripción usan "Guardar cambios"**; ícono (7 opciones, `PANEL_ICON_LABELS`),
      color del encabezado (sin color, paleta base + personalizados de los tags, `<input type="color">` que guarda al
      confirmar con `change`), totalizador, modo, entradas (origen,
      etiqueta y origen externo al salir del campo, medidor, orden, quitar) y salidas se **guardan solos** con cada
      cambio, partiendo siempre de lo guardado (`save(change)`), con indicador "Guardando…/Guardado".
      Botones "Desde tablero" (modo vínculo) y "Fuente externa". Los medidores se eligen en `meter-picker-modal`
      (pantalla grande: filtros comunes, "Solo libres", lista virtualizada, nota por medidor; para una entrada desde X,
      las salidas libres de X van primero; para salidas, selección múltiple).
    - `space-detail`: tipo, padre, subespacios, medidores.
  - Al cambiar el origen de una entrada o reconectarla, el medidor se conserva si era de una entrada externa (pasa a
    salida del nuevo origen) o si ya es salida del nuevo origen; si era salida del origen anterior, se queda allá.
    Desconectar (Supr) deja la entrada externa y sin medidor.
  - `hierarchy-meter-list`: al arrastrar una fila no seleccionada se usa un conjunto local (el v-model de la selección
    se actualiza en el siguiente render).
- **Sincronización de jerarquías**: el store `hierarchy` usa `createCrossTabSync('repnode.hierarchy')`, con la misma
  secuencia anti-pisado que los tags. `catalog.load()` también carga `/api/hierarchy` y `catalog.reset()` la limpia.
- **Sincronización de tags entre ventanas**: cada cambio en el store `catalog` llama a `notifyTagsChanged()`
  (`BroadcastChannel 'repnode.tags'`); las demás pestañas recargan `/api/tags` y `/api/tag-colors`. También se recarga al
  recuperar el foco (cubre otros navegadores). `tagsSeq` evita que una recarga lenta pise un cambio local posterior. El
  editor de reportes revalida cuando cambian los miembros de sus tags o nodos dinámicos (`useValidation(..., extraKey)`).
- **SettingsView**: workers, consultas por worker (muestra el total de conexiones), timeout, TTL, READ UNCOMMITTED y
  refresco del catálogo.
- Las etiquetas de formato salen de `FORMAT_LABELS` (shared).
- Estilos: Tailwind v4 con `@theme` (colores `brand-*`) y clases propias en `@layer components` (`.card`, `.btn`,
  `.btn-primary`, `.input`, `.label`, `.chip`, `.checkbox`). Los toasts van en `bottom-20` para no tapar la barra fija.
- Íconos: `Icon.vue` con paths SVG propios; para agregar uno, extender el mapa `paths`.

Gotchas del frontend:

- **No usar `structuredClone` con datos de stores o props reactivos** (lanza DataCloneError con los Proxy de Vue). Usar
  `clone()` de `lib/util.ts`.
- Los composables devuelven objetos con refs: en plantillas usar `validation.result.value` / `runner.job.value`
  (no se desenvuelven al no ser refs de nivel superior).
- `ApiError` con código `not_connected` dispara `onNotConnected`: resetea los stores y vuelve a `/connect`.
- Un 502/503/504 sin cuerpo desde el proxy se traduce a "El servidor local de RepNode no responde".
- `BaseModal` y `hierarchy-view` escuchan `keydown` en `window`: la vista ignora sus atajos (Esc deselecciona, Supr
  desconecta) mientras haya un `[role="dialog"][aria-modal="true"]` abierto, para que Esc solo cierre el modal.

---

## 7. Desarrollo, pruebas y verificación

```bash
pnpm install
pnpm dev            # GUI http://localhost:5173/repnode/ + API :3210 (node --watch-path; Vite hace proxy de /repnode/api). Si da `EACCES` al escuchar, Windows reservó el puerto (rango de exclusión de winnat): `net stop winnat && net start winnat` como administrador
pnpm test           # vitest: shared (zonas horarias, rangos, nombres, selección de listas, grilla, columnas por timestamp, jerarquías, CSV de jerarquías) + server (CSV, sinks + grilla, combinación por timestamp, cifrado, classify, variables de producción, mensajes de error SQL, multiusuario)
pnpm typecheck      # tsc (shared, server) + vue-tsc (web)
pnpm build          # vue-tsc + vite build → apps/web/dist
pnpm serve          # build + start (un solo proceso en :3210)
```

- `dev` del servidor usa `--watch-path=src --watch-path=../../packages/shared/src`. **No usar `node --watch` a secas**:
  en Windows detecta cambios falsos en `node_modules` (enlaces duros de pnpm) y reinicia en bucle.
- Preview desde Claude Code: `.claude/launch.json` (`repnode-api`, `repnode-web`); la GUI está en `/repnode/`.
- La prueba "más de 16.000 columnas" de `timestamp-merge.test.ts` tarda ~20 s sola y puede pasar el timeout de 60 s
  cuando corre en paralelo con las demás en una máquina cargada.
- Modo pme sin PME real: un servidor HTTP mínimo que responda JSON con el usuario si recibe la cookie
  `.APPLICATIONFRAMEWORK` (y 302 si no) sirve como `REPNODE_PME_USER_URL`, junto con un `REPNODE_DATA_DIR` aparte.
- Verificación contra SQL Server real (copiar `apps/server/.env.test.example` a `.env.test.local`; **nunca versionar
  ni mostrar credenciales**):
  - `pnpm --filter @repnode/server check:vm`: conexión, catálogo y **paridad fila a fila** contra
    `spDAL_GetLoggedData_SMP_TV` en dos medidores de muestra, más cobertura y extracción.
  - `pnpm --filter @repnode/server bench`: enfoque anterior vs RepNode. Si hay menos medidores reales que `BENCH_METERS`,
    los repite. Variables: `BENCH_METERS`, `BENCH_QUANTITIES`, `BENCH_DAYS`, `BENCH_CONFIGS` (p. ej. `1x1,2x4,2x8`),
    `BENCH_HEAP_MB`.
- Entorno de prueba conocido: SQL Server 2022 (16.0) en una VM VMware **en la misma laptop** (i7-1365U, 12 hilos), a la
  que se accede por puerto 1433, sin SQL Browser. Tiene 15 medidores, 4 con datos y unas 400 mil filas en DataLog2. El
  login `Report` no tiene EXECUTE sobre los SP.

### Resultados de referencia

| Escenario | Anterior (serie, solo lectura) | RepNode |
|---|---|---|
| 500 medidores × 4 mediciones, pocos datos | 13,2 s | 2,9 s (2×8), 5,3 s (1×1) |
| 40 × 2 mediciones, 7,5 M filas, 498 MB | 27,7 s | 26,3 s (4×4) |

Lecturas: con muchos medidores mandan las idas y vueltas, y ahí ayudan la consulta agrupada y el paralelismo. Con
mucho volumen manda la lectura y el parseo (~1,2 M filas/s por conexión en la VM). `arrayRowMode` y el timestamp como
epoch **no mejoraron**, ya se probaron. El costo actual por fila ronda 2,5 µs, del cual el formateo es ~0,4 µs.

---

## 8. Convenciones

- TypeScript estricto. Imports de tipos con `import type`. Comentarios breves en español, solo donde aportan el "por qué".
- **Archivos nuevos en minúscula con guion medio** (`hierarchy-view.vue`, `meter-tree.vue`, `cross-tab-sync.ts`). Los
  existentes con otro estilo (`MeterPicker.vue`, `tagSync.ts`…) no se renombran salvo que se pida.
- Validación de entrada siempre con los esquemas zod de `packages/shared`. Si cambia un contrato de la API, actualizar
  `schemas.ts` y `types.ts` y ajustar ambos lados.
- SQL: siempre parametrizado (`req.input`), nunca concatenar valores del usuario. Mantener `WITH (NOLOCK)` o
  READ UNCOMMITTED en las lecturas.
- Toda funcionalidad nueva con lógica pura debe traer pruebas en Vitest (`*.test.ts` junto al archivo).
- No agregar dependencias nativas ni scripts de instalación.
- No hacer commits ni push sin que el usuario lo pida.

---

## 9. Mantenimiento de este archivo

**Cada vez que se modifique algo en el sistema** (código, esquema SQLite, API, flujos de la GUI, dependencias, scripts,
configuración, decisiones de rendimiento o hallazgos sobre la BD de PME), **actualiza este AGENTS.md en el mismo
cambio**, para que siga siendo una fuente fiel. Si algo de lo descrito aquí deja de ser cierto, corrígelo o elimínalo;
no dejes información obsoleta.

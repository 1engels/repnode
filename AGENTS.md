# AGENTS.md — Base de conocimiento de RepNode

Guía técnica para agentes de IA y desarrolladores que trabajen en este repositorio. Describe qué hace el sistema, cómo
está organizado, sus flujos, las decisiones de diseño y los problemas ya resueltos. **Léelo antes de modificar código.**

---

## 1. Propósito

RepNode es una **app local**: un backend Node.js más una GUI web que se usan desde `localhost`. Se conecta a la base
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
| Frontend | Vite 8 (rolldown), Vue 3.5 (composition API, `<script setup>`), Tailwind CSS v4 (`@tailwindcss/vite`), Pinia 4, vue-router 5, `@vueuse/core`, `@tanstack/vue-virtual` |
| Compartido | `packages/shared`: esquemas zod, tipos DTO y utilidades puras (zonas horarias, rangos, nombres de archivo) |
| Tipos | TypeScript **~6.0**. No subir a 7 mientras `vue-tsc` dependa de la API JS de TypeScript |
| Pruebas | Vitest 5 |

Decisiones de librerías:

- Se usa **`node:sqlite`** y no `better-sqlite3`, porque el pnpm del usuario tiene `ignoreScripts: true` y los módulos
  nativos no compilarían. No agregar dependencias con binarios nativos.
- `archiver` v8 es ESM con clases nombradas: `import { ZipArchive } from 'archiver'` (no hay export default).
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
├─ .claude/launch.json        servidores de preview: repnode-api (3210) y repnode-web (5173)
├─ database/ION_Data-creation-script.sql   esquema de PME (UTF-16 LE, ~3,5 MB) — solo referencia
├─ data/                      (git-ignorado) app.db, master.key, jobs/ (temporales)
├─ packages/shared/src/
│  ├─ schemas.ts              zod: conexión, rango, salida, selección, reporte, job, tags (+ TAG_PALETTE), presets, settings
│  ├─ types.ts                DTOs de API (catálogo, validación, jobs, historial…)
│  ├─ time.ts                 zonas horarias con Intl: tzOffsetMs, localToUtcMs, LocalTimeFormatter (caché 15 min)
│  ├─ range.ts                resolveRange(): rangos fijos y relativos → local + UTC
│  ├─ filename.ts             sanitizeFileName() (Windows) y renderFileName() (plantilla con tokens)
│  ├─ list-selection.ts       clickSelect() (clic/Ctrl/Shift estilo explorador) y checkboxSelect() (+ pruebas)
│  ├─ grid.ts                 grilla para completar filas: makeGrid, gridSlotCount, isOnGrid, MAX_GRID_ROWS (+ pruebas)
│  └─ time.test.ts
├─ apps/server/
│  ├─ src/
│  │  ├─ index.ts             Fastify, filtro de Host, manejo de errores, registro de rutas, estáticos en prod
│  │  ├─ config.ts            host/puerto/rutas de datos (variables REPNODE_*), flag --prod
│  │  ├─ errors.ts            HttpError, describeSqlError, isTransientSqlError
│  │  ├─ selection.ts         resolveMeters (directos + tags dinámicos) y resolveSelection
│  │  ├─ validate.ts          validación previa: classify() puro + validateSelection() SQL + caché
│  │  ├─ security/secrets.ts  clave maestra, HKDF, AES-256-GCM, profileIdFor (SHA-256)
│  │  ├─ store/sqlite.ts      migraciones (PRAGMA user_version) y repositorios
│  │  ├─ mssql/config.ts      buildMssqlConfig() (objeto plano, se pasa a los workers)
│  │  ├─ mssql/session.ts     sesión activa única: pool, catálogo, verificación de versión y objetos
│  │  ├─ mssql/catalog.ts     carga de Source/SourceType/Quantity/SourceQuantity
│  │  ├─ mssql/queries.ts     SQL de extracción (dataSql) y cobertura (coverageSql)
│  │  ├─ routes/connection.ts sesión, test, connect, disconnect, perfiles
│  │  ├─ routes/catalog.ts    catálogo, tags, presets, settings
│  │  ├─ routes/reports.ts    CRUD de reportes, validate, jobs (crear/SSE/cancelar/descargar), historial
│  │  └─ jobs/
│  │     ├─ job-manager.ts    cola FIFO (1 job a la vez), reparto en shards, workers, progreso, TTL
│  │     ├─ job-worker.ts     worker_thread: pool propio, p-limit, reintentos, cancelación
│  │     ├─ extract.ts        extractMeter(): 1 consulta en streaming por medidor → archivo parcial
│  │     ├─ formats.ts        WideSink (pivot en streaming), LongSink, headerLine
│  │     ├─ csv.ts            CsvFormatter (RFC 4180, decimal), BufferedWriter (contrapresión), BOM, EOL
│  │     ├─ assemble.ts       une parciales (ancho/largo) o arma el ZIP
│  │     └─ protocol.ts       mensajes padre↔worker, MeterTask, partPath
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
   ├─ lib/tagSync.ts          aviso de cambios de tags entre pestañas (BroadcastChannel) + recarga al recuperar el foco
   ├─ lib/useJobRunner.ts     crea job, sigue SSE, descarga automática, maneja 422
   ├─ lib/issues.ts           textos de problemas de validación
   ├─ lib/util.ts             búsqueda sin tildes, formatos, clone(), triggerDownload, downloadCsv, nextTagColor
   ├─ stores/                 session (perfiles en localStorage), catalog (+tags, presets), reports, toast
   ├─ views/                  ConnectView, ReportsView, ReportEditorView, TagsView, SettingsView
   └─ components/             MeterPicker, MeasurementPicker, DateRangeEditor, OutputEditor, ValidationStatus,
                              ValidationErrorModal, JobProgressModal, RunReportModal, PasteListModal, BaseModal,
                              ToastHost, Icon, MeterLabel, MeterFilterBar, TagChip, TagChooser, ColorPalette, FloatingMenu
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

- Escucha en **`127.0.0.1:3210`** por defecto (`REPNODE_HOST`, `REPNODE_PORT`).
- Hook `onRequest`: rechaza con 403 cualquier `Host` que no sea `localhost`, `127.0.0.1` o `[::1]`. Protege contra
  DNS rebinding. El proxy de Vite conserva el Host `localhost` (`changeOrigin: false`).
- Manejador de errores: `HttpError` → `{ error, message, details }` con su status; `ZodError` → 400 con mensajes por campo.
- En producción (`--prod` o `NODE_ENV=production`) sirve `apps/web/dist` con fallback SPA a `index.html`.
- `disableRequestLogging: true`, para que los logs no se llenen con cada petición.
- `initJobs()` marca como interrumpidos los jobs del historial que quedaron a medias y borra `data/jobs/*`.

### 5.2 Sesión SQL (`mssql/session.ts`)

- **Una sola sesión activa** en memoria (app local de un usuario). Si el backend se reinicia, se pierde y la GUI vuelve a
  la pantalla de conexión (respuesta 409 `not_connected` → `onNotConnected` en el frontend).
- `openPool()` verifica tres cosas: versión ≥ 13 (SQL 2016), que existan `Source`, `Quantity`, `SourceQuantity`,
  `DataLog2` y `vwDataLog2` en `dbo`, y luego carga el catálogo.
- `buildMssqlConfig()`: `useUTC: true`, `packetSize: 32768`, `appName: 'RepNode'`.
  - **Si hay puerto, se usa el puerto y se ignora la instancia** (no depende de SQL Server Browser, UDP 1434). Si solo hay
    instancia, se usa `instanceName`.
  - Autenticación NTLM: se activa al pasar `domain`.

### 5.3 Catálogo (`mssql/catalog.ts`)

Tres `SELECT ... WITH (NOLOCK)` en paralelo: Source+SourceType, Quantity y SourceQuantity. Se guardan en memoria con
mapas por ID y por nombre y una cobertura `Map<sourceId, Map<quantityId, {min,max}>>` en ms UTC.
`GET /api/catalog` devuelve medidores, **solo las mediciones presentes en SourceQuantity** y `sourceQuantities`
(sourceId → quantityIds). Se refresca con `POST /api/catalog/refresh`.

### 5.4 Persistencia local (`store/sqlite.ts`, `data/app.db`)

Migraciones versionadas con `PRAGMA user_version`; para cambiar el esquema, **agregar un string nuevo al arreglo
`migrations`**, nunca editar uno ya publicado. Tablas:

- `connection_profiles`: id = SHA-256 de server|port|instance|database|domain|username; incluye `pwd_cipher`, `pwd_iv`, `pwd_tag`.
- `tags` y `tag_members`: los miembros se guardan por **`Source.Name`** (estable), no por ID. Todo va por perfil.
  El nombre admite espacios (los repetidos se reducen a uno) y es único por perfil.
- `tag_colors` (migración v2): paleta personalizada de colores por perfil (máx. 24, los más recientes primero). Un tag
  creado o editado con un color fuera de `TAG_PALETTE` (shared) agrega ese color automáticamente.
- `measurement_presets`: guarda **nombres** de Quantity en JSON y los resuelve a IDs con el catálogo.
- `reports`: `definition_json` validado con `reportDefinitionSchema`. Todo va por perfil.
- `job_history`: estado, filas, bytes, resumen de validación y error. Migración v3: `forced` (generado pese a errores de
  validación) y `off_grid_rows` (filas extra fuera de la grilla).
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
ejecutar), ordenados como el catálogo (alfabético por DisplayName). El rango se resuelve con `resolveRange()` en la
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
  job-manager: cola FIFO, un job a la vez → reparte medidores round-robin en K shards
    └─ K worker_threads (job-worker.ts), cada uno con su ConnectionPool (max = C) y p-limit(C)
         └─ extractMeter(): UNA consulta en streaming por medidor (todas sus mediciones)
              → RowSink (WideSink / LongSink) → BufferedWriter → data/jobs/<id>/<index>.part
  → assemble(): BOM + encabezado + parciales en orden → output.csv   |   ZipArchive → output.zip
  → SSE de progreso → GET /download → los archivos se borran tras downloadTtlMinutes
```

Detalles clave:

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
- **Completar filas** (`output.fillGaps` + `output.intervalMinutes` ∈ `GRID_INTERVALS` = 1, 5, 10, 15, 30, 60; por defecto
  apagado y 15 min): los sinks reciben un `TimeGrid` y escriben una fila por casillero sin datos, con el valor en blanco.
  - Casilleros = `inicio + k·intervalo` dentro de `(inicio, fin]` (misma semántica del rango): un día a 15 min da
    96 filas, de 00:15 a 00:00 del día siguiente.
  - Ancho y ZIP: filas en blanco antes, entre y después de los datos; un medidor sin datos recibe la grilla completa.
  - Largo: cada medición recibe su grilla completa, también las que no tienen datos, en orden de QuantityID (el de la
    consulta).
  - Un timestamp con datos que no cae en la grilla **se conserva como fila extra** (no se mueve ni se descarta) y se
    cuenta en `offGrid` → `JobState.offGridRows` → aviso en JobProgressModal e historial.
  - Tope: `MAX_GRID_ROWS` = 50 M filas estimadas (medidores × casilleros × mediciones si es largo); por encima, 400
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

| Método y ruta | Descripción |
|---|---|
| `GET /api/session` | Estado de la conexión |
| `POST /api/connection/test` | Prueba de conexión, con `{params,password}` o `{profileId,clientSecret}` |
| `POST /api/connection/connect` | Conexión nueva (`params`, `password`, `remember`, `clientSecret`) o con perfil (`profileId`, `clientSecret`) |
| `POST /api/connection/disconnect` | Cierra el pool |
| `GET /api/profiles` · `DELETE /api/profiles/:id` | Perfiles guardados en el servidor |
| `GET /api/catalog` · `POST /api/catalog/refresh` | Catálogo |
| `GET/POST /api/tags`, `PUT/DELETE /api/tags/:id`, `POST /api/tags/:id/members` | Tags (`{sourceIds, action:'add'|'remove'}`); `POST` acepta `sourceIds` iniciales; cada operación devuelve la lista completa |
| `GET/POST /api/tag-colors`, `DELETE /api/tag-colors/:hex` | Paleta personalizada (`{color:'#rrggbb'}`; en el DELETE, el hex va sin `#`); devuelven la lista |
| `GET/POST /api/presets`, `DELETE /api/presets/:id` | Presets de mediciones (POST hace upsert por nombre) |
| `GET/PUT /api/settings` | Rendimiento y TTL |
| `GET/POST /api/reports`, `GET/PUT/DELETE /api/reports/:id` | Reportes |
| `POST /api/reports/validate` | `{selection, rangeOverride?}` o `{reportId, rangeOverride?}` → `ValidationResult` |
| `POST /api/jobs` | `{reportId, rangeOverride?, force?}` o `{definition, rangeOverride?, force?}`. Sin `force`, responde 422 `validation_failed` con `details` = `ValidationResult` si hay errores; 400 `grid_too_large` si la grilla supera el tope |
| `GET /api/jobs/:id` · `GET /api/jobs/:id/events` (SSE) · `POST /api/jobs/:id/cancel` · `GET /api/jobs/:id/download` | Ciclo de vida del job |
| `GET /api/history` | Últimas 50 ejecuciones del perfil |

Códigos de error frecuentes: `not_connected` (409), `connect_failed`, `invalid_database`, `unsupported_version`,
`decrypt_failed` (401), `profile_not_found`, `validation_failed` (422), `grid_too_large` (400), `invalid_input` (400), `not_found`.

---

## 6. Frontend

- Rutas: `/connect` (pública), `/reports`, `/reports/new`, `/reports/:id/edit`, `/tags`, `/settings`. El guard redirige a
  `/connect` si no hay sesión.
- **Orden y etiqueta de medidores en la GUI**: el store ordena por `Source.Name` (`GRUPO.MEDIDOR`, orden natural) y
  `MeterLabel` muestra el nombre con el **modelo** (`SourceType.Name`) al lado en gris claro; el DisplayName solo si
  difiere. El servidor sigue ordenando por DisplayName (orden de filas en el CSV).
- **ConnectView**: perfiles recordados (de `localStorage`, con conexión en un clic); perfiles del servidor sin secreto en
  este navegador ("ingresa la contraseña de nuevo"); formulario (instancia y puerto se excluyen entre sí en la GUI,
  SQL o NTLM, TLS, confiar en el certificado, Recordar); "Probar conexión".
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
  2. **MeasurementPicker**: muestra solo las mediciones de los medidores elegidos, con cobertura `n/N` (verde, ámbar o
     rojo); búsqueda; presets (usar, sumar, guardar, eliminar). **El orden de la lista es el orden de las columnas.**
  3. **DateRangeEditor**: rango fijo (`datetime-local` más atajos) o relativo; zona IANA con datalist; muestra la
     consulta en UTC.
  4. **OutputEditor**: formato, separadores, decimales, nombre del medidor (DisplayName o Name), columna UTC,
     "Completar filas faltantes" con intervalo (filas por día, por medidor y total estimado; aviso si supera el tope) y
     plantilla de nombre con vista previa.
- **Validación en la GUI** (`useValidation`): se dispara con un debounce de 500 ms cada vez que cambia la selección y
  cancela la petición anterior. Generar queda visualmente deshabilitado mientras haya errores (`aria-disabled`), pero al
  hacer clic abre el modal.
  - **ValidationErrorModal**: resumen, columnas "Paso 1/2/3: dónde revisar", detalle por medidor y medición con motivo.
  - Acciones rápidas: quitar medidores sin datos (si vienen de un tag dinámico, convierte los tags en selección fija),
    quitar mediciones sin datos, ajustar al rango sugerido, ir al paso, exportar la lista de problemas (CSV) y
    **Generar de todas formas** (`canForce`; pide `confirm()` y relanza el job con `force: true`).
  - Se abre solo cuando aparece un error nuevo estando en los pasos 3 o 4.
- **Jobs** (`useJobRunner`): `POST /api/jobs` → `EventSource` → al llegar `done`, la descarga se dispara con un `<a download>`
  oculto. **JobProgressModal** muestra avance, filas, tamaño, tiempo, ETA, Cancelar y "Descargar de nuevo", más avisos si se
  generó con faltantes (`forced`) o hubo filas fuera de la grilla (`offGridRows`). Un 422 abre
  el modal de validación.
- **TagsView** (`/tags`): configuración de tags fuera del flujo de reportes.
  - Panel lateral: crear tag (nombre con espacios, `ColorPalette` = paleta base + personalizados del servidor +
    `<input type="color">`/hex, "Crear y asignar a N seleccionados") y lista de tags (clic = filtrar, editar, eliminar).
  - Lista de todos los medidores (virtualizada con altura medida, los chips pueden ocupar varias líneas): chips de tags
    con X para quitar y botón **+** que abre `TagChooser` (buscar, alternar, crear al vuelo).
  - Selección múltiple con `clickSelect`/`checkboxSelect` de shared: clic, Ctrl+clic, Shift+clic, casillas, Ctrl+A y Esc.
    Al cambiar los filtros, la selección se recorta a lo visible (las acciones nunca tocan medidores ocultos).
  - Clic derecho o "Tags de la selección" abre `FloatingMenu` con `TagChooser` (estado todos/algunos/ninguno; clic
    agrega a todos o, si todos lo tienen, lo quita), "Quitar todos sus tags", "Copiar nombres", seleccionar/limpiar.
- **Sincronización de tags entre ventanas**: cada cambio en el store `catalog` llama a `notifyTagsChanged()`
  (`BroadcastChannel 'repnode.tags'`); las demás pestañas recargan `/api/tags` y `/api/tag-colors`. También se recarga al
  recuperar el foco (cubre otros navegadores). `tagsSeq` evita que una recarga lenta pise un cambio local posterior. El
  editor de reportes revalida cuando cambian los miembros de sus tags dinámicos (`useValidation(..., extraKey)`).
- **SettingsView**: workers, consultas por worker (muestra el total de conexiones), timeout, TTL, READ UNCOMMITTED y
  refresco del catálogo.
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

---

## 7. Desarrollo, pruebas y verificación

```bash
pnpm install
pnpm dev            # API :3210 (node --watch-path) + Vite :5173 (proxy /api)
pnpm test           # vitest: shared (zonas horarias, rangos, nombres, selección de listas, grilla) + server (CSV, sinks + grilla, cifrado, classify)
pnpm typecheck      # tsc (shared, server) + vue-tsc (web)
pnpm build          # vue-tsc + vite build → apps/web/dist
pnpm serve          # build + start (un solo proceso en :3210)
```

- `dev` del servidor usa `--watch-path=src --watch-path=../../packages/shared/src`. **No usar `node --watch` a secas**:
  en Windows detecta cambios falsos en `node_modules` (enlaces duros de pnpm) y reinicia en bucle.
- Preview desde Claude Code: `.claude/launch.json` (`repnode-api`, `repnode-web`).
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

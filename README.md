# RepNode · Extractor de mediciones ION_Data

App local (backend Node.js + GUI web) para extraer datos de medidores desde la base **ION_Data** de Schneider Electric
Power Monitoring Expert (SQL Server 2016+) y descargarlos como **CSV compatible con Excel en Windows**. No muestra
datos en pantalla: todo se descarga.

Flujos:

- Conectar → elegir reporte guardado → **Generar CSV**
- Conectar → nuevo reporte → medidores → mediciones → rango y zona horaria → salida → **Generar CSV**

### Jerarquías de medidores

En **Jerarquías** se ordenan los medidores en dos estructuras independientes de los tags:

- **Suministro** (circuitos): tableros con *fuentes de entrada* (cada una viene de otro tablero o de una fuente externa
  como la red pública o un grupo electrógeno, con su medidor asociado), *cargas* y modo **Suma** (entradas simultáneas)
  o **ATS** (conmutación / respaldo). Un tablero puede alimentarse desde varios tableros.
- **Comercial** (espacios físicos): edificio › piso › zona…, con los medidores de cada espacio.

El editor es un diagrama: se conectan salidas con entradas, se arrastran medidores (uno o una selección) sobre las cajas
o al lienzo vacío para crear un nodo nuevo, y un panel lista los problemas del diseño (entradas sin medidor, tableros sin
alimentación, ATS con una sola entrada…). Cada medidor ocupa un solo lugar por jerarquía.

En el paso 1 de un reporte, el botón **Árbol** muestra los medidores por Suministro o por Comercial. Marcar un tablero o
un espacio lo agrega como **nodo dinámico**: al generar entran sus medidores actuales, con todo su aguas abajo o sus
subespacios.

## Requisitos

- Node.js **24+** (ejecuta TypeScript directamente; incluye `node:sqlite`, sin módulos nativos)
- pnpm 10+
- Acceso de lectura a la base ION_Data

## Uso

```bash
pnpm install
pnpm dev        # API en http://localhost:3210 + GUI en http://localhost:5173
```

Producción (un solo proceso que sirve la GUI compilada en http://localhost:3210):

```bash
pnpm serve      # = pnpm build && pnpm start
```

Variables opcionales (`apps/server/.env.local`): `REPNODE_PORT`, `REPNODE_DATA_DIR` (por defecto `./data`), `REPNODE_LOG_LEVEL`.

### Conexión a PME de producción

Si el servidor tiene estas variables (en el entorno o en `apps/server/.env.local`), la pantalla de conexión muestra el
botón verde **Conectar con PME de producción**, que se activa solo si la conexión se puede establecer:

| Variable | Descripción |
|---|---|
| `REPNODE_SERVER` | IP o nombre del servidor SQL (obligatoria) |
| `REPNODE_INSTANCE` | Nombre de la instancia (opcional; solo se usa si no se indica puerto) |
| `REPNODE_DB_PORT` | Puerto de SQL Server. Por defecto 1433, salvo que haya instancia (entonces se resuelve con SQL Server Browser) |
| `REPNODE_DB_NAME` | Base de datos, por defecto `ION_Data` |
| `REPNODE_AUTH_USER` | Usuario SQL (obligatoria) |
| `REPNODE_AUTH_PASS` | Contraseña del usuario SQL (obligatoria). Nunca se envía al navegador |

Se autentica con usuario SQL y confía en el certificado del servidor. Al cambiar las variables hay que reiniciar RepNode.

## Arquitectura

```
packages/shared   esquemas zod, tipos de API, zonas horarias (Intl), rangos relativos, nombres de archivo
apps/server       Fastify · mssql/tedious · node:sqlite · worker_threads
apps/web          Vite 8 · Vue 3 (composition API) · Tailwind v4 · Pinia · listas virtualizadas · Vue Flow + elkjs (diagrama de jerarquías)
```

### Por qué es más rápido que el software anterior

El software anterior hacía, por cada medidor × medición, `spDAL_GetNameForMeasurement` + `spDAL_GetMeasurements` +
`spDAL_GetLoggedData_SMP_TV`, en serie. RepNode:

1. Carga el catálogo **una vez** (`Source`, `Quantity`, `SourceQuantity`).
2. Hace **una consulta por medidor** con todas sus mediciones sobre `vwDataLog2` (misma semántica que SMP_TV:
   `TimestampUTC > inicio AND <= fin`), apoyada en el índice clustered `(SourceID, QuantityID, TimestampUTC)`.
3. Hace **streaming** con contrapresión hacia archivos parciales, así la memoria se mantiene constante.
4. Reparte los medidores entre **K worker threads × C consultas en paralelo**, configurable en *Configuración*.
5. Usa `READ UNCOMMITTED` (opcional) para no bloquear la ingesta de PME.

La app es **solo lectura** y no crea objetos en la base de PME. La base usa `COMPATIBILITY_LEVEL 110`, por eso las listas
viajan como parámetros `@q0..@qN` en lugar de `OPENJSON` o `STRING_SPLIT`.

### Resultados medidos (SQL Server 2022 en VMware, en la misma laptop)

| Escenario | Anterior (SP por par, en serie, solo lectura) | RepNode |
|---|---|---|
| 500 medidores × 4 mediciones, pocos datos por medidor | 13,2 s | **2,9 s** (2 workers × 8), CSV incluido |
| 40 × 2 mediciones, 7,5 M de filas (498 MB de CSV) | 27,7 s | 26,3 s (4 × 4), CSV incluido |

- Con cientos de medidores dominan las idas y vueltas a la base: RepNode hace 1 consulta por medidor (en vez de ~14) y las
  lanza en paralelo. Con latencia de red real la diferencia crece, porque el enfoque anterior paga esa latencia en cada llamada.
- Con pocos medidores de mucho volumen el límite es leer y formatear filas; ahí los workers reparten la CPU.
- La VM de prueba compartía CPU con la app, así que la escala con un servidor SQL dedicado debería ser mejor.
- Paridad verificada: mismas filas, timestamps y valores que `spDAL_GetLoggedData_SMP_TV` (`check:vm`).

Notas de conexión: si se indica **puerto**, se conecta directo y no requiere SQL Server Browser (UDP 1434); con solo el
nombre de instancia, sí lo necesita. El usuario de SQL solo requiere `db_datareader` sobre ION_Data.

### Validación previa

Antes de generar, la app verifica (con dos *seeks* por par sobre el índice clustered) que **cada medidor tenga datos de
cada medición en el rango**. Si algún par no tiene datos, el botón *Generar* se bloquea, los medidores con problemas se
marcan en la lista y se abre un modal con el detalle, dónde revisar y acciones rápidas: quitar medidores, quitar
mediciones o ajustar el rango. El servidor repite la verificación al crear el job.

### CSV

UTF-8 con BOM, CRLF y comillas RFC 4180. Separador y decimal configurables (por defecto `;` y `,`). Formatos:

- **ancho**: medidor + fecha/hora + una columna por medición
- **largo**: medidor, medición, unidad, fecha/hora, valor
- **ZIP**: un CSV por medidor

### Credenciales

La contraseña se cifra con AES-256-GCM. La clave se deriva (HKDF-SHA256) de `data/master.key`, que está en el servidor
local, y de un secreto aleatorio que solo guarda el navegador (`localStorage`). El ID de cada perfil nace como un hash
SHA-256 de servidor, puerto, BD y usuario, y se conserva al editar la conexión (por ejemplo, si cambió la IP del
servidor), así que sus reportes, tags y jerarquías se mantienen. Al editar se puede dejar la contraseña en blanco para
usar la guardada. El navegador nunca guarda la contraseña. El backend solo escucha en `127.0.0.1`.

## Pruebas

```bash
pnpm test                                   # unitarias (CSV, zonas horarias, cifrado, validación)
pnpm typecheck
```

Contra un SQL Server real (copiar `apps/server/.env.test.example` a `apps/server/.env.test.local`):

```bash
pnpm --filter @repnode/server check:vm      # conexión, catálogo, paridad con spDAL_GetLoggedData_SMP_TV, extracción
pnpm --filter @repnode/server bench         # anterior (SP por par en serie) vs RepNode con varias combinaciones K×C
```

// Verificación contra un SQL Server real (solo lectura):
//   1. conexión, versión y catálogo
//   2. paridad: spDAL_GetLoggedData_SMP_TV vs la consulta agrupada de RepNode
//   3. consulta de cobertura (validación previa)
//   4. extracción de un medidor a CSV
// Uso: pnpm --filter @repnode/server check:vm
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sql from 'mssql';
import { outputSchema } from '@repnode/shared';
import { buildMssqlConfig } from '../src/mssql/config.ts';
import { loadCatalog } from '../src/mssql/catalog.ts';
import { bindCommon, coverageSql, dataSql, READ_UNCOMMITTED } from '../src/mssql/queries.ts';
import { createExtractContext, extractMeter } from '../src/jobs/extract.ts';
import { testConnection } from './test-env.ts';
import { getLoggedDataSmpTv, legacyMode } from './legacy.ts';

const { params, password } = testConnection();
const pool = new sql.ConnectionPool(buildMssqlConfig(params, password, { poolMax: 4, requestTimeoutMs: 600_000 }));
const t = () => performance.now();
const DAY = 86_400_000;

try {
  let t0 = t();
  await pool.connect();
  const v = await pool.request().query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, DB_NAME() AS db, (SELECT compatibility_level FROM sys.databases WHERE name = DB_NAME()) AS compat");
  console.log(`✔ Conectado en ${(t() - t0).toFixed(0)} ms · SQL Server ${v.recordset[0].v} · BD ${v.recordset[0].db} · compat ${v.recordset[0].compat}`);

  const rowsInfo = await pool.request().query(
    "SELECT SUM(p.rows) AS n FROM sys.partitions p WHERE p.object_id = OBJECT_ID('dbo.DataLog2') AND p.index_id IN (0, 1)",
  );
  console.log(`  DataLog2: ~${Number(rowsInfo.recordset[0].n).toLocaleString('es')} filas`);

  t0 = t();
  const cat = await loadCatalog(pool);
  let sqRows = 0;
  for (const m of cat.coverage.values()) sqRows += m.size;
  console.log(`✔ Catálogo en ${(t() - t0).toFixed(0)} ms · ${cat.sources.length} medidores · ${cat.quantityById.size} mediciones · ${sqRows} pares en SourceQuantity`);
  const groups = new Map<string, number>();
  cat.sources.forEach((s) => groups.set(s.group, (groups.get(s.group) ?? 0) + 1));
  console.log('  Grupos:', [...groups].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([g, n]) => `${g}(${n})`).join(', '));

  // Muestras: el medidor con más mediciones y el que tiene datos más recientes
  const ranked = [...cat.coverage].map(([sid, m]) => ({ sid, n: m.size, max: Math.max(...[...m.values()].map((c) => c.max)) }));
  if (!ranked.length) throw new Error('SourceQuantity está vacía: no hay datos para probar');
  const byCount = [...ranked].sort((a, b) => b.n - a.n || b.max - a.max)[0];
  const byRecent = [...ranked].sort((a, b) => b.max - a.max)[0];
  const samples = byCount.sid === byRecent.sid ? [byCount] : [byCount, byRecent];
  let allParity = true;

  for (const sample of samples) {
  const cov = cat.coverage.get(sample.sid)!;
  const qids = [...cov.entries()].sort((a, b) => b[1].max - a[1].max).slice(0, 4).map(([q]) => q);
  const end = Math.min(...qids.map((q) => cov.get(q)!.max));
  const toUtc = new Date(Math.floor(end / DAY) * DAY + DAY); // incluye el último dato
  const fromUtc = new Date(toUtc.getTime() - 30 * DAY);
  const src = cat.sourceById.get(sample.sid)!;
  console.log(`\nMuestra: "${src.displayName}" (${src.name}, ID ${src.id}) · mediciones ${qids.map((q) => `${cat.quantityById.get(q)?.name} (${q})`).join(', ')}`);
  console.log(`Rango UTC: ${fromUtc.toISOString()} → ${toUtc.toISOString()}`);

  // Paridad
  t0 = t();
  const legacy = new Map<number, { ts: number; v: number | null }[]>();
  for (const q of qids) {
    const r = await getLoggedDataSmpTv(pool, sample.sid, q, fromUtc, toUtc);
    legacy.set(q, r.recordset.map((x) => ({ ts: x.TimestampUTC.getTime(), v: x.Value })));
  }
  const tLegacy = t() - t0;

  t0 = t();
  const req = pool.request();
  const p = bindCommon(req, sample.sid, qids, fromUtc, toUtc);
  const ours = await req.query<{ QuantityID: number; TimestampUTC: Date; Value: number | null }>(dataSql(p, 'quantity', READ_UNCOMMITTED));
  const tOurs = t() - t0;
  const grouped = new Map<number, { ts: number; v: number | null }[]>(qids.map((q) => [q, []]));
  for (const r of ours.recordset) grouped.get(r.QuantityID)!.push({ ts: r.TimestampUTC.getTime(), v: r.Value });

  let parityOk = true;
  for (const q of qids) {
    const a = legacy.get(q)!;
    const b = grouped.get(q)!;
    const same = a.length === b.length && a.every((x, i) => x.ts === b[i].ts && (x.v === b[i].v || (Number.isNaN(x.v) && Number.isNaN(b[i].v))));
    parityOk &&= same;
    allParity &&= same;
    console.log(`  ${same ? '✔' : '✘'} ${cat.quantityById.get(q)?.name}: SMP_TV ${a.length} filas · RepNode ${b.length} filas`);
  }
  console.log(`${parityOk ? '✔ Paridad OK' : '✘ DIFERENCIAS EN PARIDAD'} · SMP_TV (${legacyMode()}) ×${qids.length}: ${tLegacy.toFixed(0)} ms · consulta agrupada: ${tOurs.toFixed(0)} ms`);

  // Cobertura (validación) incluyendo una medición que el medidor no registra
  const missingQ = [...cat.quantityById.keys()].find((q) => !cov.has(q));
  const covIds = missingQ ? [...qids, missingQ] : qids;
  t0 = t();
  const creq = pool.request();
  const cp = bindCommon(creq, sample.sid, covIds, fromUtc, toUtc);
  const cres = await creq.query<{ QuantityID: number; FirstTs: Date | null; LastTs: Date | null }>(coverageSql(cp, READ_UNCOMMITTED));
  console.log(`\n✔ Cobertura en ${(t() - t0).toFixed(0)} ms:`);
  for (const r of cres.recordset) {
    console.log(`  ${cat.quantityById.get(r.QuantityID)?.name}: ${r.FirstTs ? `${r.FirstTs.toISOString()} → ${r.LastTs?.toISOString()}` : 'SIN DATOS'}`);
  }

  // Extracción a CSV (formato ancho)
  const dir = mkdtempSync(join(tmpdir(), 'repnode-check-'));
  const columns = qids.map((q) => ({ id: q, name: cat.quantityById.get(q)!.name, unit: cat.quantityById.get(q)!.unit }));
  const ctx = createExtractContext(columns, fromUtc.getTime(), toUtc.getTime(), 'America/Lima', outputSchema.parse({ format: 'zip' }), true);
  t0 = t();
  const file = join(dir, 'muestra.csv');
  const res = await extractMeter(pool, sample.sid, src.displayName, file, ctx);
  console.log(`\n✔ Extracción CSV en ${(t() - t0).toFixed(0)} ms · ${res.rows} filas · ${res.bytes} bytes`);
  console.log(readFileSync(file, 'utf8').split('\r\n').slice(0, 4).join('\n'));
  rmSync(dir, { recursive: true, force: true });
  }
  console.log(`
${allParity ? '✔ PARIDAD TOTAL OK' : '✘ HAY DIFERENCIAS DE PARIDAD'}`);
} catch (err) {
  console.error('✘ Error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.close();
}

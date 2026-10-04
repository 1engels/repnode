import sql, { type Request } from 'mssql';

// Todas las consultas son SELECT parametrizados. La BD tiene COMPATIBILITY_LEVEL 110,
// así que no se usa OPENJSON ni STRING_SPLIT: las listas van como parámetros @q0..@qN.

export const READ_UNCOMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n';
export const READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED;\n';

/** Máximo de mediciones por consulta (SQL Server admite hasta 2100 parámetros). */
export const MAX_QUANTITIES_PER_QUERY = 1000;

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function bindCommon(req: Request, sourceId: number, quantityIds: number[], fromUtc: Date, toUtc: Date): string[] {
  req.input('s', sql.Int, sourceId);
  req.input('a', sql.DateTime2(7), fromUtc);
  req.input('b', sql.DateTime2(7), toUtc);
  return quantityIds.map((q, i) => {
    req.input(`q${i}`, sql.SmallInt, q);
    return `@q${i}`;
  });
}

/**
 * Datos de un medidor para varias mediciones. Misma semántica que spDAL_GetLoggedData_SMP_TV:
 * vwDataLog2 (DataLog2 + Burst), TimestampUTC > inicio AND <= fin.
 * order 'time' -> para formato ancho (pivot en streaming); 'quantity' -> orden del índice clustered (largo).
 * OPTIMIZE FOR UNKNOWN: el plan (seek + sort) se compila una vez con densidades promedio y se reutiliza.
 * RECOMPILE duplicaba el costo de cada consulta chica (medido: 15,7 vs 7,2 ms), que es el caso de cientos de medidores.
 */
export function dataSql(params: string[], order: 'time' | 'quantity', isolation: string): string {
  return `${isolation}SELECT d.QuantityID, d.TimestampUTC, d.Value
FROM dbo.vwDataLog2 d
WHERE d.SourceID = @s AND d.QuantityID IN (${params.join(',')})
  AND d.TimestampUTC > @a AND d.TimestampUTC <= @b
ORDER BY ${order === 'time' ? 'd.TimestampUTC, d.QuantityID' : 'd.QuantityID, d.TimestampUTC'}
OPTION (OPTIMIZE FOR UNKNOWN);`;
}

/** Primer y último dato real dentro del rango por medición (2 seeks por par sobre el índice clustered). */
export function coverageSql(params: string[], isolation: string): string {
  return `${isolation}SELECT q.QuantityID,
  (SELECT TOP (1) d.TimestampUTC FROM dbo.vwDataLog2 d
     WHERE d.SourceID = @s AND d.QuantityID = q.QuantityID AND d.TimestampUTC > @a AND d.TimestampUTC <= @b
     ORDER BY d.TimestampUTC ASC) AS FirstTs,
  (SELECT TOP (1) d.TimestampUTC FROM dbo.vwDataLog2 d
     WHERE d.SourceID = @s AND d.QuantityID = q.QuantityID AND d.TimestampUTC > @a AND d.TimestampUTC <= @b
     ORDER BY d.TimestampUTC DESC) AS LastTs
FROM (VALUES ${params.map((p) => `(${p})`).join(',')}) AS q(QuantityID);`;
}

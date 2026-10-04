// Réplica del acceso del software anterior. Si el usuario no tiene EXECUTE sobre los SP,
// se ejecuta su cuerpo literal (tomado de database/ION_Data-creation-script.sql).
import sql, { type ConnectionPool } from 'mssql';

let useBody = false;

function denied(err: unknown): boolean {
  return (err as { number?: number })?.number === 229; // EXECUTE permission denied
}

async function run<T>(viaSp: () => Promise<T>, viaBody: () => Promise<T>): Promise<T> {
  if (useBody) return viaBody();
  try {
    return await viaSp();
  } catch (err) {
    if (!denied(err)) throw err;
    useBody = true;
    console.log('  (sin permiso EXECUTE: se usa el cuerpo literal de los SP)');
    return viaBody();
  }
}

export function legacyMode(): string {
  return useBody ? 'cuerpo literal del SP' : 'EXEC del SP';
}

export function getIdForSource(pool: ConnectionPool, name: string) {
  return run(
    () => pool.request().input('Name', sql.NVarChar(250), name).execute('dbo.spDAL_GetIDForSource'),
    () => pool.request().input('Name', sql.NVarChar(250), name).query('SELECT [ID] AS [SourceID] FROM Source WHERE [Name] = @Name'),
  );
}

export function getNameForMeasurement(pool: ConnectionPool, id: number) {
  return run(
    () => pool.request().input('ID', sql.Int, id).execute('dbo.spDAL_GetNameForMeasurement'),
    () => pool.request().input('ID', sql.Int, id).query('SELECT Name FROM dbo.Quantity WHERE ID = @ID'),
  );
}

/** spDAL_GetLoggedData_SMP_TV: parámetros DATETIME, TimestampUTC > inicio AND <= fin, desde vwDataLog2. */
export function getLoggedDataSmpTv(pool: ConnectionPool, sourceId: number, quantityId: number, from: Date, to: Date) {
  const bind = () =>
    pool.request()
      .input('SourceID', sql.Int, sourceId).input('MeasurementID', sql.Int, quantityId)
      .input('StartDateUtc', sql.DateTime, from).input('EndDateUtc', sql.DateTime, to);
  return run(
    () => bind().execute<{ TimestampUTC: Date; Value: number | null }>('dbo.spDAL_GetLoggedData_SMP_TV'),
    () => bind().query<{ TimestampUTC: Date; Value: number | null }>(
      `SELECT TimestampUTC, Value FROM vwDataLog2
       WHERE SourceID = @SourceID AND QuantityID = @MeasurementID
         AND TimestampUTC > @StartDateUtc AND TimestampUTC <= @EndDateUtc
       ORDER BY TimestampUTC`,
    ),
  );
}

import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  gridSlotCount, jobRequestSchema, makeGrid, MAX_GRID_ROWS, rangeSchema, reportDefinitionSchema, selectionSchema, type ReportDTO,
} from '@repnode/shared';
import { HttpError } from '../errors.ts';
import { cancelJob, createJob, getJob, subscribe } from '../jobs/job-manager.ts';
import { requireSession } from '../mssql/session.ts';
import { resolveSelection } from '../selection.ts';
import { history, reports } from '../store/sqlite.ts';
import { validateCached } from '../validate.ts';

const idParam = z.object({ id: z.coerce.number().int() });
const jobParam = z.object({ id: z.string().min(1).max(64) });

const validateSchema = z.union([
  z.object({ selection: selectionSchema, rangeOverride: rangeSchema.optional() }),
  z.object({ reportId: z.number().int(), rangeOverride: rangeSchema.optional() }),
]);

const toDTO = (r: NonNullable<ReturnType<typeof reports.get>>): ReportDTO => r;

function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export default async function reportRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Reportes guardados
  // -------------------------------------------------------------------------
  app.get('/api/reports', async () => reports.list(requireSession().profileId).map(toDTO));

  app.get('/api/reports/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const r = reports.get(requireSession().profileId, id);
    if (!r) throw new HttpError(404, 'Reporte no encontrado', 'not_found');
    return toDTO(r);
  });

  app.post('/api/reports', async (req) => {
    const s = requireSession();
    const def = reportDefinitionSchema.parse(req.body);
    const id = reports.create(s.profileId, def);
    return toDTO(reports.get(s.profileId, id)!);
  });

  app.put('/api/reports/:id', async (req) => {
    const s = requireSession();
    const { id } = idParam.parse(req.params);
    const def = reportDefinitionSchema.parse(req.body);
    if (!reports.update(s.profileId, id, def)) throw new HttpError(404, 'Reporte no encontrado', 'not_found');
    return toDTO(reports.get(s.profileId, id)!);
  });

  app.delete('/api/reports/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    reports.remove(requireSession().profileId, id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Validación previa
  // -------------------------------------------------------------------------
  app.post('/api/reports/validate', async (req, reply) => {
    const s = requireSession();
    const body = validateSchema.parse(req.body);
    let selection;
    if ('selection' in body) selection = body.selection;
    else {
      const r = reports.get(s.profileId, body.reportId);
      if (!r) throw new HttpError(404, 'Reporte no encontrado', 'not_found');
      selection = r.definition;
    }
    const resolved = resolveSelection(s, selection, body.rangeOverride);
    // Si el navegador cancela (la selección cambió), se dejan de lanzar consultas
    const ac = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) ac.abort();
    });
    return validateCached(s, resolved, true, ac.signal);
  });

  // -------------------------------------------------------------------------
  // Jobs de generación
  // -------------------------------------------------------------------------
  app.post('/api/jobs', async (req) => {
    const s = requireSession();
    const body = jobRequestSchema.parse(req.body);
    let definition;
    let reportId: number | null = null;
    if ('reportId' in body) {
      const r = reports.get(s.profileId, body.reportId);
      if (!r) throw new HttpError(404, 'Reporte no encontrado', 'not_found');
      definition = reportDefinitionSchema.parse(r.definition);
      reportId = r.id;
    } else {
      definition = body.definition;
    }
    const selection = resolveSelection(s, definition, body.rangeOverride);
    const { output } = definition;
    if (output.fillGaps) {
      // Tope de seguridad: la grilla se escribe aunque no haya datos (p. ej. 1 min durante un año × cientos de medidores)
      const slots = gridSlotCount(makeGrid(selection.range.fromUtcMs, selection.range.toUtcMs, output.intervalMinutes));
      // Por estampa de tiempo hay una sola fila por casillero para todos los medidores
      const rows = output.format === 'timestamp' ? slots : slots * selection.sourceIds.length * (output.format === 'long' ? selection.quantityIds.length : 1);
      if (rows > MAX_GRID_ROWS) {
        throw new HttpError(400, `Completar filas generaría unas ${rows.toLocaleString('es')} filas (máximo ${MAX_GRID_ROWS.toLocaleString('es')}). Usa un intervalo mayor o un rango más corto.`, 'grid_too_large');
      }
    }
    // Validación obligatoria también en el servidor. Con `force` el usuario confirmó generar pese a los faltantes.
    const validation = await validateCached(s, selection, false);
    if (validation.status === 'error' && !body.force) {
      throw new HttpError(422, 'Hay medidores sin datos para las mediciones seleccionadas', 'validation_failed', validation);
    }
    return createJob({ session: s, definition, reportId, selection, validation, forced: validation.status === 'error' });
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = jobParam.parse(req.params);
    const job = getJob(id);
    if (!job) throw new HttpError(404, 'Job no encontrado', 'not_found');
    return job.state;
  });

  app.get('/api/jobs/:id/events', (req, reply) => {
    const { id } = jobParam.parse(req.params);
    if (!getJob(id)) throw new HttpError(404, 'Job no encontrado', 'not_found');
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const unsubscribe = subscribe(id, (state) => {
      reply.raw.write(`data: ${JSON.stringify(state)}\n\n`);
    });
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.socket.on('close', () => {
      clearInterval(ping);
      unsubscribe?.();
    });
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = jobParam.parse(req.params);
    return { ok: cancelJob(id) };
  });

  app.get('/api/jobs/:id/download', async (req, reply) => {
    const { id } = jobParam.parse(req.params);
    const job = getJob(id);
    if (!job || job.state.status !== 'done') throw new HttpError(404, 'El archivo no está disponible (puede haber expirado)', 'not_found');
    const isZip = job.outFile.endsWith('.zip');
    reply
      .header('Content-Type', isZip ? 'application/zip' : 'text/csv; charset=utf-8')
      .header('Content-Disposition', contentDisposition(job.state.fileName))
      .header('Content-Length', job.state.bytes)
      .header('Cache-Control', 'no-store');
    return reply.send(createReadStream(job.outFile));
  });

  app.get('/api/history', async () => history.list(requireSession().profileId));
}

import type { MeterValidation, PairIssue, QuantityDTO } from '@repnode/shared';
import { formatIsoDate } from './util';

export const issueLabels: Record<PairIssue['status'], string> = {
  missing_quantity: 'El medidor no registra esta medición',
  no_data_in_range: 'Sin datos en el rango',
  partial: 'Datos incompletos en el rango',
};

export function describeIssue(i: PairIssue, timeZone?: string): string {
  if (i.status === 'missing_quantity') return issueLabels.missing_quantity;
  if (i.status === 'no_data_in_range') {
    return i.availableFromUtc
      ? `Sin datos en el rango (hay datos del ${formatIsoDate(i.availableFromUtc, timeZone)} al ${formatIsoDate(i.availableToUtc, timeZone)})`
      : issueLabels.no_data_in_range;
  }
  return `Datos parciales: primer dato ${formatIsoDate(i.firstUtc, timeZone)}, último ${formatIsoDate(i.lastUtc, timeZone)}`;
}

export function meterIssueTooltip(m: MeterValidation, quantities: Map<number, QuantityDTO>, timeZone?: string): string {
  return m.issues.map((i) => `• ${quantities.get(i.quantityId)?.name ?? i.quantityId}: ${describeIssue(i, timeZone)}`).join('\n');
}

export function meterErrorCount(m: MeterValidation): number {
  return m.issues.filter((i) => i.status !== 'partial').length;
}

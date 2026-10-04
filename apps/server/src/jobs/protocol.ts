import type { config as MssqlConfig } from 'mssql';
import type { OutputOptions } from '@repnode/shared';
import type { QuantityColumn } from './formats.ts';

export interface MeterTask {
  /** Posición del medidor en el archivo final */
  index: number;
  sourceId: number;
  label: string;
}

export interface WorkerInput {
  workerNo: number;
  mssql: MssqlConfig;
  readUncommitted: boolean;
  concurrency: number;
  meters: MeterTask[];
  columns: QuantityColumn[];
  fromUtcMs: number;
  toUtcMs: number;
  timezone: string;
  output: OutputOptions;
  dir: string;
}

export type WorkerMessage =
  | { type: 'meter'; index: number; rows: number; bytes: number; offGrid: number }
  | { type: 'retry'; index: number; attempt: number; error: string }
  | { type: 'fatal'; error: string }
  | { type: 'done' };

export type ParentMessage = { type: 'cancel' };

export const partPath = (dir: string, index: number) => `${dir}/${index}.part`;

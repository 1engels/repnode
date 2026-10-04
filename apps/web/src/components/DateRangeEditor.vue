<script setup lang="ts">
import { computed } from 'vue';
import {
  isValidTimeZone, relativePresetLabels, relativePresets, resolveRange, tzOffsetMs,
  type DateRange, type RelativePreset,
} from '@repnode/shared';
import Icon from './Icon.vue';
import { formatLocal, localTimeZone } from '../lib/util';

const range = defineModel<DateRange>('range', { required: true });
const timezone = defineModel<string>('timezone', { required: true });
defineProps<{ compact?: boolean }>();

const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [localTimeZone()];
  }
})();

const tzValid = computed(() => isValidTimeZone(timezone.value));

function offsetLabel(tz: string): string {
  if (!isValidTimeZone(tz)) return '';
  const off = tzOffsetMs(Date.now(), tz) / 60000;
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const resolved = computed(() => {
  if (!tzValid.value) return null;
  try {
    return resolveRange(range.value, timezone.value);
  } catch {
    return null;
  }
});

function utcLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function setMode(mode: 'fixed' | 'relative') {
  if (mode === range.value.mode) return;
  if (mode === 'fixed') {
    const r = resolved.value ?? resolveRange({ mode: 'relative', preset: 'previousMonth' }, localTimeZone());
    range.value = { mode: 'fixed', from: r.fromLocal, to: r.toLocal };
  } else {
    range.value = { mode: 'relative', preset: 'previousMonth' };
  }
}

/** Atajos que rellenan un rango fijo */
function quick(preset: RelativePreset, days?: number) {
  const r = resolveRange({ mode: 'relative', preset, days }, timezone.value);
  range.value = { mode: 'fixed', from: r.fromLocal, to: r.toLocal };
}

const fixed = computed(() => (range.value.mode === 'fixed' ? range.value : null));
const relative = computed(() => (range.value.mode === 'relative' ? range.value : null));

function updateFixed(key: 'from' | 'to', value: string) {
  if (!fixed.value || !value) return;
  range.value = { ...fixed.value, [key]: value.slice(0, 16) };
}

function updatePreset(preset: RelativePreset) {
  range.value = { mode: 'relative', preset, days: preset === 'lastNDays' ? (relative.value?.days ?? 7) : undefined };
}

function updateDays(days: number) {
  if (!relative.value) return;
  range.value = { ...relative.value, days: Math.max(1, Math.min(3660, Math.round(days) || 1)) };
}

const invalidOrder = computed(() => !!fixed.value && fixed.value.from >= fixed.value.to);
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4" :class="!compact && 'md:grid-cols-2'">
      <div>
        <span class="label">Tipo de rango</span>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" class="btn justify-start" :class="range.mode === 'fixed' && '!border-brand-500 !bg-brand-50 text-brand-700'" @click="setMode('fixed')">
            <Icon name="calendar" /> Fechas fijas
          </button>
          <button type="button" class="btn justify-start" :class="range.mode === 'relative' && '!border-brand-500 !bg-brand-50 text-brand-700'" @click="setMode('relative')">
            <Icon name="clock" /> Relativo (al generar)
          </button>
        </div>
      </div>
      <div>
        <label class="label" for="tz">Zona horaria</label>
        <div class="flex items-center gap-2">
          <input id="tz" v-model="timezone" class="input" :class="!tzValid && '!border-red-400'" list="tz-list" placeholder="America/Lima" />
          <span class="text-xs whitespace-nowrap text-slate-500">{{ offsetLabel(timezone) }}</span>
        </div>
        <datalist id="tz-list">
          <option v-for="z in zones" :key="z" :value="z" />
        </datalist>
        <p v-if="!tzValid" class="mt-1 text-xs text-red-600">Zona horaria no reconocida</p>
      </div>
    </div>

    <div v-if="fixed" class="grid gap-4 md:grid-cols-2">
      <div>
        <label class="label" for="from">Desde (hora local)</label>
        <input id="from" type="datetime-local" class="input" :value="fixed.from" @change="updateFixed('from', ($event.target as HTMLInputElement).value)" />
      </div>
      <div>
        <label class="label" for="to">Hasta (hora local)</label>
        <input id="to" type="datetime-local" class="input" :value="fixed.to" @change="updateFixed('to', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="flex flex-wrap gap-1.5 md:col-span-2">
        <span class="mr-1 self-center text-xs text-slate-500">Atajos:</span>
        <button type="button" class="btn btn-sm" @click="quick('yesterday')">Ayer</button>
        <button type="button" class="btn btn-sm" @click="quick('lastNDays', 7)">Últimos 7 días</button>
        <button type="button" class="btn btn-sm" @click="quick('lastNDays', 30)">Últimos 30 días</button>
        <button type="button" class="btn btn-sm" @click="quick('previousWeek')">Semana anterior</button>
        <button type="button" class="btn btn-sm" @click="quick('previousMonth')">Mes anterior</button>
        <button type="button" class="btn btn-sm" @click="quick('currentMonth')">Mes en curso</button>
        <button type="button" class="btn btn-sm" @click="quick('previousYear')">Año anterior</button>
      </div>
    </div>

    <div v-else-if="relative" class="grid gap-4 md:grid-cols-2">
      <div>
        <label class="label" for="preset">Periodo</label>
        <select id="preset" class="input" :value="relative.preset" @change="updatePreset(($event.target as HTMLSelectElement).value as RelativePreset)">
          <option v-for="p in relativePresets" :key="p" :value="p">{{ relativePresetLabels[p] }}</option>
        </select>
      </div>
      <div v-if="relative.preset === 'lastNDays'">
        <label class="label" for="days">Días</label>
        <input id="days" type="number" min="1" max="3660" class="input" :value="relative.days ?? 7" @change="updateDays(Number(($event.target as HTMLInputElement).value))" />
      </div>
      <p class="text-xs text-slate-500 md:col-span-2">Los rangos relativos se calculan al momento de generar: ideal para reportes recurrentes.</p>
    </div>

    <div v-if="invalidOrder" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">La fecha inicial debe ser anterior a la final.</div>
    <div v-else-if="resolved" class="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
      <div><b>{{ formatLocal(resolved.fromLocal) }}</b> → <b>{{ formatLocal(resolved.toLocal) }}</b> <span class="text-slate-500">({{ timezone }})</span></div>
      <div class="text-xs text-slate-500">
        Consulta en UTC: {{ utcLabel(resolved.fromUtcMs) }} &lt; TimestampUTC ≤ {{ utcLabel(resolved.toUtcMs) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

// Menú flotante posicionado en coordenadas de pantalla (clic derecho o botón).
// Se cierra con Escape, clic fuera, scroll fuera del menú o al cambiar el tamaño de la ventana.
const props = defineProps<{ x: number; y: number }>();
const emit = defineEmits<{ close: [] }>();

const el = ref<HTMLElement | null>(null);
const pos = ref({ left: props.x, top: props.y });

function place() {
  const box = el.value?.getBoundingClientRect();
  if (!box) return;
  const m = 8;
  let left = props.x;
  let top = props.y;
  if (left + box.width > window.innerWidth - m) left = Math.max(m, window.innerWidth - box.width - m);
  if (top + box.height > window.innerHeight - m) top = Math.max(m, props.y - box.height);
  pos.value = { left, top };
}

function outside(e: Event) {
  if (el.value && !el.value.contains(e.target as Node)) emit('close');
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  }
}
const close = () => emit('close');

onMounted(async () => {
  await nextTick();
  place();
  // Se registra en el siguiente ciclo para no capturar el mismo clic que abrió el menú
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    document.addEventListener('scroll', outside, true);
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('contextmenu', outside, true);
  document.removeEventListener('scroll', outside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', close);
});

defineExpose({ place });
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="fixed z-[60] w-72 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm shadow-xl"
      :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
      role="menu"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

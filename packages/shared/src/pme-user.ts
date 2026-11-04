/**
 * Nombre visible de un usuario de PME. PME identifica a cada usuario con un IdentityId compuesto,
 * p. ej. "internal:database:e9ce4532-85d8-44be-b8cf-54e629a107f1:supervisor" (tipo de cuenta, GUID y nombre).
 * RepNode guarda y compara el identificador completo (es único); en pantalla muestra solo el último tramo.
 * Si el valor no tiene esa forma, se muestra tal cual.
 */
export function pmeDisplayName(identityId: string): string {
  const last = identityId.slice(identityId.lastIndexOf(':') + 1).trim();
  return last || identityId;
}

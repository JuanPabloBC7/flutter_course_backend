// Los 5 escenarios de aceptacion contra el servidor REAL por stdio (src/index.ts con tsx).
// La logica vive en scripts/escenarios.ts para reutilizarla en la evidencia.

import { describe, it } from 'node:test';

import {
  scenario1,
  scenario2,
  scenario3,
  scenario4,
  scenario5,
} from '../scripts/escenarios.js';

// Los logs del escenario se descartan en el test; el runner ya reporta pass/fail.
const silent = (): void => undefined;

describe('escenarios de aceptacion (servidor real por stdio)', () => {
  it('1. transferir 100 USD de W-001 a W-002', () => scenario1('src', silent));
  it('2. saldo de W-003 y reglas desde los recursos', () => scenario2('src', silent));
  it('3. saldo insuficiente es legible y no mueve dinero', () => scenario3('src', silent));
  it('4. cotizacion vencida: QUOTE_EXPIRED y sugerencia', () => scenario4('src', silent));
  it('5. misma idempotencyKey: mismo resultado y un solo debito', () => scenario5('src', silent));
});

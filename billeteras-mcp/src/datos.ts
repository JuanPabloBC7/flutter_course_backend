// Datos en memoria del taller: billeteras semilla y tabla fija de tasas.
// No hay API externa de tasas (ver decisiones en .specs/SPEC-MCP.md).

import type { RateTable, Wallet } from './reglas.js';

// Vigencia por defecto de una cotizacion: 60 segundos (R2).
export const DEFAULT_QUOTE_TTL_MS = 60_000;

// Tasas escaladas a millonesimas (1_000_000 = 1.0). Se guardan como enteros
// para que el calculo del monto destino nunca use flotantes.
// Ejemplo: USD -> EUR 920_000 significa 0.92.
export const RATES_MICROS: RateTable = {
  USD: { USD: 1_000_000n, EUR: 920_000n, COP: 4_000_000_000n },
  EUR: { USD: 1_087_000n, EUR: 1_000_000n, COP: 4_350_000_000n },
  COP: { USD: 250n, EUR: 230n, COP: 1_000_000n },
};

// Billeteras semilla. Saldos en unidades minimas (centavos).
export function createSeedWallets(): Map<string, Wallet> {
  return new Map<string, Wallet>([
    ['W-001', { id: 'W-001', currency: 'USD', balance: 50_000 }],
    ['W-002', { id: 'W-002', currency: 'EUR', balance: 10_000 }],
    ['W-003', { id: 'W-003', currency: 'COP', balance: 200_000_000 }],
  ]);
}

// Tests de las reglas de negocio (R1 a R5). Sin MCP: solo reglas.ts + datos.ts.
// El reloj se inyecta: aqui es una variable controlada por el test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RATES_MICROS, createSeedWallets } from '../src/datos.js';
import {
  convertAmount,
  createEngine,
  sumByCurrency,
  type Engine,
  type RuleError,
  type Result,
  type Wallet,
} from '../src/reglas.js';

const KEY_1 = '11111111-1111-4111-8111-111111111111';
const KEY_2 = '22222222-2222-4222-8222-222222222222';

interface Harness {
  engine: Engine;
  wallets: Map<string, Wallet>;
  clock: { now: number };
  creditFails: { value: boolean };
}

// Crea un motor con billeteras semilla, reloj controlado e ids predecibles.
function makeHarness(): Harness {
  const wallets = createSeedWallets();
  const clock = { now: 1_000_000 };
  const creditFails = { value: false };
  let counter = 0;
  const engine = createEngine({
    wallets,
    rates: RATES_MICROS,
    now: () => clock.now,
    newId: () => `id-${++counter}`,
    creditWallet: (wallet, amount) => {
      if (creditFails.value) {
        throw new Error('fallo simulado al acreditar');
      }
      wallet.balance += amount;
    },
  });
  return { engine, wallets, clock, creditFails };
}

function unwrap<T>(result: Result<T>): T {
  assert.equal(result.ok, true, 'se esperaba exito: ' + JSON.stringify(result));
  if (!result.ok) {
    throw new Error('inalcanzable');
  }
  return result.value;
}

function unwrapError<T>(result: Result<T>): RuleError {
  assert.equal(result.ok, false, 'se esperaba error de regla');
  if (result.ok) {
    throw new Error('inalcanzable');
  }
  return result.error;
}

function balances(wallets: Map<string, Wallet>): Record<string, number> {
  return Object.fromEntries([...wallets.values()].map((w) => [w.id, w.balance]));
}

// Cotiza USD -> EUR y devuelve el id de la cotizacion.
function quoteUsdEur(h: Harness, amount: number): string {
  return unwrap(h.engine.quote({ origin: 'USD', destination: 'EUR', amount })).quoteId;
}

describe('aritmetica de dinero', () => {
  it('convierte con enteros y redondea hacia abajo', () => {
    assert.equal(convertAmount(10_000, 920_000n), 9_200);
    assert.equal(convertAmount(1_001, 920_000n), 920); // 920.92 -> 920
    assert.equal(convertAmount(1, 920_000n), 0);
  });

  it('devuelve siempre enteros', () => {
    assert.equal(Number.isInteger(convertAmount(12_345, 1_087_000n)), true);
  });
});

describe('cotizar', () => {
  it('devuelve id, tasa, monto destino entero y expiracion a 60 s', () => {
    const h = makeHarness();
    const quote = unwrap(h.engine.quote({ origin: 'USD', destination: 'EUR', amount: 10_000 }));
    assert.equal(quote.rate, 0.92);
    assert.equal(quote.destinationAmount, 9_200);
    assert.equal(Number.isInteger(quote.destinationAmount), true);
    assert.equal(quote.expiresAt, new Date(1_000_000 + 60_000).toISOString());
    assert.ok(quote.quoteId.length > 0);
  });

  it('no mueve dinero', () => {
    const h = makeHarness();
    const before = balances(h.wallets);
    quoteUsdEur(h, 10_000);
    assert.deepEqual(balances(h.wallets), before);
  });

  for (const amount of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e15]) {
    it(`rechaza monto invalido ${String(amount)} con INVALID_AMOUNT`, () => {
      const h = makeHarness();
      const error = unwrapError(h.engine.quote({ origin: 'USD', destination: 'EUR', amount }));
      assert.equal(error.code, 'INVALID_AMOUNT');
    });
  }

  it('rechaza un monto cuyo equivalente destino seria 0', () => {
    const h = makeHarness();
    const error = unwrapError(h.engine.quote({ origin: 'COP', destination: 'USD', amount: 1_000 }));
    assert.equal(error.code, 'INVALID_AMOUNT');
  });
});

describe('R1 saldo nunca negativo', () => {
  it('rechaza con INSUFFICIENT_FUNDS y el mensaje exacto sin cambiar saldos', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 1_000_000);
    const before = balances(h.wallets);
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'INSUFFICIENT_FUNDS');
    assert.ok(error.message.includes('Saldo disponible: 50000; monto requerido: 1000000'));
    assert.deepEqual(balances(h.wallets), before);
    assert.equal(h.engine.journal().length, 0);
  });

  it('permite transferir el saldo exacto y deja el origen en 0', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 50_000);
    const result = unwrap(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(result.originBalance, 0);
    assert.equal(h.wallets.get('W-001')?.balance, 0);
    assert.equal(h.wallets.get('W-002')?.balance, 10_000 + 46_000);
  });

  it('ninguna billetera queda con saldo negativo', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 50_001);
    unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    for (const wallet of h.wallets.values()) {
      assert.equal(wallet.balance >= 0, true);
    }
  });
});

describe('R2 cotizacion vigente', () => {
  it('acepta una cotizacion de menos de 60 s', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    h.clock.now += 59_999;
    const result = h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 });
    assert.equal(result.ok, true);
  });

  it('rechaza con QUOTE_EXPIRED a los 60 s y sugiere cotizar de nuevo', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const before = balances(h.wallets);
    h.clock.now += 60_000;
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'QUOTE_EXPIRED');
    assert.ok(error.suggestion.includes('cotizar'));
    assert.deepEqual(balances(h.wallets), before);
  });

  it('rechaza con QUOTE_EXPIRED una cotizacion que no existe', () => {
    const h = makeHarness();
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId: 'no-existe', idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'QUOTE_EXPIRED');
    assert.ok(error.suggestion.includes('cotizar'));
  });

  it('una cotizacion es de un solo uso (otra llave no la reutiliza)', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    unwrap(h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }));
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_2 }),
    );
    assert.equal(error.code, 'QUOTE_EXPIRED');
    assert.equal(h.wallets.get('W-001')?.balance, 40_000);
  });
});

describe('R3 atomicidad', () => {
  it('si falla el credito se revierte el debito y no hay asientos', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const before = balances(h.wallets);
    h.creditFails.value = true;
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'TRANSFER_FAILED');
    assert.deepEqual(balances(h.wallets), before);
    assert.equal(h.engine.journal().length, 0);
  });

  it('tras un fallo se puede reintentar con la misma llave y la misma cotizacion', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    h.creditFails.value = true;
    unwrapError(h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }));
    h.creditFails.value = false;
    unwrap(h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }));
    assert.equal(h.wallets.get('W-001')?.balance, 40_000);
    assert.equal(h.wallets.get('W-002')?.balance, 19_200);
  });
});

describe('R4 asientos que suman cero por moneda', () => {
  it('USD a EUR: debito W-001 / credito FX_CLEARING_USD y debito FX_CLEARING_EUR / credito W-002', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const result = unwrap(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.deepEqual(result.entries, [
      { account: 'W-001', currency: 'USD', direction: 'DEBIT', amount: 10_000 },
      { account: 'FX_CLEARING_USD', currency: 'USD', direction: 'CREDIT', amount: 10_000 },
      { account: 'FX_CLEARING_EUR', currency: 'EUR', direction: 'DEBIT', amount: 9_200 },
      { account: 'W-002', currency: 'EUR', direction: 'CREDIT', amount: 9_200 },
    ]);
    assert.deepEqual(sumByCurrency(result.entries), { USD: 0, EUR: 0 });
    assert.deepEqual(sumByCurrency(h.engine.journal()), { USD: 0, EUR: 0 });
  });

  it('cada transferencia suma cero en cada moneda (USD a COP)', () => {
    const h = makeHarness();
    const quoteId = unwrap(h.engine.quote({ origin: 'USD', destination: 'COP', amount: 12_345 })).quoteId;
    const result = unwrap(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-003', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.deepEqual(sumByCurrency(result.entries), { USD: 0, COP: 0 });
  });

  it('misma moneda entre billeteras distintas: tasa 1 y suma cero', () => {
    const h = makeHarness();
    h.wallets.set('W-004', { id: 'W-004', currency: 'USD', balance: 0 });
    const quote = unwrap(h.engine.quote({ origin: 'USD', destination: 'USD', amount: 700 }));
    assert.equal(quote.rate, 1);
    const result = unwrap(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-004', quoteId: quote.quoteId, idempotencyKey: KEY_1 }),
    );
    assert.deepEqual(sumByCurrency(result.entries), { USD: 0 });
    assert.equal(h.wallets.get('W-004')?.balance, 700);
  });
});

describe('R5 idempotencia', () => {
  it('la misma llave dos veces: un solo debito y resultado identico', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const input = { originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 };
    const first = unwrap(h.engine.transfer(input));
    const second = unwrap(h.engine.transfer(input));
    assert.deepEqual(second, first);
    assert.equal(h.wallets.get('W-001')?.balance, 40_000);
    assert.equal(h.wallets.get('W-002')?.balance, 19_200);
    assert.equal(h.engine.journal().length, 4);
  });

  it('el reintento funciona aunque la cotizacion ya haya vencido', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const input = { originId: 'W-001', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 };
    const first = unwrap(h.engine.transfer(input));
    h.clock.now += 5 * 60_000;
    const second = unwrap(h.engine.transfer(input));
    assert.deepEqual(second, first);
    assert.equal(h.wallets.get('W-001')?.balance, 40_000);
  });

  it('la misma llave con datos distintos se rechaza con IDEMPOTENCY_KEY_REUSED', () => {
    const h = makeHarness();
    const quoteA = quoteUsdEur(h, 10_000);
    const quoteB = quoteUsdEur(h, 5_000);
    unwrap(h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId: quoteA, idempotencyKey: KEY_1 }));
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-002', quoteId: quoteB, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(h.wallets.get('W-001')?.balance, 40_000);
  });
});

describe('validaciones de billeteras', () => {
  it('SAME_WALLET cuando origen y destino son el mismo id', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const before = balances(h.wallets);
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-001', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'SAME_WALLET');
    assert.deepEqual(balances(h.wallets), before);
  });

  it('WALLET_NOT_FOUND lista los ids validos (transferencia)', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-999', destinationId: 'W-002', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'WALLET_NOT_FOUND');
    for (const id of ['W-001', 'W-002', 'W-003']) {
      assert.ok(error.message.includes(id), `falta ${id} en: ${error.message}`);
    }
  });

  it('WALLET_NOT_FOUND lista los ids validos (consulta de saldo)', () => {
    const h = makeHarness();
    const error = unwrapError(h.engine.getWallet('W-999'));
    assert.equal(error.code, 'WALLET_NOT_FOUND');
    for (const id of ['W-001', 'W-002', 'W-003']) {
      assert.ok(error.message.includes(id));
    }
  });

  it('CURRENCY_MISMATCH si la moneda de la billetera no coincide con la cotizacion', () => {
    const h = makeHarness();
    const quoteId = quoteUsdEur(h, 10_000);
    const before = balances(h.wallets);
    // W-003 es COP pero la cotizacion es USD -> EUR
    const error = unwrapError(
      h.engine.transfer({ originId: 'W-001', destinationId: 'W-003', quoteId, idempotencyKey: KEY_1 }),
    );
    assert.equal(error.code, 'CURRENCY_MISMATCH');
    assert.deepEqual(balances(h.wallets), before);
  });

  it('getWallet devuelve el saldo en unidades minimas', () => {
    const h = makeHarness();
    assert.deepEqual(unwrap(h.engine.getWallet('W-003')), { id: 'W-003', currency: 'COP', balance: 200_000_000 });
  });
});

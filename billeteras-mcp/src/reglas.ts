// Reglas de negocio PURAS de las billeteras (R1 a R5).
// Este archivo no conoce MCP, ni stdio, ni zod: solo dinero, cotizaciones y asientos.
// La numeracion R1..R5 es la misma que en .specs/SPEC-MCP.md y en los tests.
//
// Dinero: siempre enteros en unidad minima (centavos). Nunca flotantes.
// Las tasas son enteros escalados a millonesimas (bigint); el unico numero
// decimal del modulo es `rate`, y solo existe en la salida para mostrarse.

import { randomUUID } from 'node:crypto';

export const CURRENCIES = ['USD', 'EUR', 'COP'] as const;
export type Currency = (typeof CURRENCIES)[number];

// Vigencia maxima de una cotizacion (R2): nunca puede superar 60 segundos.
export const MAX_QUOTE_TTL_MS = 60_000;

// Tope de monto: evita desbordes al convertir (1e12 * 4000 < Number.MAX_SAFE_INTEGER).
export const MAX_AMOUNT = 1_000_000_000_000;

// Escala de las tasas: 1_000_000 equivale a 1.0.
const RATE_SCALE = 1_000_000n;

export interface Wallet {
  id: string;
  currency: Currency;
  balance: number;
}

// Tasa por par de monedas, en millonesimas: rates[origen][destino].
export type RateTable = Record<Currency, Record<Currency, bigint>>;

export type ErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'QUOTE_EXPIRED'
  | 'SAME_WALLET'
  | 'WALLET_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'TRANSFER_FAILED';

export interface RuleError {
  code: ErrorCode;
  message: string;
  suggestion: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: RuleError };

export interface JournalEntry {
  account: string;
  currency: Currency;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;
}

export interface QuoteView {
  quoteId: string;
  rate: number;
  destinationAmount: number;
  expiresAt: string;
}

export interface TransferResult {
  transferId: string;
  originId: string;
  destinationId: string;
  originCurrency: Currency;
  destinationCurrency: Currency;
  originAmount: number;
  destinationAmount: number;
  rate: number;
  entries: JournalEntry[];
  originBalance: number;
  destinationBalance: number;
}

export interface WalletView {
  id: string;
  currency: Currency;
  balance: number;
}

export interface EngineOptions {
  wallets: Map<string, Wallet>;
  rates: RateTable;
  // Reloj inyectado: milisegundos desde epoch. Las reglas nunca leen la hora solas.
  now: () => number;
  newId?: () => string;
  quoteTtlMs?: number;
  // Paso de credito inyectable. Los tests lo usan para simular un fallo (R3).
  creditWallet?: (wallet: Wallet, amount: number) => void;
}

export interface QuoteInput {
  origin: Currency;
  destination: Currency;
  amount: number;
}

export interface TransferInput {
  originId: string;
  destinationId: string;
  quoteId: string;
  idempotencyKey: string;
}

export interface Engine {
  getWallet(id: string): Result<WalletView>;
  listWalletIds(): string[];
  quote(input: QuoteInput): Result<QuoteView>;
  transfer(input: TransferInput): Result<TransferResult>;
  journal(): readonly JournalEntry[];
}

// Cuenta puente de cambio (FX clearing) de una moneda (R4).
export function clearingAccount(currency: Currency): string {
  return `FX_CLEARING_${currency}`;
}

// Monto destino = monto * tasa / 1_000_000, con BigInt.
// Regla de redondeo: hacia abajo (truncamiento). El redondeo nunca crea dinero.
export function convertAmount(amount: number, rateMicros: bigint): number {
  return Number((BigInt(amount) * rateMicros) / RATE_SCALE);
}

// Suma por moneda: debitos positivos, creditos negativos. R4 exige 0 en cada una.
export function sumByCurrency(entries: readonly JournalEntry[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const entry of entries) {
    const signed = entry.direction === 'DEBIT' ? entry.amount : -entry.amount;
    sums[entry.currency] = (sums[entry.currency] ?? 0) + signed;
  }
  return sums;
}

function isValidAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_AMOUNT;
}

function fail<T>(code: ErrorCode, message: string, suggestion: string): Result<T> {
  return { ok: false, error: { code, message, suggestion } };
}

interface StoredQuote {
  id: string;
  origin: Currency;
  destination: Currency;
  amount: number;
  rateMicros: bigint;
  destinationAmount: number;
  createdAt: number;
}

interface StoredTransfer {
  fingerprint: string;
  result: TransferResult;
}

export function createEngine(options: EngineOptions): Engine {
  const { wallets, rates, now } = options;
  const newId = options.newId ?? randomUUID;
  const quoteTtlMs = options.quoteTtlMs ?? MAX_QUOTE_TTL_MS;
  const creditWallet =
    options.creditWallet ??
    ((wallet: Wallet, amount: number): void => {
      wallet.balance += amount;
    });

  // La vigencia solo se puede acortar, nunca superar 60 s (R2).
  if (!Number.isSafeInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > MAX_QUOTE_TTL_MS) {
    throw new Error(`quoteTtlMs debe ser un entero entre 1 y ${MAX_QUOTE_TTL_MS}`);
  }

  const quotes = new Map<string, StoredQuote>();
  const transfersByKey = new Map<string, StoredTransfer>();
  const entriesLog: JournalEntry[] = [];

  function validIds(): string {
    return [...wallets.keys()].join(', ');
  }

  function walletNotFound<T>(id: string): Result<T> {
    return fail(
      'WALLET_NOT_FOUND',
      `La billetera "${id}" no existe. Ids válidos: ${validIds()}.`,
      'Usa uno de los ids válidos listados.',
    );
  }

  function quoteExpired<T>(detail: string): Result<T> {
    return fail('QUOTE_EXPIRED', detail, 'Llama a cotizar de nuevo y usa el nuevo cotizacionId.');
  }

  return {
    listWalletIds(): string[] {
      return [...wallets.keys()];
    },

    getWallet(id: string): Result<WalletView> {
      const wallet = wallets.get(id);
      if (wallet === undefined) {
        return walletNotFound(id);
      }
      return { ok: true, value: { id: wallet.id, currency: wallet.currency, balance: wallet.balance } };
    },

    quote(input: QuoteInput): Result<QuoteView> {
      if (!isValidAmount(input.amount)) {
        return fail(
          'INVALID_AMOUNT',
          `El monto debe ser un entero positivo en unidades mínimas (máximo ${MAX_AMOUNT}).`,
          'Envía un entero mayor que 0, expresado en centavos de la moneda de origen.',
        );
      }
      const rateMicros = rates[input.origin][input.destination];
      const destinationAmount = convertAmount(input.amount, rateMicros);
      if (destinationAmount < 1) {
        // Con redondeo hacia abajo el destino recibiria 0 y el origen perderia dinero.
        return fail(
          'INVALID_AMOUNT',
          'El monto es demasiado pequeño: convertido al destino sería 0.',
          'Aumenta el monto de origen.',
        );
      }
      const quote: StoredQuote = {
        id: newId(),
        origin: input.origin,
        destination: input.destination,
        amount: input.amount,
        rateMicros,
        destinationAmount,
        createdAt: now(),
      };
      quotes.set(quote.id, quote);
      return {
        ok: true,
        value: {
          quoteId: quote.id,
          rate: Number(rateMicros) / Number(RATE_SCALE),
          destinationAmount,
          expiresAt: new Date(quote.createdAt + quoteTtlMs).toISOString(),
        },
      };
    },

    transfer(input: TransferInput): Result<TransferResult> {
      // R5: la llave se consulta primero, antes de cualquier otra validacion.
      // Asi un reintento legitimo no falla porque la cotizacion ya venciera.
      const fingerprint = `${input.originId}|${input.destinationId}|${input.quoteId}`;
      const previous = transfersByKey.get(input.idempotencyKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          return fail(
            'IDEMPOTENCY_KEY_REUSED',
            'La idempotencyKey ya se usó con datos distintos.',
            'Genera una idempotencyKey nueva para una operación nueva.',
          );
        }
        return { ok: true, value: structuredClone(previous.result) };
      }

      const origin = wallets.get(input.originId);
      if (origin === undefined) {
        return walletNotFound(input.originId);
      }
      const destination = wallets.get(input.destinationId);
      if (destination === undefined) {
        return walletNotFound(input.destinationId);
      }
      if (origin.id === destination.id) {
        return fail(
          'SAME_WALLET',
          'La billetera origen y la destino son la misma.',
          'Elige una billetera destino distinta.',
        );
      }

      // R2: la cotizacion debe existir y tener menos de 60 s.
      const quote = quotes.get(input.quoteId);
      if (quote === undefined) {
        return quoteExpired('La cotización no existe o ya fue usada.');
      }
      if (now() - quote.createdAt >= quoteTtlMs) {
        quotes.delete(quote.id);
        return quoteExpired('La cotización venció (más de 60 segundos).');
      }

      if (origin.currency !== quote.origin || destination.currency !== quote.destination) {
        return fail(
          'CURRENCY_MISMATCH',
          `La cotización es ${quote.origin} -> ${quote.destination}, pero las billeteras son ` +
            `${origin.id} (${origin.currency}) y ${destination.id} (${destination.currency}).`,
          'Cotiza con las monedas reales de las billeteras.',
        );
      }

      // R1: saldo nunca negativo. Saldo igual al monto esta permitido.
      if (origin.balance < quote.amount) {
        return fail(
          'INSUFFICIENT_FUNDS',
          `Saldo disponible: ${origin.balance}; monto requerido: ${quote.amount}.`,
          'Reduce el monto o usa otra billetera de origen.',
        );
      }

      // R4: asientos balanceados POR MONEDA con cuentas puente de cambio.
      // Moneda origen: debito a la billetera origen / credito a FX_CLEARING_<origen>.
      // Moneda destino: debito a FX_CLEARING_<destino> / credito a la billetera destino.
      const entries: JournalEntry[] = [
        { account: origin.id, currency: quote.origin, direction: 'DEBIT', amount: quote.amount },
        { account: clearingAccount(quote.origin), currency: quote.origin, direction: 'CREDIT', amount: quote.amount },
        {
          account: clearingAccount(quote.destination),
          currency: quote.destination,
          direction: 'DEBIT',
          amount: quote.destinationAmount,
        },
        { account: destination.id, currency: quote.destination, direction: 'CREDIT', amount: quote.destinationAmount },
      ];
      const sums = sumByCurrency(entries);
      if (Object.values(sums).some((sum) => sum !== 0)) {
        return fail('TRANSFER_FAILED', 'Los asientos no suman cero; no se aplicó nada.', 'Reintenta con la misma idempotencyKey.');
      }

      // R3: debito y credito atomicos. Si el credito falla se restauran ambos saldos.
      const originBefore = origin.balance;
      const destinationBefore = destination.balance;
      try {
        origin.balance -= quote.amount;
        creditWallet(destination, quote.destinationAmount);
      } catch (error) {
        origin.balance = originBefore;
        destination.balance = destinationBefore;
        console.error('Fallo al acreditar; débito revertido:', error);
        return fail(
          'TRANSFER_FAILED',
          'Falló el crédito y el débito se revirtió. Los saldos no cambiaron.',
          'Reintenta con la misma idempotencyKey.',
        );
      }

      const result: TransferResult = {
        transferId: newId(),
        originId: origin.id,
        destinationId: destination.id,
        originCurrency: quote.origin,
        destinationCurrency: quote.destination,
        originAmount: quote.amount,
        destinationAmount: quote.destinationAmount,
        rate: Number(quote.rateMicros) / Number(RATE_SCALE),
        entries,
        originBalance: origin.balance,
        destinationBalance: destination.balance,
      };
      entriesLog.push(...entries);
      transfersByKey.set(input.idempotencyKey, { fingerprint, result: structuredClone(result) });
      quotes.delete(quote.id);
      return { ok: true, value: result };
    },

    journal(): readonly JournalEntry[] {
      return entriesLog.map((entry) => ({ ...entry }));
    },
  };
}

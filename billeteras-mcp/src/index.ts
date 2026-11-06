// Servidor MCP (stdio) de billeteras. Solo traduce entre MCP y las reglas de reglas.ts.
// IMPORTANTE: en stdio, stdout es el canal del protocolo. Nunca escribir con
// console.log ni process.stdout; los logs van a console.error (stderr).

import { readFile } from 'node:fs/promises';

import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { RATES_MICROS, createSeedWallets } from './datos.js';
import {
  CURRENCIES,
  MAX_QUOTE_TTL_MS,
  createEngine,
  type JournalEntry,
  type RuleError,
  type TransferResult,
} from './reglas.js';

// Ruta de la spec resuelta relativa a ESTE archivo (src/ o build/), no al cwd.
const SPEC_TRANSFER_URL = new URL('../../.specs/SPEC-TRANSFER.md', import.meta.url);

// Solo para pruebas: permite ACORTAR la vigencia de las cotizaciones (nunca superar 60 s).
// En produccion no se define y la vigencia es 60 s (R2).
function readQuoteTtlMs(): number | undefined {
  const raw = process.env['BILLETERAS_QUOTE_TTL_MS'];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_QUOTE_TTL_MS) {
    throw new Error(`BILLETERAS_QUOTE_TTL_MS debe ser un entero entre 1 y ${MAX_QUOTE_TTL_MS}`);
  }
  console.error(`[billeteras-mcp] AVISO: vigencia de cotizaciones acortada a ${value} ms (solo pruebas)`);
  return value;
}

// El estado vive en el servidor (no en la conexion): todas las conexiones comparten el motor.
const quoteTtlMs = readQuoteTtlMs();
const engine = createEngine({
  wallets: createSeedWallets(),
  rates: RATES_MICROS,
  now: () => Date.now(),
  ...(quoteTtlMs === undefined ? {} : { quoteTtlMs }),
});

// Resultado de herramienta exitoso: texto JSON compacto (y estructurado si se pide).
function jsonResult(payload: Record<string, unknown>, structured = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(structured ? { structuredContent: payload } : {}),
  };
}

// Error de negocio: isError true y texto "CODIGO: mensaje sugerencia". Nunca se lanza.
function errorResult(error: RuleError) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${error.code}: ${error.message} ${error.suggestion}` }],
  };
}

function mapEntry(entry: JournalEntry) {
  return {
    cuenta: entry.account,
    moneda: entry.currency,
    direccion: entry.direction,
    monto: entry.amount,
  };
}

function mapTransfer(result: TransferResult): Record<string, unknown> {
  return {
    transferenciaId: result.transferId,
    origenId: result.originId,
    destinoId: result.destinationId,
    monedaOrigen: result.originCurrency,
    monedaDestino: result.destinationCurrency,
    montoOrigen: result.originAmount,
    montoDestino: result.destinationAmount,
    tasa: result.rate,
    asientos: result.entries.map(mapEntry),
    saldoOrigen: result.originBalance,
    saldoDestino: result.destinationBalance,
  };
}

function auditPromptText(transferenciaId: string): string {
  return [
    `Audita la transferencia "${transferenciaId}" contra las invariantes del sistema.`,
    '',
    'Pasos:',
    '1. Lee primero el recurso specs://SPEC-TRANSFER para conocer las reglas.',
    '2. Reúne los datos de la transferencia: usa el resultado de crear_transferencia que ya tengas en la conversación.',
    '   Si no lo tienes, pídele al usuario el origenId, destinoId, cotizacionId e idempotencyKey y repite',
    '   crear_transferencia con la MISMA idempotencyKey: devuelve el mismo resultado sin mover dinero otra vez.',
    '3. Lee billetera://{id} de la billetera origen y de la destino para ver los saldos actuales.',
    '4. Verifica cada invariante y responde con un veredicto por línea (CUMPLE / NO CUMPLE / NO VERIFICABLE):',
    '   - R1: ninguna billetera tiene saldo negativo.',
    '   - R2: la transferencia usó una cotización de menos de 60 segundos.',
    '   - R3: el débito y el crédito se aplicaron juntos (los saldos son coherentes con los montos).',
    '   - R4: los asientos suman cero en cada moneda por separado (débitos menos créditos = 0 en USD, EUR y COP).',
    '   - R5: repetir la misma idempotencyKey no genera un segundo débito.',
    '5. Todo monto está en unidades mínimas (centavos), como enteros. No uses decimales.',
    '6. Si algo NO CUMPLE, explica cuál regla se rompe y con qué dato. No inventes datos que no hayas leído.',
  ].join('\n');
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'billeteras-mcp', version: '1.0.0' });

  server.registerTool(
    'consultar_saldo',
    {
      title: 'Consultar saldo',
      description:
        'Devuelve el saldo de una billetera en unidades mínimas de su moneda (centavos). ' +
        'Si el id no existe, responde con error y la lista de ids válidos.',
      inputSchema: z.object({
        billeteraId: z.string().describe('Id de la billetera, por ejemplo W-001'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ billeteraId }) => {
      const result = engine.getWallet(billeteraId);
      if (!result.ok) {
        return errorResult(result.error);
      }
      const wallet = result.value;
      return jsonResult({ billeteraId: wallet.id, moneda: wallet.currency, saldo: wallet.balance });
    },
  );

  server.registerTool(
    'cotizar',
    {
      title: 'Cotizar transferencia',
      description:
        'Calcula cuánto recibiría el destino y congela la tasa. La cotización es válida 60 segundos. ' +
        'Pasa el cotizacionId a crear_transferencia. No mueve dinero.',
      inputSchema: z.object({
        origen: z.enum(CURRENCIES).describe('Moneda de origen (ISO 4217)'),
        destino: z.enum(CURRENCIES).describe('Moneda de destino (ISO 4217)'),
        monto: z.number().describe('Monto entero positivo en centavos de la moneda de origen'),
      }),
      outputSchema: z.object({
        cotizacionId: z.string(),
        tasa: z.number(),
        montoDestino: z.number().int(),
        expiraEn: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ origen, destino, monto }) => {
      const result = engine.quote({ origin: origen, destination: destino, amount: monto });
      if (!result.ok) {
        return errorResult(result.error);
      }
      const quote = result.value;
      return jsonResult(
        {
          cotizacionId: quote.quoteId,
          tasa: quote.rate,
          montoDestino: quote.destinationAmount,
          expiraEn: quote.expiresAt,
        },
        true,
      );
    },
  );

  server.registerTool(
    'crear_transferencia',
    {
      title: 'Crear transferencia',
      description:
        'Mueve dinero entre dos billeteras usando una cotización vigente (menos de 60 segundos). ' +
        'Llama primero a cotizar. Si hay un fallo de red, reintenta con la misma idempotencyKey: ' +
        'nunca se cobra dos veces.',
      inputSchema: z.object({
        origenId: z.string().describe('Id de la billetera de origen, por ejemplo W-001'),
        destinoId: z.string().describe('Id de la billetera de destino, por ejemplo W-002'),
        cotizacionId: z.string().describe('Id devuelto por cotizar'),
        idempotencyKey: z.uuid().describe('UUID único por intento; repetirlo no duplica la transferencia'),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ origenId, destinoId, cotizacionId, idempotencyKey }) => {
      const result = engine.transfer({
        originId: origenId,
        destinationId: destinoId,
        quoteId: cotizacionId,
        idempotencyKey,
      });
      if (!result.ok) {
        return errorResult(result.error);
      }
      return jsonResult(mapTransfer(result.value));
    },
  );

  server.registerResource(
    'spec-transfer',
    'specs://SPEC-TRANSFER',
    {
      title: 'Especificación de transferencias',
      description: 'SPEC-TRANSFER: reglas de negocio de las transferencias multidivisa.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const text = await readFile(SPEC_TRANSFER_URL, 'utf-8');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  server.registerResource(
    'billetera',
    new ResourceTemplate('billetera://{id}', {
      list: () => ({
        resources: engine.listWalletIds().map((id) => ({
          uri: `billetera://${id}`,
          name: `Billetera ${id}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Estado de una billetera',
      description: 'Estado de una billetera en JSON: id, moneda y saldo en unidades mínimas.',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const rawId = variables['id'];
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      const result = engine.getWallet(id ?? '');
      if (!result.ok) {
        // Un recurso inexistente es un error estandar del protocolo (no una regla de negocio).
        throw new ResourceNotFoundError(uri.href, `${result.error.code}: ${result.error.message}`);
      }
      const wallet = result.value;
      const body = { id: wallet.id, moneda: wallet.currency, saldo: wallet.balance };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] };
    },
  );

  server.registerPrompt(
    'auditar_transferencia',
    {
      title: 'Auditar transferencia',
      description: 'Guía para revisar una transferencia contra las invariantes R1 a R5.',
      argsSchema: z.object({
        transferenciaId: z.string().describe('Id de la transferencia a auditar'),
      }),
    },
    ({ transferenciaId }) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: auditPromptText(transferenciaId) },
        },
      ],
    }),
  );

  return server;
}

// Arranque: una instancia nueva por conexion; el estado compartido esta en `engine`.
serveStdio(() => createServer(), {
  onerror: (error) => console.error('[billeteras-mcp] error:', error),
});
console.error('[billeteras-mcp] servidor listo en stdio');

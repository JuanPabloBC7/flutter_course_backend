// Los 5 escenarios de aceptacion de SPEC-MCP contra el servidor REAL por stdio.
// Uso: npm run build && npm run escenarios   (usa build/index.js)
// Cada escenario levanta su propio proceso para no depender de estado previo.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { StdioClient, startClient, type ServerOptions } from '../tests/helpers/stdio-client.js';

type Entry = ServerOptions['entry'];
type Log = (line: string) => void;

interface ResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

// Lee un recurso y devuelve su primer contenido.
async function readResource(client: StdioClient, uri: string): Promise<ResourceContents> {
  const response = await client.request('resources/read', { uri });
  assert.equal(response.error, undefined, `error leyendo ${uri}: ${JSON.stringify(response.error)}`);
  const contents = response.result?.['contents'] as ResourceContents[] | undefined;
  assert.ok(contents && contents[0], `sin contenido en ${uri}`);
  return contents[0];
}

async function balanceOf(client: StdioClient, walletId: string): Promise<number> {
  const outcome = await client.callTool('consultar_saldo', { billeteraId: walletId });
  assert.equal(outcome.isError, false, outcome.text);
  return outcome.json?.['saldo'] as number;
}

// Suma debitos menos creditos por moneda a partir de la salida de crear_transferencia.
function sumEntries(entries: Array<{ moneda: string; direccion: string; monto: number }>): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const entry of entries) {
    sums[entry.moneda] = (sums[entry.moneda] ?? 0) + (entry.direccion === 'DEBIT' ? entry.monto : -entry.monto);
  }
  return sums;
}

// Al cerrar: el servidor termina solo (exit 0) y stdout solo tuvo JSON-RPC.
async function finish(client: StdioClient, log: Log): Promise<void> {
  const code = await client.close();
  assert.equal(code, 0, 'el servidor debe terminar con codigo 0 al cerrar stdin');
  for (const line of client.stdoutLines) {
    const message = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(message.jsonrpc, '2.0', `stdout con algo que no es JSON-RPC: ${line}`);
  }
  log(`  [ok] stdout: ${client.stdoutLines.length} lineas, todas JSON-RPC 2.0; servidor terminó con código ${String(code)}`);
}

export async function scenario1(entry: Entry, log: Log): Promise<void> {
  log('ESCENARIO 1: "Transfiere 100 USD de W-001 a W-002"');
  const client = await startClient({ entry });
  const before = { w1: await balanceOf(client, 'W-001'), w2: await balanceOf(client, 'W-002') };
  log(`  saldos antes: W-001=${before.w1} (USD), W-002=${before.w2} (EUR)`);

  const quote = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 10_000 });
  assert.equal(quote.isError, false, quote.text);
  log(`  cotizar -> ${quote.text}`);
  assert.equal(quote.json?.['tasa'], 0.92);
  assert.equal(quote.json?.['montoDestino'], 9_200);

  const transfer = await client.callTool('crear_transferencia', {
    origenId: 'W-001',
    destinoId: 'W-002',
    cotizacionId: quote.json?.['cotizacionId'],
    idempotencyKey: randomUUID(),
  });
  assert.equal(transfer.isError, false, transfer.text);
  log(`  crear_transferencia -> ${transfer.text}`);
  const entries = transfer.json?.['asientos'] as Array<{ cuenta: string; moneda: string; direccion: string; monto: number }>;
  assert.deepEqual(
    entries.map((e) => `${e.direccion} ${e.cuenta} ${e.moneda} ${e.monto}`),
    ['DEBIT W-001 USD 10000', 'CREDIT FX_CLEARING_USD USD 10000', 'DEBIT FX_CLEARING_EUR EUR 9200', 'CREDIT W-002 EUR 9200'],
  );
  assert.deepEqual(sumEntries(entries), { USD: 0, EUR: 0 });

  const after = { w1: await balanceOf(client, 'W-001'), w2: await balanceOf(client, 'W-002') };
  log(`  saldos después: W-001=${after.w1}, W-002=${after.w2}`);
  assert.equal(after.w1, before.w1 - 10_000);
  assert.equal(after.w2, before.w2 + 9_200);
  log('  [ok] W-001 bajó 10000 USD-centavos, W-002 subió 9200 EUR-centavos (tasa 0.92, redondeo hacia abajo); asientos suman 0 en USD y en EUR');
  await finish(client, log);
}

export async function scenario2(entry: Entry, log: Log): Promise<void> {
  log('ESCENARIO 2: "¿Cuánto tiene W-003 y qué reglas aplican?"');
  const client = await startClient({ entry });
  const wallet = await readResource(client, 'billetera://W-003');
  log(`  billetera://W-003 (${wallet.mimeType}) -> ${wallet.text}`);
  assert.equal(wallet.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(wallet.text), { id: 'W-003', moneda: 'COP', saldo: 200_000_000 });

  const spec = await readResource(client, 'specs://SPEC-TRANSFER');
  assert.equal(spec.mimeType, 'text/markdown');
  const rules = spec.text.split('\n').filter((line) => /^- \*\*R\d+\.\*\*/.test(line));
  log(`  specs://SPEC-TRANSFER (${spec.mimeType}) -> ${spec.text.length} caracteres, ${rules.length} reglas (R1..R${rules.length})`);
  for (const rule of rules) {
    log(`    ${rule.slice(0, 90)}`);
  }
  assert.equal(rules.length, 10);
  assert.ok(spec.text.includes('saldo negativo'));
  log('  [ok] saldo de W-003 = 200000000 centavos COP y reglas leídas desde la spec');
  await finish(client, log);
}

export async function scenario3(entry: Entry, log: Log): Promise<void> {
  log('ESCENARIO 3: "Transfiere 10.000 USD de W-001 a W-002" (saldo insuficiente)');
  const client = await startClient({ entry });
  const quote = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 1_000_000 });
  assert.equal(quote.isError, false, quote.text);
  const transfer = await client.callTool('crear_transferencia', {
    origenId: 'W-001',
    destinoId: 'W-002',
    cotizacionId: quote.json?.['cotizacionId'],
    idempotencyKey: randomUUID(),
  });
  log(`  crear_transferencia -> isError=${String(transfer.isError)}: ${transfer.text}`);
  assert.equal(transfer.isError, true);
  assert.ok(transfer.text.startsWith('INSUFFICIENT_FUNDS:'));
  assert.ok(transfer.text.includes('Saldo disponible: 50000; monto requerido: 1000000'));
  assert.equal(await balanceOf(client, 'W-001'), 50_000);
  assert.equal(await balanceOf(client, 'W-002'), 10_000);
  log('  [ok] rechazada con mensaje legible; saldos intactos (W-001=50000, W-002=10000)');
  await finish(client, log);
}

export async function scenario4(entry: Entry, log: Log): Promise<void> {
  log('ESCENARIO 4: "Usa una cotización de hace 2 minutos"');
  log('  Simulación: el servidor arranca con BILLETERAS_QUOTE_TTL_MS=200 (solo pruebas; por defecto 60000) y se esperan 400 ms.');
  const client = await startClient({ entry, env: { BILLETERAS_QUOTE_TTL_MS: '200' } });
  const quote = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 10_000 });
  assert.equal(quote.isError, false, quote.text);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const transfer = await client.callTool('crear_transferencia', {
    origenId: 'W-001',
    destinoId: 'W-002',
    cotizacionId: quote.json?.['cotizacionId'],
    idempotencyKey: randomUUID(),
  });
  log(`  crear_transferencia (cotización vencida) -> isError=${String(transfer.isError)}: ${transfer.text}`);
  assert.equal(transfer.isError, true);
  assert.ok(transfer.text.startsWith('QUOTE_EXPIRED:'));
  assert.ok(transfer.text.includes('cotizar'));
  assert.equal(await balanceOf(client, 'W-001'), 50_000);

  // La sugerencia funciona: cotizar de nuevo y completar antes de que venza.
  const fresh = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 10_000 });
  const retry = await client.callTool('crear_transferencia', {
    origenId: 'W-001',
    destinoId: 'W-002',
    cotizacionId: fresh.json?.['cotizacionId'],
    idempotencyKey: randomUUID(),
  });
  log(`  tras cotizar de nuevo -> isError=${String(retry.isError)}`);
  assert.equal(retry.isError, false, retry.text);
  assert.equal(await balanceOf(client, 'W-001'), 40_000);
  log('  [ok] QUOTE_EXPIRED con sugerencia de cotizar otra vez; sin movimiento de dinero; con cotización nueva funciona');
  await finish(client, log);
}

export async function scenario5(entry: Entry, log: Log): Promise<void> {
  log('ESCENARIO 5: "Repite la última transferencia con la misma key"');
  const client = await startClient({ entry });
  const quote = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 10_000 });
  const args = {
    origenId: 'W-001',
    destinoId: 'W-002',
    cotizacionId: quote.json?.['cotizacionId'],
    idempotencyKey: randomUUID(),
  };
  const first = await client.callTool('crear_transferencia', args);
  const second = await client.callTool('crear_transferencia', args);
  log(`  primera  -> ${first.text}`);
  log(`  segunda  -> ${second.text}`);
  assert.equal(first.isError, false, first.text);
  assert.equal(second.isError, false, second.text);
  assert.equal(second.text, first.text);
  const w1 = await balanceOf(client, 'W-001');
  const w2 = await balanceOf(client, 'W-002');
  log(`  saldos: W-001=${w1}, W-002=${w2}`);
  assert.equal(w1, 40_000);
  assert.equal(w2, 19_200);
  log('  [ok] resultado idéntico y un solo débito (W-001=40000, W-002=19200)');
  await finish(client, log);
}

export async function runAll(entry: Entry, log: Log): Promise<void> {
  const scenarios = [scenario1, scenario2, scenario3, scenario4, scenario5];
  for (const run of scenarios) {
    await run(entry, log);
    log('');
  }
  log('RESULTADO: 5 de 5 escenarios pasaron');
}

// Ejecucion directa: npm run escenarios
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const entry: Entry = process.argv.includes('--src') ? 'src' : 'build';
  console.log(`Servidor bajo prueba: ${entry === 'build' ? 'build/index.js' : 'src/index.ts (tsx)'}`);
  runAll(entry, (line) => console.log(line)).catch((error: unknown) => {
    console.error('FALLÓ un escenario:', error);
    process.exitCode = 1;
  });
}

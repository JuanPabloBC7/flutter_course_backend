// Prueba de que stdout del servidor solo contiene mensajes del protocolo (JSON-RPC)
// y que los logs van a stderr. Uso: npm run build && npm run prueba-stdout

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { startClient } from '../tests/helpers/stdio-client.js';

const client = await startClient({ entry: 'build' });

// Sesion con exito y con errores de negocio para provocar el mayor trafico y logs posibles.
const quote = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 10_000 });
await client.callTool('crear_transferencia', {
  origenId: 'W-001',
  destinoId: 'W-002',
  cotizacionId: quote.json?.['cotizacionId'],
  idempotencyKey: randomUUID(),
});
await client.callTool('consultar_saldo', { billeteraId: 'W-999' });
await client.callTool('consultar_saldo', { billeteraId: 123 });
await client.request('resources/read', { uri: 'billetera://W-999' });
const code = await client.close();

console.log(`Líneas escritas por el servidor en STDOUT: ${client.stdoutLines.length}`);
let invalid = 0;
for (const [index, line] of client.stdoutLines.entries()) {
  let kind = 'NO ES JSON-RPC';
  try {
    const message = JSON.parse(line) as { jsonrpc?: string; id?: number; method?: string; result?: unknown; error?: unknown };
    if (message.jsonrpc === '2.0') {
      kind = message.error !== undefined ? 'respuesta con error' : message.result !== undefined ? 'respuesta' : 'notificación/petición';
    }
  } catch {
    // se queda como NO ES JSON-RPC
  }
  if (kind === 'NO ES JSON-RPC') {
    invalid += 1;
  }
  console.log(`  [${index + 1}] ${kind}: ${line.slice(0, 110)}${line.length > 110 ? '…' : ''}`);
}
console.log(`Líneas de STDOUT que NO son JSON-RPC 2.0: ${invalid}`);

const stderrText = client.stderrChunks.join('');
console.log('');
console.log('Contenido de STDERR (logs, nunca protocolo):');
console.log(stderrText.split('\n').filter((l) => l.length > 0).map((l) => `  | ${l}`).join('\n'));
console.log(`Código de salida del servidor tras cerrar stdin: ${String(code)}`);

assert.equal(invalid, 0, 'stdout contiene algo que no es protocolo');
assert.equal(code, 0);
console.log('');
console.log('RESULTADO: stdout contiene únicamente mensajes JSON-RPC del protocolo.');

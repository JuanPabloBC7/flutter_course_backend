// Contrato MCP del servidor real: primitivas expuestas, anotaciones y validacion de tipos.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { StdioClient, startClient } from './helpers/stdio-client.js';

interface ToolInfo {
  name: string;
  annotations?: Record<string, unknown>;
  outputSchema?: { required?: string[] };
}

describe('contrato MCP del servidor', () => {
  let client: StdioClient;

  before(async () => {
    client = await startClient({ entry: 'src' });
  });

  after(async () => {
    await client.close();
  });

  it('expone exactamente las 3 herramientas con sus anotaciones', async () => {
    const response = await client.request('tools/list');
    const tools = (response.result?.['tools'] ?? []) as ToolInfo[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ['consultar_saldo', 'cotizar', 'crear_transferencia']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName['consultar_saldo']?.annotations?.['readOnlyHint'], true);
    assert.equal(byName['cotizar']?.annotations?.['readOnlyHint'], true);
    assert.equal(byName['crear_transferencia']?.annotations?.['readOnlyHint'], false);
    assert.equal(byName['crear_transferencia']?.annotations?.['idempotentHint'], true);
    assert.deepEqual(byName['cotizar']?.outputSchema?.required?.sort(), [
      'cotizacionId',
      'expiraEn',
      'montoDestino',
      'tasa',
    ]);
  });

  it('expone el recurso, la plantilla y el prompt con nombres exactos', async () => {
    const resources = await client.request('resources/list');
    const uris = ((resources.result?.['resources'] ?? []) as Array<{ uri: string }>).map((r) => r.uri);
    assert.ok(uris.includes('specs://SPEC-TRANSFER'));
    const templates = await client.request('resources/templates/list');
    const templateUris = ((templates.result?.['resourceTemplates'] ?? []) as Array<{ uriTemplate: string }>).map(
      (t) => t.uriTemplate,
    );
    assert.deepEqual(templateUris, ['billetera://{id}']);
    const prompts = await client.request('prompts/list');
    const names = ((prompts.result?.['prompts'] ?? []) as Array<{ name: string }>).map((p) => p.name);
    assert.deepEqual(names, ['auditar_transferencia']);
  });

  it('el prompt manda leer specs://SPEC-TRANSFER primero', async () => {
    const response = await client.request('prompts/get', {
      name: 'auditar_transferencia',
      arguments: { transferenciaId: 'T-123' },
    });
    const messages = (response.result?.['messages'] ?? []) as Array<{ content: { text: string } }>;
    const text = messages[0]?.content.text ?? '';
    assert.ok(text.includes('T-123'));
    assert.ok(text.indexOf('specs://SPEC-TRANSFER') < text.indexOf('R1'));
  });

  it('consultar_saldo con id inexistente devuelve isError con los ids validos', async () => {
    const outcome = await client.callTool('consultar_saldo', { billeteraId: 'W-999' });
    assert.equal(outcome.isError, true);
    assert.ok(outcome.text.startsWith('WALLET_NOT_FOUND:'));
    assert.ok(outcome.text.includes('W-001, W-002, W-003'));
  });

  it('un argumento con tipo equivocado se rechaza antes de ejecutar las reglas', async () => {
    const outcome = await client.callTool('consultar_saldo', { billeteraId: 123 });
    assert.equal(outcome.isError, true);
    assert.ok(outcome.text.includes('expected string'));
    assert.ok(!outcome.text.includes('WALLET_NOT_FOUND'));
  });

  it('idempotencyKey que no es uuid se rechaza por esquema', async () => {
    const outcome = await client.callTool('crear_transferencia', {
      origenId: 'W-001',
      destinoId: 'W-002',
      cotizacionId: 'x',
      idempotencyKey: 'no-es-uuid',
    });
    assert.equal(outcome.isError, true);
    assert.ok(!outcome.text.startsWith('QUOTE_EXPIRED'));
  });

  it('monto cero devuelve INVALID_AMOUNT como resultado, no como error de protocolo', async () => {
    const outcome = await client.callTool('cotizar', { origen: 'USD', destino: 'EUR', monto: 0 });
    assert.equal(outcome.protocolError, undefined);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.text.startsWith('INVALID_AMOUNT:'));
  });

  it('leer una billetera inexistente es un error estandar de recurso no encontrado', async () => {
    const response = await client.request('resources/read', { uri: 'billetera://W-999' });
    assert.ok(response.error !== undefined);
    assert.ok(response.error.message.includes('W-001, W-002, W-003'));
  });
});

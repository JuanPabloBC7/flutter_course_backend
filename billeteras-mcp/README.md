# billeteras-mcp

Servidor MCP (transporte stdio) que deja a un agente de IA consultar saldos,
cotizar y ejecutar transferencias entre billeteras en USD, EUR y COP, sin poder
violar las reglas: saldo nunca negativo, cotización de máximo 60 s, débito y
crédito atómicos, asientos que suman cero e idempotencia. Las reglas viven en el
código del servidor (`src/reglas.ts`), no en el prompt.

La especificación está en `../.specs/SPEC-MCP.md`. Es el Bloque 06 del curso
"Servidores MCP: del estándar a tu propio servidor". El estado es en memoria: al
reiniciar el servidor, los saldos vuelven a los valores semilla.

## Primitivas

| Tipo | Nombre | Para qué |
| --- | --- | --- |
| Tool | `consultar_saldo` | Saldo de una billetera (solo lectura) |
| Tool | `cotizar` | Congela una tasa por 60 s (solo lectura) |
| Tool | `crear_transferencia` | Mueve dinero con una cotización vigente (idempotente) |
| Resource | `specs://SPEC-TRANSFER` | La spec de transferencias (`text/markdown`) |
| Resource template | `billetera://{id}` | Estado de una billetera (`application/json`) |
| Prompt | `auditar_transferencia` | Guía de auditoría contra R1 a R5 |

Billeteras semilla (en centavos): W-001 USD 50 000, W-002 EUR 10 000, W-003 COP 200 000 000.

## Requisitos, instalación y build

Node 20 o superior.

```bash
cd billeteras-mcp
npm install
npm run build        # compila a build/
npm run typecheck    # tipos de src, tests y scripts
```

## Tests

```bash
npm test             # runner nativo de Node (node:test), sin framework
npm run escenarios   # los 5 escenarios de aceptación contra build/index.js
```

Los tests de reglas (R1 a R5) no usan MCP. Los de servidor y escenarios levantan
el servidor real por stdio. `npm run evidencia` regenera `evidencia/` con salidas reales.

## Probar con el Inspector (solo modo CLI)

Siempre con `--cli` y la versión fijada. Desde `billeteras-mcp/`, tras `npm run build`:

```bash
npx -y @modelcontextprotocol/inspector@2.14.0 --cli node build/index.js --method tools/list
npx -y @modelcontextprotocol/inspector@2.14.0 --cli node build/index.js --method resources/list
npx -y @modelcontextprotocol/inspector@2.14.0 --cli node build/index.js --method prompts/list
npx -y @modelcontextprotocol/inspector@2.14.0 --cli node build/index.js \
  --method tools/call --tool-name consultar_saldo --tool-arg billeteraId=W-001
```

Cada invocación del Inspector arranca un servidor nuevo, así que no conserva
cotizaciones entre llamadas. Para flujos con estado usa `npm run escenarios`.
El Inspector 2.14.0 declara Node 22 o superior; en Node 20 npm muestra avisos
`EBADENGINE` pero las pruebas de `evidencia/` funcionaron igual.

## Conectar a un host

Primero `npm run build`. En todos los casos el comando es `node build/index.js`.

Claude Code (desde la raíz de `billeteras-mcp/`):

```bash
claude mcp add billeteras --scope project -- node build/index.js
```

Claude Desktop (`claude_desktop_config.json`). La ruta debe ser ABSOLUTA:

```json
{
  "mcpServers": {
    "billeteras": {
      "command": "node",
      "args": ["/RUTA/ABSOLUTA/A/billeteras-mcp/build/index.js"]
    }
  }
}
```

Kiro: puedes registrar el servidor en la configuración MCP del workspace
(`.kiro/settings/mcp.json`) con el mismo `command` y `args` de arriba. Este
proyecto no incluye ese archivo ni ningún otro de configuración de host; crea el
que necesites.

La sesión con un agente real queda pendiente: ver `evidencia/PENDIENTE-sesion-agente.md`.

## Reglas y errores

| Regla | Qué garantiza | Error |
| --- | --- | --- |
| R1 | Saldo nunca negativo | `INSUFFICIENT_FUNDS` |
| R2 | Cotización existente y de menos de 60 s | `QUOTE_EXPIRED` |
| R3 | Débito y crédito atómicos | `TRANSFER_FAILED` |
| R4 | Asientos que suman cero por moneda (cuentas `FX_CLEARING_*`) | n/a |
| R5 | Idempotencia por `idempotencyKey` | `IDEMPOTENCY_KEY_REUSED` |

Otros códigos: `SAME_WALLET`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `INVALID_AMOUNT`.
Los errores de negocio llegan como resultado con `isError: true`, nunca como
excepción. El dinero son enteros en unidad mínima; el monto destino se redondea
hacia abajo con aritmética `BigInt`.

## Variable solo para pruebas

`BILLETERAS_QUOTE_TTL_MS` acorta la vigencia de las cotizaciones (entero de 1 a 60000).
Sirve para simular una cotización vieja sin esperar. No la definas en uso normal.

## Importante: stdout

En stdio, stdout es el canal del protocolo. El servidor no escribe nada ahí salvo
mensajes MCP; sus logs van a stderr (`console.error`).

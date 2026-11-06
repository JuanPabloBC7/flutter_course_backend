# PENDIENTE: sesión con un agente real

**Estado: pendiente del usuario.** Esta parte NO está hecha ni simulada.

No hay aquí ninguna transcripción de un agente. Una transcripción solo existe si
tú conectas el servidor a un agente (Claude Code, Claude Desktop o Kiro) y pegas
los prompts de abajo. Lo que sí está probado de forma automática y real es el
servidor por stdio: ver `f-escenarios.txt` (los mismos 5 casos, ejecutados por un
cliente JSON-RPC) y `e-tests.txt`.

## Antes de empezar

1. `cd billeteras-mcp && npm install && npm run build`
2. Conecta el servidor al agente (ver README.md, sección "Conectar a un host").
3. Abre una conversación nueva. Cada reinicio del servidor devuelve los saldos a
   los valores semilla: W-001 USD 50 000, W-002 EUR 10 000, W-003 COP 200 000 000
   (en centavos).
4. Haz los prompts en orden, en la misma sesión (el 5 depende del 1).

## Los 5 prompts y el comportamiento esperado

### 1. Transferencia exitosa

Prompt: `Transfiere 100 USD de W-001 a W-002`

Esperado:
- El agente llama a `cotizar` con origen USD, destino EUR y monto 10000.
- Luego llama a `crear_transferencia` con el `cotizacionId` recibido y una
  `idempotencyKey` uuid.
- W-001 queda en 40000 y W-002 en 19200 (tasa 0.92, redondeo hacia abajo).
- Los asientos suman cero en USD y en EUR.
- Anota la `idempotencyKey` que usó (la necesitas para el prompt 5).

### 2. Saldo y reglas

Prompt: `¿Cuánto tiene W-003 y qué reglas aplican?`

Esperado:
- Lee `billetera://W-003` (o llama a `consultar_saldo`): 200000000 centavos COP.
- Lee `specs://SPEC-TRANSFER` y resume las reglas (saldo no negativo, tasa de 60 s,
  atomicidad, partida doble, idempotencia).

### 3. Saldo insuficiente

Prompt: `Transfiere 10.000 USD de W-001 a W-002`

Esperado:
- Cotiza 1000000 centavos y llama a `crear_transferencia`.
- El servidor responde `INSUFFICIENT_FUNDS: Saldo disponible: X; monto requerido: 1000000`.
  (X es 40000 si ya hiciste el prompt 1, o 50000 si reiniciaste el servidor.)
- El agente explica el error en lenguaje claro y no insiste igual. Ningún saldo cambia.

### 4. Cotización vencida

Prompt: `Usa una cotización de hace 2 minutos`

Esperado:
- Si el agente reutiliza un `cotizacionId` viejo (de más de 60 s), el servidor
  responde `QUOTE_EXPIRED` y sugiere llamar a `cotizar` de nuevo.
- Un agente bien guiado cotiza otra vez en lugar de forzar la operación.
- Para que realmente pasen 2 minutos, cotiza primero (por ejemplo "cotiza 50 USD a EUR"),
  espera 2 minutos y luego pide usar esa cotización. Si no esperas, el agente
  obtendrá una cotización vigente y la transferencia será válida: eso es correcto,
  no es un fallo.

### 5. Reintento con la misma llave

Prompt: `Repite la última transferencia con la misma key`

Esperado:
- El agente llama a `crear_transferencia` con los mismos argumentos y la MISMA
  `idempotencyKey` del prompt 1.
- El resultado es idéntico al de la primera vez (mismo `transferenciaId`).
- Los saldos no cambian: no hay un segundo débito (W-001 sigue en 40000).
- Si el agente genera una llave nueva, no estás probando R5: pídele explícitamente
  que reutilice la anterior.

## Qué guardar cuando lo hagas

Pega aquí abajo la transcripción real (o capturas) de cada prompt, con la fecha,
el host usado (Claude Code, Claude Desktop o Kiro) y el modelo.

### Registro de la sesión (rellenar)

- Fecha:
- Host y versión:
- Modelo:
- Prompt 1:
- Prompt 2:
- Prompt 3:
- Prompt 4:
- Prompt 5:

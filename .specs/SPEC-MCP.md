# Feature: Servidor MCP de billeteras (SPEC-MCP)

> Taller del Bloque 06, "Servidores MCP: del estándar a tu propio servidor".
> Esta spec describe *qué* expone el servidor y *qué reglas* cumple. No contiene
> código. Hereda las invariantes de `CONSTITUTION.md` y de `SPEC-TRANSFER.md`.

## 1. Objetivo

Exponer por MCP (transporte stdio) un servidor que permita a un agente de IA
consultar saldos, cotizar y ejecutar transferencias multidivisa (USD, EUR, COP)
entre billeteras **sin poder violar las reglas de negocio**.

Principio rector: **las reglas viven en el código del servidor, no en el prompt
del agente**. El agente puede equivocarse, insistir o ser engañado; el servidor
rechaza igualmente toda operación que rompa una invariante.

Invariantes heredadas de la constitución: saldo nunca negativo, tasa congelada
máximo 60 s, débito y crédito atómicos, asientos que suman cero, dinero en
enteros de unidad mínima, monedas ISO 4217, sin flotantes y tests primero.

## 2. Primitivas expuestas (exactamente estas)

Los nombres de protocolo son exactos. Las descripciones son lo que ve el modelo.

| Tipo | Nombre de protocolo | Entrada | Anotaciones | Descripción para el modelo |
| --- | --- | --- | --- | --- |
| Tool | `consultar_saldo` | `billeteraId` (string) | solo lectura | Devuelve el saldo de una billetera en unidades mínimas de su moneda (centavos). Si el id no existe, responde con error y la lista de ids válidos. |
| Tool | `cotizar` | `origen` y `destino` (USD, EUR o COP), `monto` (entero positivo en centavos de la moneda de origen) | solo lectura | Calcula cuánto recibiría el destino y congela la tasa. La cotización es válida 60 segundos. Devuelve `cotizacionId`, `tasa`, `montoDestino` y `expiraEn`. Pasa el `cotizacionId` a `crear_transferencia`. No mueve dinero. |
| Tool | `crear_transferencia` | `origenId`, `destinoId`, `cotizacionId`, `idempotencyKey` (uuid) | escritura, idempotente | Mueve dinero entre dos billeteras usando una cotización vigente (menos de 60 s). Llama primero a `cotizar`. Si hay un fallo de red, reintenta con la misma `idempotencyKey`: nunca se cobra dos veces. |
| Resource | `specs://SPEC-TRANSFER` | ninguna | `text/markdown` | Especificación funcional de las transferencias (`.specs/SPEC-TRANSFER.md`). Léela para conocer las reglas. |
| Resource template | `billetera://{id}` | `id` de la billetera | `application/json` | Estado de una billetera: id, moneda y saldo en unidades mínimas. |
| Prompt | `auditar_transferencia` | `transferenciaId` (string) | n/a | Guía al modelo para revisar una transferencia contra las invariantes. Indica leer primero `specs://SPEC-TRANSFER`. |

Notas de diseño de las primitivas:

- `cotizar` no cambia estado de saldos: es seguro de repetir. Solo guarda la
  cotización.
- `crear_transferencia` es la única operación que mueve dinero. Es idempotente
  por `idempotencyKey` (R5), por eso lleva la pista de idempotencia.
- Ninguna primitiva depende de estado de la conexión: todo lo necesario viaja en
  los argumentos o está en el estado del servidor (billeteras, cotizaciones,
  transferencias).
- Las salidas son pequeñas: un saldo, una cotización o un resultado de
  transferencia con sus asientos.

## 3. Reglas de negocio del servidor (R1 a R5)

La numeración R1 a R5 es la misma en esta spec, en los tests y en los comentarios
del código. No coincide con la numeración de SPEC-TRANSFER; el mapeo está en la
sección 7.

- **R1. Saldo nunca negativo.** *Dado* una billetera origen con saldo X, *cuando*
  se pide transferir un monto Y mayor que X, *entonces* el servidor rechaza con
  `INSUFFICIENT_FUNDS`, el mensaje "Saldo disponible: X; monto requerido: Y" y no
  cambia ningún saldo. Si X es igual a Y, la transferencia se permite y el saldo
  queda en 0.
- **R2. Cotización vigente.** *Dado* un `cotizacionId`, *cuando* se crea la
  transferencia, *entonces* el servidor solo la acepta si la cotización existe y
  tiene menos de 60 segundos. Si no existe, ya se usó o venció, responde
  `QUOTE_EXPIRED` y sugiere llamar a `cotizar` de nuevo. El reloj se inyecta; el
  tiempo no se lee de forma implícita dentro de las reglas.
- **R3. Atomicidad.** *Dado* una transferencia válida, *cuando* se aplica el
  débito y el crédito falla, *entonces* se revierte el débito, ambos saldos
  quedan como antes y no se registran asientos. O se aplican ambos movimientos o
  ninguno.
- **R4. Asientos que suman cero, por moneda.** *Dado* una transferencia
  completada, *entonces* se generan asientos de partida doble que suman cero **en
  cada moneda por separado**. Como el origen y el destino pueden estar en
  monedas distintas, no se mezclan monedas en una misma suma. Se usan cuentas
  puente de compensación de cambio (FX clearing), una por moneda:
  - En la moneda de origen: débito a la billetera origen y crédito a
    `FX_CLEARING_<origen>`, por el monto de origen.
  - En la moneda de destino: débito a `FX_CLEARING_<destino>` y crédito a la
    billetera destino, por el monto convertido.
  - Ejemplo USD a EUR: en USD, débito W-001 / crédito FX_CLEARING_USD; en EUR,
    débito FX_CLEARING_EUR / crédito W-002. La suma de débitos menos créditos es
    cero en USD y es cero en EUR.
  - Si origen y destino tienen la misma moneda, ambos pares de asientos están en
    esa moneda y la suma sigue siendo cero.
- **R5. Idempotencia.** *Dado* una `idempotencyKey` ya procesada con los mismos
  datos, *cuando* se repite `crear_transferencia`, *entonces* se devuelve el
  mismo resultado que la primera vez y no se debita por segunda vez. Si la misma
  llave llega con datos distintos, se rechaza con `IDEMPOTENCY_KEY_REUSED`. La
  consulta de la llave se hace antes que cualquier otra validación, de modo que
  un reintento legítimo no falla por haber vencido la cotización.

Validaciones transversales (no numeradas, con su código de error):

- El monto debe ser un entero positivo, sin decimales y con tope de
  1 000 000 000 000 unidades mínimas. Si no, `INVALID_AMOUNT`.
- Origen y destino deben ser billeteras distintas. Si no, `SAME_WALLET`.
- Las billeteras deben existir. Si no, `WALLET_NOT_FOUND` con la lista de ids.
- La moneda de cada billetera debe coincidir con la de la cotización. Si no,
  `CURRENCY_MISMATCH`.

## 4. Errores

Todos los errores de negocio se devuelven como resultado de herramienta con
`isError: true` y un texto con la forma `CODIGO: mensaje. Sugerencia`. El
servidor no lanza excepciones ni errores de protocolo por reglas de negocio. Los
argumentos con tipo equivocado (por ejemplo un número donde va un texto) los
rechaza el SDK antes de ejecutar código del servidor; con la versión usada, el
SDK los informa como resultado con `isError` y el texto "Input validation error".

| Código | Significado | Sugerencia al agente |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | El saldo de origen es menor que el monto (R1). Muestra "Saldo disponible: X; monto requerido: Y". | Reducir el monto o elegir otra billetera de origen. No reintentar igual. |
| `QUOTE_EXPIRED` | La cotización no existe, ya se usó o tiene 60 s o más (R2). | Llamar a `cotizar` otra vez y usar el nuevo `cotizacionId`. |
| `SAME_WALLET` | Origen y destino son la misma billetera. | Elegir una billetera destino distinta. |
| `WALLET_NOT_FOUND` | Alguna billetera no existe. Incluye los ids válidos. | Usar uno de los ids listados. |
| `CURRENCY_MISMATCH` | La moneda de una billetera no coincide con la de la cotización. | Cotizar con las monedas reales de las billeteras (consultar su saldo primero). |
| `INVALID_AMOUNT` | El monto no es un entero positivo dentro del tope, o convertido al destino daría 0 (con redondeo hacia abajo el origen perdería dinero sin que el destino reciba nada). | Enviar un entero mayor que 0, en centavos, y aumentarlo si es demasiado pequeño. |
| `IDEMPOTENCY_KEY_REUSED` | La llave ya se usó con datos distintos (R5). | Generar una `idempotencyKey` nueva para una operación nueva. |
| `TRANSFER_FAILED` | Falló el crédito y el débito se revirtió (R3). Los saldos no cambiaron. | Reintentar con la misma `idempotencyKey`. |

## 5. Escenarios de aceptación

Se ejecutan de forma automática contra el servidor real por stdio.

1. **Transferencia exitosa.** *Dado* W-001 (USD, 50 000) y W-002 (EUR, 10 000),
   *cuando* se cotiza 10 000 centavos USD a EUR y se crea la transferencia,
   *entonces* W-001 baja a 40 000, W-002 sube según la tasa congelada (redondeo
   hacia abajo) y los asientos suman cero en USD y en EUR (R1, R2, R3, R4).
2. **Consulta de saldo y reglas.** *Dado* la pregunta "cuánto tiene W-003 y qué
   reglas aplican", *cuando* el agente lee `billetera://W-003` y
   `specs://SPEC-TRANSFER`, *entonces* obtiene el saldo de W-003 en COP y el texto
   de la spec con las reglas.
3. **Saldo insuficiente.** *Dado* W-001 con 50 000, *cuando* se intenta
   transferir 1 000 000 centavos (10 000 USD), *entonces* responde
   `INSUFFICIENT_FUNDS` con "Saldo disponible: 50000; monto requerido: 1000000" y
   ningún saldo cambia (R1).
4. **Cotización vieja.** *Dado* una cotización con más de 60 s de antigüedad,
   *cuando* se crea la transferencia, *entonces* responde `QUOTE_EXPIRED` y
   sugiere volver a cotizar; no se mueve dinero (R2). En la prueba la antigüedad
   se simula sin esperar (ver decisiones).
5. **Reintento con la misma llave.** *Dado* una transferencia ya completada,
   *cuando* se repite con la misma `idempotencyKey`, *entonces* el resultado es
   idéntico y no hay un segundo débito (R5).

## 6. No-objetivos

- Autenticación, autorización y multiusuario.
- Persistencia: el estado vive en memoria y se reinicia con el proceso.
- Alta y baja de billeteras o de monedas; las tres billeteras son datos semilla.
- Tasas reales de mercado, proveedor externo de tasas o histórico.
- Comisiones, impuestos, reversos, reembolsos y transferencias programadas.
- Transporte HTTP, despliegue remoto y OAuth.
- Estados de bloqueo de saldo (SALDO_BLOQUEADO) como estados visibles.

## 7. Decisiones del taller

Los puntos marcados `[NEEDS CLARIFICATION]` en SPEC-TRANSFER se resuelven así.
Todas son **decisión del taller, pendiente de confirmar por negocio**.

| Tema abierto en SPEC-TRANSFER | Decisión del taller (pendiente de confirmar por negocio) |
| --- | --- |
| Idempotencia (R10): ¿llave por intento o reintento como operación nueva? | Se exige `idempotencyKey` (uuid) por intento. Misma llave y mismos datos devuelve el resultado original sin mover dinero. Misma llave con datos distintos se rechaza. |
| Autotransferencia y misma moneda | La autotransferencia (mismo id) se rechaza con `SAME_WALLET`. Entre billeteras distintas con la misma moneda se permite con tasa 1:1. |
| Fuente de la tasa | Tabla interna fija en memoria. No hay API externa. Las tasas se guardan como enteros escalados (millonésimas) y solo se convierten a número en la salida `tasa`. |
| Redondeo del monto convertido | El monto destino es el producto monto por tasa dividido entre un millón, **redondeado hacia abajo** al entero de unidad mínima (truncamiento). Se calcula con aritmética entera exacta (BigInt), nunca con flotantes. El redondeo nunca crea dinero. |
| Asientos por estado final | Solo la transferencia COMPLETADA genera asientos. Una transferencia rechazada o expirada no genera asientos ni toca saldos. No hay bloqueo de saldo que liberar. |
| Bloqueo de saldo (R5 de SPEC-TRANSFER) | No se modela como estado visible: la validación, el débito y el crédito ocurren en una sola operación síncrona sin puntos de intercalado. |

Otras decisiones:

- **Cotización de un solo uso.** Al completarse una transferencia, su cotización
  se consume. Reusarla con otra llave devuelve `QUOTE_EXPIRED`.
- **Simulación de antigüedad en pruebas.** La vigencia por defecto es 60 s. Para
  probar el escenario 4 sin esperar, el servidor acepta la variable de entorno
  `BILLETERAS_QUOTE_TTL_MS`, solo para acortar la vigencia (nunca para superar
  60 s). Es un mecanismo de pruebas; en producción no se define.
- **Cuentas puente.** `FX_CLEARING_USD`, `FX_CLEARING_EUR` y `FX_CLEARING_COP`
  son cuentas contables, no billeteras: no se pueden consultar ni usar como
  origen o destino.
- **Consulta de transferencias.** No hay primitiva para listar transferencias. El
  prompt `auditar_transferencia` se apoya en el resultado de
  `crear_transferencia` y, si hace falta, en reintentar con la misma llave.
- **Ids de billetera.** Se validan contra la lista semilla: W-001 (USD), W-002
  (EUR), W-003 (COP).

## 8. Trazabilidad con SPEC-TRANSFER

| Regla de este servidor | Regla de SPEC-TRANSFER que implementa |
| --- | --- |
| R1, saldo nunca negativo | R7, saldo nunca negativo (y R6, saldo insuficiente) |
| R2, cotización vigente menos de 60 s | R4, tasa congelada máximo 60 s |
| R3, atomicidad débito y crédito | R8, operación atómica |
| R4, asientos que suman cero por moneda | R9, partida doble |
| R5, idempotencia por llave | R10, reintento sin segunda transferencia |

Reglas de SPEC-TRANSFER cubiertas por validaciones transversales: R1 (billetera
origen, destino y monto en unidad mínima) y R2 (monto mayor que cero) se cubren
con `INVALID_AMOUNT`, `WALLET_NOT_FOUND` y `SAME_WALLET`. R3 (congelar tasa) se
cubre con `cotizar`.

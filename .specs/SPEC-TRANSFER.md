# Feature: Motor de transferencias multidivisa (SPEC-TRANSFER)

> **Cero tecnología en esta fase.** Esta spec dice *qué* y *por qué*, no *cómo*.
> Bases de datos, lenguajes, bloqueos y frameworks se deciden en el PLAN.

## 1. Contexto y objetivo

Permitir transferir fondos entre billeteras que pueden estar en monedas
distintas (USD, EUR, COP), aplicando una tasa de cambio congelada por un tiempo
limitado, garantizando que ninguna billetera quede en negativo y que cada
movimiento quede registrado contablemente con partida doble.

El problema que se resuelve: hoy no existe una forma segura de mover dinero
entre billeteras de distinta moneda sin riesgo de saldos negativos, cobros a una
tasa ya vencida o movimientos contables descuadrados.

## 2. Actores e historias

- **Como** titular de una billetera **quiero** transferir dinero a otra billetera
  en otra moneda **para** pagar o enviar fondos sin preocuparme por la conversión.
- **Como** área contable **quiero** que cada transferencia genere asientos que
  sumen cero **para** poder auditar y cuadrar los libros.
- **Como** operador del sistema **quiero** que una tasa cotizada no se use
  indefinidamente **para** evitar liquidar a precios desactualizados.

## 3. Reglas de negocio

> Numeradas, atómicas y verificables. Cada una se puede trazar a una tarea y a
> un test.

- **R1.** Toda solicitud de transferencia DEBE indicar billetera origen,
  billetera destino y un monto expresado en la unidad mínima de la moneda de
  origen.
- **R2.** El monto de la transferencia DEBE ser mayor que cero. SI el monto es
  menor o igual a cero, ENTONCES el sistema DEBE rechazar la solicitud con un
  error de validación y no modificar ningún saldo.
- **R3.** Cuando se crea una transferencia, el sistema DEBE cotizar y **congelar
  la tasa de cambio** entre la moneda de origen y la de destino.
- **R4.** La tasa congelada DEBE ser válida por un máximo de **60 segundos**.
  SI transcurren más de 60 segundos sin completar la operación, ENTONCES la
  transferencia DEBE pasar a estado EXPIRADA y no liquidarse.
- **R5.** Antes de debitar, el sistema DEBE **bloquear** el saldo en la billetera
  de origen por el monto de la transferencia.
- **R6.** SI el saldo disponible de la billetera de origen es insuficiente para
  el monto, ENTONCES la transferencia DEBE pasar a estado RECHAZADA y no debitar
  nada.
- **R7.** Ninguna operación DEBE dejar una billetera con **saldo negativo**
  (invariante dura).
- **R8.** Al completar la transferencia, el sistema DEBE debitar el monto de la
  billetera de origen y acreditar el **monto convertido** (monto × tasa
  congelada) en la billetera de destino, en una **operación atómica**: o se
  aplican ambos movimientos o no se aplica ninguno.
- **R9.** Cada transferencia completada DEBE generar **asientos contables que
  sumen cero** (partida doble): la suma de débitos es igual a la suma de créditos
  expresada en una unidad de referencia común.
- **R10.** La misma solicitud reintentada NO DEBE producir una segunda
  transferencia. [NEEDS CLARIFICATION: ¿se exige un identificador de
  idempotencia por intento, como en SPEC-012? ¿o el reintento se trata como
  operación nueva?]

## 4. Máquina de estados

Estados y transiciones (basado en la pista del taller):

```
CREADA ── cotizar ──> TASA_CONGELADA ── bloquear ──> SALDO_BLOQUEADO ── debitar y acreditar ──> COMPLETADA
                           │                                │
                    pasan > 60 s                     saldo insuficiente
                           v                                v
                       EXPIRADA                         RECHAZADA
```

- **CREADA**: la solicitud se registró; aún no hay tasa ni bloqueo.
- **TASA_CONGELADA**: la tasa quedó fija (R3) con su ventana de 60 s (R4).
- **SALDO_BLOQUEADO**: el monto quedó reservado en origen (R5).
- **COMPLETADA**: estado final exitoso; saldos movidos y asientos generados
  (R8, R9).
- **EXPIRADA**: estado final por vencimiento de la tasa (R4).
- **RECHAZADA**: estado final por saldo insuficiente (R6).

## 5. Criterios de aceptación (Gherkin)

```gherkin
# language: es
Caracteristica: Transferencia multidivisa

  Escenario: Transferencia exitosa entre monedas (R3, R5, R8, R9)
    Dado una billetera origen en USD con saldo suficiente
    Y una billetera destino en COP
    Y una tasa congelada vigente entre USD y COP
    Cuando se completa la transferencia
    Entonces se debita el monto en la billetera origen
    Y se acredita el monto convertido en la billetera destino
    Y los asientos contables generados suman cero

  Escenario: Monto invalido (R2)
    Dado una solicitud de transferencia
    Cuando el monto es menor o igual a cero
    Entonces la transferencia se rechaza por validacion
    Y ningun saldo cambia

  Escenario: Saldo insuficiente (R6, R7)
    Dado una billetera origen con saldo menor al monto solicitado
    Cuando se intenta bloquear el saldo
    Entonces la transferencia pasa a estado RECHAZADA
    Y la billetera origen conserva su saldo original

  Escenario: Tasa expirada (R4)
    Dado una transferencia en estado TASA_CONGELADA
    Cuando transcurren mas de 60 segundos sin completarse
    Entonces la transferencia pasa a estado EXPIRADA
    Y no se debita ni acredita ningun monto

  Escenario: Atomicidad ante fallo al acreditar (R8)
    Dado una transferencia en estado SALDO_BLOQUEADO
    Cuando el debito se aplica pero el credito falla
    Entonces se revierte el debito
    Y ninguna billetera queda descuadrada
```

## 6. Casos borde y errores

- Monto cero o negativo → rechazo por validación (R2).
- Saldo exactamente igual al monto → debe permitirse (queda en cero, no
  negativo) (R7).
- Tasa que expira justo durante la liquidación → EXPIRADA; no se liquida (R4).
- Fallo del sistema entre débito y crédito → se revierte todo (R8).
- [NEEDS CLARIFICATION: ¿qué ocurre con el saldo bloqueado si la transferencia
  termina EXPIRADA o RECHAZADA? Se asume que el bloqueo se libera, pero debe
  confirmarse.]
- [NEEDS CLARIFICATION: ¿puede una billetera transferirse a sí misma, o hacia
  una billetera con la misma moneda (tasa 1:1)? ¿Se permite o se rechaza?]
- [NEEDS CLARIFICATION: ¿quién define la tasa de cambio (proveedor externo,
  tabla interna) y con cuántos decimales se redondea el monto convertido?]
- [NEEDS CLARIFICATION: ¿qué asientos contables exactos se generan en cada
  estado final (COMPLETADA, EXPIRADA, RECHAZADA)?]

## 7. No-objetivos

Explícitamente **fuera** del alcance de esta spec:

- Reembolsos o reversos de transferencias ya completadas.
- Transferencias recurrentes o programadas.
- Comisiones, impuestos o retenciones sobre la transferencia.
- Gestión de las tasas de cambio (origen, actualización, histórico): esta spec
  solo las *consume* congeladas.
- Alta/baja de billeteras y de monedas soportadas.

## 8. Preguntas abiertas

Deben resolverse en la fase **Clarify** antes de pasar al PLAN:

- [NEEDS CLARIFICATION: R10 — estrategia de idempotencia ante reintentos.]
- [NEEDS CLARIFICATION: destino del saldo bloqueado en EXPIRADA/RECHAZADA.]
- [NEEDS CLARIFICATION: autotransferencia y transferencia misma-moneda.]
- [NEEDS CLARIFICATION: fuente de la tasa y regla de redondeo.]
- [NEEDS CLARIFICATION: detalle de los asientos contables por estado final.]

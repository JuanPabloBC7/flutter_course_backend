# TASKS-TRANSFER.md — Tareas atómicas del motor de transferencias

> Deriva de `SPEC-TRANSFER.md` y `PLAN-TRANSFER.md`. Regla de oro: una tarea =
> un prompt = un PR pequeño. Tests primero (constitución §1).

## T1 · Tests de aceptación — cubre R1–R9

**Archivo:** `src/transfers/test/transfers.test.ts`

- [ ] Monto <= 0 → 400 `VALIDATION_ERROR` (R2)
- [ ] Transferencia válida entre monedas → 201, débito + crédito convertido (R3, R8)
- [ ] Saldo insuficiente → 422 `INSUFFICIENT_FUNDS`, saldo intacto (R6, R7)
- [ ] Tasa expirada (>60 s) → 409 `RATE_EXPIRED`, sin movimientos (R4)
- [ ] Asientos contables de una transferencia completada suman cero (R9)

**Depende de:** —
**Terminada si:** los 5 tests existen y **fallan por la razón correcta** (aún no
hay implementación).

---

## T2 · Creación, tasa y liquidación base — cubre R1, R2, R3, R4, R8

**Archivo:** `src/transfers/` (routes, service, repository, schemas, types)

- [ ] Validar cuerpo con zod (billeteras, monto entero > 0, moneda ISO 4217)
- [ ] Crear transferencia (CREATED) y congelar tasa con `rateFrozenAt` (RATE_FROZEN)
- [ ] Verificar vigencia de 60 s; si expiró → EXPIRED + 409
- [ ] Liquidar débito + crédito convertido dentro de una transacción ACID
      (`withTransaction`)

**Depende de:** T1
**Terminada si:** los tests de R1, R2, R3, R4 y R8 (camino feliz + expiración)
en verde.

---

## T3 · Bloqueo de saldo y concurrencia — cubre R5, R6, R7

**Archivo:** `src/transfers/repository.ts`, `src/transfers/service.ts`

- [ ] Bloquear saldo de origen con `SELECT … FOR UPDATE` (bloqueo pesimista)
- [ ] Saldo insuficiente → estado REJECTED + 422 (R6)
- [ ] Garantizar saldo nunca negativo, incluido saldo == monto exacto (R7)
- [ ] Test de concurrencia: 2 transferencias en paralelo sobre la misma
      billetera no dejan saldo negativo

**Depende de:** T2
**Terminada si:** los tests de R5, R6, R7 y el de concurrencia en verde.

---

## T4 · Partida doble y robustez — cubre R9 + aclaraciones

**Archivo:** `src/transfers/repository.ts` (asientos), `src/transfers/service.ts`

- [ ] Generar asientos `LedgerEntry` (DEBIT/CREDIT) que sumen cero (R9)
- [ ] Rollback total si el crédito falla tras el débito (atomicidad, R8)
- [ ] Liberar el saldo bloqueado al pasar a EXPIRED o REJECTED
      [pendiente de `[NEEDS CLARIFICATION]` en la SPEC]
- [ ] Actualizar SPEC/PLAN si al implementar surge una regla nueva

**Depende de:** T3
**Terminada si:** suite completa en verde y los asientos cuadran en cero.

---

## Matriz de trazabilidad

| Regla | Tareas      |
|-------|-------------|
| R1    | T1, T2      |
| R2    | T1, T2      |
| R3    | T1, T2      |
| R4    | T1, T2      |
| R5    | T1, T3      |
| R6    | T1, T3      |
| R7    | T1, T3      |
| R8    | T1, T2, T4  |
| R9    | T1, T4      |
| R10   | — (bloqueada por `[NEEDS CLARIFICATION]`: idempotencia) |

Ninguna regla queda huérfana salvo R10, que depende de una aclaración pendiente.

## Pendientes antes de implementar (fase Clarify)

Las tareas asumen que primero se resuelven los `[NEEDS CLARIFICATION]` de la
SPEC. En particular, T4 incluye la liberación del saldo bloqueado, que depende
de confirmar ese comportamiento. R10 (idempotencia) no tiene tarea hasta que se
decida si se exige una clave por intento.

# PLAN-TRANSFER.md — Diseño técnico del motor de transferencias

> El *cómo*. Implementa las reglas R1–R10 de `SPEC-TRANSFER.md` respetando
> `CONSTITUTION.md`. Aquí sí se decide la tecnología.

## 1. Diagrama de flujo

```
POST /transfers
      │
      v
¿Cuerpo valido? ──no──> 400 VALIDATION_ERROR (R1, R2)
      │ si
      v
Crear transferencia (estado CREADA)
      │
      v
Cotizar y congelar tasa (estado TASA_CONGELADA, TTL 60 s)   (R3, R4)
      │
      v
Bloquear saldo en origen (estado SALDO_BLOQUEADO)           (R5)
      │           │
      │      saldo insuficiente ──> estado RECHAZADA + 422  (R6, R7)
      │
      v
¿Tasa aun vigente? ──no──> estado EXPIRADA + 409            (R4)
      │ si
      v
Transaccion atomica:                                        (R8)
  - debitar origen
  - acreditar destino (monto * tasa)
  - escribir asientos contables (suman cero)                (R9)
      │        │
      │   fallo ──> ROLLBACK total, liberar bloqueo
      v
estado COMPLETADA + 201
```

## 2. Contrato de API

### `POST /transfers`

Crea y liquida una transferencia.

Cuerpo de la solicitud:

```json
{
  "sourceWalletId": "wlt_usd_001",
  "destinationWalletId": "wlt_cop_002",
  "amount": 5000,
  "sourceCurrency": "USD"
}
```

- `amount`: entero, unidad mínima de `sourceCurrency` (R1, constitución §4).
- `sourceCurrency`: ISO 4217 (constitución §5).

Respuesta `201 Created` (estado COMPLETADA):

```json
{
  "data": {
    "transferId": "trf_abc123",
    "status": "COMPLETED",
    "sourceWalletId": "wlt_usd_001",
    "destinationWalletId": "wlt_cop_002",
    "sourceAmount": 5000,
    "destinationAmount": 20250000,
    "sourceCurrency": "USD",
    "destinationCurrency": "COP",
    "frozenRate": "4050.00",
    "completedAt": "2026-10-22T12:00:00.000Z"
  }
}
```

## 3. Esquemas (JSON Schema / tipos)

```ts
type TransferStatus =
  | 'CREATED'
  | 'RATE_FROZEN'
  | 'BALANCE_LOCKED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'REJECTED';

interface TransferRecord {
  transferId: string;
  sourceWalletId: string;
  destinationWalletId: string;
  sourceAmount: number;        // entero, unidad minima (R1)
  destinationAmount: number;   // entero, monto convertido (R8)
  sourceCurrency: string;      // ISO 4217
  destinationCurrency: string; // ISO 4217
  frozenRate: string;          // decimal como string, sin float (constitucion §4)
  rateFrozenAt: number;        // epoch ms; expira a los 60 s (R4)
  status: TransferStatus;
  createdAt: number;
}

interface LedgerEntry {
  transferId: string;
  walletId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;              // entero, unidad minima
  currency: string;
  // La suma de DEBIT y CREDIT convertida a una unidad de referencia = 0 (R9)
}
```

## 4. Errores

| HTTP | Código                       | Regla |
|------|------------------------------|-------|
| 400  | `VALIDATION_ERROR`           | R1, R2 |
| 409  | `RATE_EXPIRED`               | R4    |
| 422  | `INSUFFICIENT_FUNDS`         | R6, R7 |
| 500  | `INTERNAL_ERROR`             | —     |

## 5. Decisiones técnicas

### Almacenamiento y atomicidad (R7, R8, R9)

- **PostgreSQL con transacción ACID** (`BEGIN … COMMIT`), reutilizando el patrón
  de `src/credit-cards/database/pool.ts` (`withTransaction`). Débito, crédito y
  asientos contables ocurren dentro de la misma transacción: o todo o nada.
- **Descartado**: Saga con compensación entre servicios. Justificación: el
  dominio es de un solo almacén de datos, una transacción ACID es más simple y
  da atomicidad sin orquestación. La Saga se reservaría para un futuro con
  servicios distribuidos.

### Concurrencia (R5, R7)

- **Bloqueo pesimista** a nivel de fila sobre la billetera de origen
  (`SELECT … FOR UPDATE`) dentro de la transacción, para evitar que dos
  transferencias simultáneas gasten el mismo saldo (condición de carrera que
  llevaría a saldo negativo).
- **Descartado**: bloqueo optimista con número de versión. Justificación: bajo
  alta contención sobre la misma billetera, el pesimista evita reintentos en
  cascada y es más predecible para un invariante duro como "saldo ≥ 0".

### Congelado de tasa (R3, R4)

- La tasa y su marca de tiempo se guardan en la fila de la transferencia
  (`frozenRate`, `rateFrozenAt`). Antes de liquidar se verifica
  `now - rateFrozenAt <= 60_000 ms`; si no, EXPIRADA.
- El monto convertido se calcula con **aritmética entera / decimal exacta**
  (sin `float`, constitución §4).

### Representación del dinero (constitución §4, §5)

- Montos como enteros en la unidad mínima. La tasa como `string` decimal; la
  conversión usa una librería decimal o aritmética de enteros escalada, nunca
  `float`.

### Ubicación del código

- Nuevo ejemplo hermano `src/transfers/` (no toca credit-cards, workers, etc.).
- Capas siguiendo el patrón del proyecto: `routes` → `service` → `repository`,
  con `schemas` (validación) y `types`.

### Dependencias

- Reutiliza `express`, `pg` y `zod` ya presentes. **No** se agregan dependencias
  nuevas (constitución §1). Para aritmética decimal exacta se evalúa primero
  resolverlo con enteros escalados antes de proponer cualquier librería (lo que
  requeriría aprobación).

## 6. Estrategia de pruebas

- Pruebas de integración con PostgreSQL de pruebas (patrón de
  `src/credit-cards/test/`).
- Un test por cada regla R1–R9, más uno de **concurrencia** (dos transferencias
  en paralelo sobre la misma billetera no deben producir saldo negativo).
- R10 queda pendiente de la aclaración de idempotencia.

## 7. Dependencias de reglas no resueltas

Estas decisiones de la SPEC siguen en `[NEEDS CLARIFICATION]` y bloquean parte
del plan; deben cerrarse en Clarify antes de implementar:

- Idempotencia (R10): define si se necesita una tabla/clave como en SPEC-012.
- Liberación del saldo bloqueado en EXPIRADA/RECHAZADA.
- Autotransferencia y transferencia misma-moneda.
- Fuente de la tasa y regla de redondeo del monto convertido.
- Detalle exacto de los asientos contables por estado final.

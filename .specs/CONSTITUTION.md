# CONSTITUTION.md — Motor de transferencias multidivisa

> Reglas globales que ningún agente ni desarrollador puede violar. Una por
> proyecto. El agente la lee en cada tarea.

## Stack permitido

- Node 20 + TypeScript (`strict: true`).
- Express 4 para la capa HTTP.
- Prohibido: nuevos ORMs o librerías sin mantenimiento activo.
- Prohibido: agregar dependencias sin aprobación explícita en un PR.

## Principios no negociables

1. **Test primero**: ninguna tarea se implementa sin un test que falle antes.
2. **Ningún secreto en el código**: credenciales y llaves solo por variables de
   entorno.
3. **Toda entrada se valida**: cada endpoint valida su cuerpo y parámetros antes
   de ejecutar lógica de negocio.
4. **Dinero en enteros**: los montos se representan en la unidad mínima de la
   moneda (p. ej. centavos), nunca en `float`.
5. **Monedas en ISO 4217**: los códigos de moneda usan el estándar de 3 letras
   (USD, EUR, COP).
6. **Atomicidad**: una transferencia es atómica (transacción ACID o Saga con
   compensación). Nunca queda un débito sin su crédito correspondiente.
7. **Partida doble**: toda transferencia genera asientos contables que suman
   cero.
8. **Saldo nunca negativo**: ninguna operación puede dejar una billetera con
   saldo por debajo de cero.

## Definición de terminado

- `npm test` en verde.
- Cobertura >= 80 % en los archivos tocados.
- Spec, plan, tareas y código en el mismo PR.
- Ninguna regla de negocio sin su test de aceptación correspondiente.

## Alcance

Este documento gobierna la feature **Transferencias multidivisa**
(`SPEC-TRANSFER`). Cambiar esta constitución requiere PR y aprobación del
equipo.

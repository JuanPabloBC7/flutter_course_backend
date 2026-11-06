#!/usr/bin/env bash
# Regenera evidencia/ con salidas REALES. Ejecutar desde billeteras-mcp/ tras `npm run build`.
# Inspector: SOLO modo --cli, version fijada (nunca la UI web).
# Nota: el Inspector 2.14.0 declara Node >=22; en Node 20 npm muestra avisos EBADENGINE
# pero funciona. Los avisos se guardan tal cual en la seccion "stderr".
set -u
cd "$(dirname "$0")/.."

INSPECTOR='@modelcontextprotocol/inspector@2.14.0'
OUT=evidencia
mkdir -p "$OUT"

# Ejecuta el Inspector en modo CLI y guarda comando, stdout, stderr y codigo de salida.
inspector() {
  local file="$1"; shift
  local errfile
  errfile="$(mktemp)"
  {
    echo "\$ npx -y $INSPECTOR --cli node build/index.js $*"
    echo
    echo "--- stdout ---"
    npx -y "$INSPECTOR" --cli node build/index.js "$@" 2>"$errfile"
    echo "--- codigo de salida: $? ---"
    echo
    echo "--- stderr (avisos de npm y logs del servidor) ---"
    cat "$errfile"
  } > "$OUT/$file" 2>&1
  rm -f "$errfile"
  echo "escrito $OUT/$file"
}

inspector a1-tools-list.txt --method tools/list
inspector a2-resources-list.txt --method resources/list
inspector a2b-resource-templates-list.txt --method resources/templates/list
inspector a3-prompts-list.txt --method prompts/list
inspector b1-consultar-saldo-valido.txt --method tools/call --tool-name consultar_saldo --tool-arg billeteraId=W-001
inspector b2-consultar-saldo-W-999.txt --method tools/call --tool-name consultar_saldo --tool-arg billeteraId=W-999
inspector c1-tipo-incorrecto-consultar-saldo.txt --method tools/call --tool-name consultar_saldo --tool-arg billeteraId=123
inspector c2-tipo-incorrecto-cotizar.txt --method tools/call --tool-name cotizar --tool-arg origen=USD destino=EUR monto=abc

# (d) stdout solo protocolo
{
  echo '$ node build/index.js < /dev/null   (stdout a un archivo, stderr a otro)'
  node build/index.js < /dev/null > "${TMPDIR:-/tmp}/billeteras-stdout.txt" 2> "${TMPDIR:-/tmp}/billeteras-stderr.txt"
  echo "codigo de salida: $?"
  echo "bytes en stdout: $(wc -c < "${TMPDIR:-/tmp}/billeteras-stdout.txt" | tr -d ' ')"
  echo "contenido de stderr:"
  sed 's/^/  | /' "${TMPDIR:-/tmp}/billeteras-stderr.txt"
  echo
  echo '$ npm run prueba-stdout'
  npm run --silent prueba-stdout
} > "$OUT/d-stdout-solo-protocolo.txt" 2>&1
echo "escrito $OUT/d-stdout-solo-protocolo.txt"

# (e) tests
{ echo '$ npm test'; npm test 2>&1; echo "--- codigo de salida: $? ---"; } > "$OUT/e-tests.txt" 2>&1
echo "escrito $OUT/e-tests.txt"

# (f) escenarios de aceptacion
{ echo '$ npm run escenarios'; npm run --silent escenarios 2>&1; echo "--- codigo de salida: $? ---"; } > "$OUT/f-escenarios.txt" 2>&1
echo "escrito $OUT/f-escenarios.txt"

# (g) typecheck y build
{ echo '$ npm run typecheck'; npm run typecheck 2>&1; echo "--- codigo de salida: $? ---"; echo; echo '$ npm run build'; npm run build 2>&1; echo "--- codigo de salida: $? ---"; } > "$OUT/g-typecheck-y-build.txt" 2>&1
echo "escrito $OUT/g-typecheck-y-build.txt"

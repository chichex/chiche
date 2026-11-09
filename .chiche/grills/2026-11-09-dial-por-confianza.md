# Grill — Dial de autonomía por confianza
<!-- Estado: finalized. Proyecto: /home/chiche/workspace/skills. Fuente: pedido del usuario (tres fricciones del dial en 5.6.x: validación de grill y spec al elegir autonomía, nombres de nivel poco claros, pregunta de umbral). -->
<!-- Chiche-Tracking: version=2; type=grill; state=finalized; issue=none; grill=2026-11-09-dial-por-confianza; project=%2Fhome%2Fchiche%2Fworkspace%2Fskills -->

## Hechos comprobados
- Las tres fricciones pasan en la Fase 3 de `chiche-init`: una pregunta de nivel por fila (`grill`, `spec`, `run`) con las palabras `supervised (Recomendado)`, `plan-approved` y `unattended` sin explicación (`claude/chiche-init/SKILL.md:227`), dos preguntas de umbral siempre (`:229`) y la oferta del ensayo pago para toda fila ≥ A2 (`:269-276`).
- El ensayo corre sobre un proyecto de juguete fijo, con su propio contrato y su propia stop list (`npm publish`), para el pedido fijo `agregar un flag --json`; no usa el repo del usuario (`claude/chiche-init/rehearsal-host.mjs:91,124,159`; `claude/chiche-init/SKILL.md:271-273`).
- Sin ensayo, una fila `plan-approved` o `unattended` queda `unrehearsed` y rige `supervised`: el resolver de este repo imprime `aviso: fila grill sin ensayo (unrehearsed): rige supervised (A1)`.
- El umbral ya decide qué se pregunta: confianza `> umbral` se asume, `≤ umbral` se pregunta; el resolver acepta enteros de 0 a 100 (bloque `autonomy-confidence`, punto 3; regex `^(0|[1-9][0-9]?|100)$`).
- El run no usa confianza: su nivel decide si pregunta ante choques del plan y desviaciones, si lanza el `Code review` y termina, o si además delega en un subagente y corrige el feedback solo con tope de 2 ciclos y 30 minutos (`claude/chiche-run/SKILL.md:22,405`).
- Hoy `--until pr` exige y propaga el nivel que no pregunta (`--until pr exige --autonomy A3`; capa 3 del issue #119 en `.chiche/project.md`).
- Los nombres en inglés y el ensayo como gate fueron decisiones del grill `2026-10-29-dial-autonomia.md` (decisiones 14, 19 y 20).
- `plan-approved` aparece 287 veces en 45 archivos trackeados (`git grep -c`).
- El contrato dice `Sin superficies UI.`: la rama de diseño no aplica.
- Hallazgo lateral, fuera de alcance: el bloque `chiche-events` usa `$1` dentro de `enc()` (`claude/grill/SKILL.md:313`) y el harness lo sustituye por una palabra de los argumentos al cargar el skill con argumentos; es la misma clase de bug que se arregló en 5.6.1 para `chiche-init`.

## Decisiones resueltas
1. Qué se pregunta: el ensayo de niveles se borra del todo: `rehearsal-host.mjs`, la pregunta de costo, el gate (`unrehearsed`/`FAILED` caen a A1) y la columna `Rehearsed`. — preguntada
2. Qué se pregunta: el ensayo de la stop list (gratis, sin agente, cada `Pattern` contra su `Action`) no se toca. — asumida 95 %
3. Modelo: `grill` y `spec` tienen un solo control, la confianza de 0 a 100; `supervised`, `plan-approved` y `unattended` desaparecen de esas dos etapas. 100 pregunta todo, 80 pregunta lo dudoso, 0 no pregunta nada. — preguntada (propuesta del usuario)
4. Modelo: las confirmaciones de paso (configuración y frontera de bloque del grill, confirmación de cierre, menú final de la spec) existen solo con confianza 100. Por debajo, el grill muestra el contrato y congela, y la spec publica y muestra. — preguntada
5. Modelo: `chiche-init` pregunta la confianza una vez por etapa (`grill` y `spec`), con las opciones `80 (Recomendado)`, `100`, `60` y `0`, más la respuesta libre para otro entero. — preguntada
6. Modelo: con confianza 0 el grill no aborta por pedido abierto: asume todo y lista cada decisión con su porcentaje, de menor a mayor. — preguntada
7. Run: conserva un control propio con tres posiciones, `ask` (frena ante choques del plan y desviaciones, ofrece el menú post-PR), `pr` (llega al PR, lanza el review y termina) y `pr-reviewed` (además corrige el feedback del review solo). La conducta de cada una es la de A1, A2 y A3 de hoy. — preguntada
8. Run: las rondas de corrección de feedback quedan fijas en 2 y se escriben en el texto visible de la opción («corrige el review solo, hasta 2 rondas»). No son configurables. — preguntada
9. Run: el tope de 30 minutos de la corrección automática sigue. — asumida 85 %
10. Run: en `chiche-init` la posición recomendada es `pr`. — preguntada
11. Flags: `--autonomy` se retira con un diagnóstico que dice el equivalente nuevo (ejemplo: `--autonomy unattended: usá --confidence 0`), sin alias, como `--assume` y `--subagent` en 5.0.0. `grill` y `spec` reciben un flag de confianza y `chiche-run` uno con su posición. — preguntada
12. Compatibilidad: un contrato con el formato viejo exige `chiche-init --update`; hasta entonces `grill` y `spec` corren en 100 y `run` en `ask`. — preguntada
13. Cadena: `--until pr` queda como control aparte con un solo trabajo, encadenar grill → spec → run. No exige ni fuerza confianza ni posición: la confianza decide qué se pregunta y la fila `run` dónde frena el run. Sin el flag, cada etapa termina en lo suyo. — preguntada
14. Explicación: donde el humano elige o ve un control, va acompañado de una línea que dice qué hace. — asumida 90 %
15. Modelo: una decisión de producto que aparece en la spec se trata por confianza, como cualquier otra, sin aborto en 0. — asumida 82 %
16. Explicación: la escala A0–A5 y las filas `review`, `land` y ambientes (que solo aceptaban `supervised`) salen de lo que ve el usuario; su conducta no cambia. — asumida 85 %
17. Cadena: `issue-triage` sigue la misma regla: «→ hasta el PR» solo pasa `--until pr` y deja de imponer niveles. — asumida 85 %

## Ramas pendientes
Ninguna.

## Handoff

**Tema y alcance.** Simplificar el dial de autonomía: sacar el ensayo de niveles, reemplazar los tres niveles por la confianza en `grill` y `spec`, y darle al run un control propio con nombres claros. Alcanza la doctrina de los cinco harnesses, `chiche-init`, el resolver, el formato de `## Autonomy` y sus gates. No cambia qué hace el run en cada posición.

**Decisiones.** Las 17 de `## Decisiones resueltas`, agrupadas en Qué se pregunta (1–2), Modelo (3–6 y 15), Run (7–10), Flags y compatibilidad (11–12), Cadena (13 y 17) y Explicación (14 y 16). Durante la sesión se reemplazaron dos respuestas: «umbral solo con plan-approved» quedó sin efecto al desaparecer los niveles, y «los contratos existentes rigen como están escritos» fue reemplazada por la decisión 12.

**Restricciones y no-objetivos.** La stop list no cambia y frena siempre. `chiche-land` sigue pidiendo confirmación humana. El run no gana confianza. La división producto/técnica entre grill y spec no cambia. El bug de `$1` del bloque `chiche-events` queda fuera: merece un fix aparte.

**Supuestos.** El cambio va a los cinco harnesses. Sin valor escrito, la confianza es 80.

**Riesgos y diferidos.** Los repos con contrato viejo tienen más fricción hasta correr `chiche-init --update` (este repo incluido: pregunta todo y frena el run ante dudas). Sin ensayo no queda prueba automática por repo de que el agente obedece; queda el eval pago `autonomy-stop-list-a3`. Con 0, un pedido muy abierto termina en una spec armada sobre apuestas. La confianza es una estimación del modelo, sin calibrar.

**Contexto recomendado.** `claude/chiche-init/SKILL.md` (Fase 3 y «Ensayo de niveles»), los bloques `autonomy-levels`, `autonomy-resolve`, `autonomy-confidence` y `autonomy-contract`, `claude/chiche-run/SKILL.md` (líneas 22 y 405), `claude/issue-triage/SKILL.md` (bloque `triage-verdict` y tabla `stage-chain`) y la fila `gate del dial de autonomia` de `.chiche/project.md`.

**Para la spec.**
- Formato nuevo de la tabla de niveles de `## Autonomy` y cómo el resolver detecta un contrato viejo y avisa que corresponde `chiche-init --update`.
- Nombre exacto de los flags: el de confianza en `grill` y `chiche-spec` (`--confidence <n>` fue el ejemplo usado en el grill) y el de la posición en `chiche-run`.
- Qué reemplaza al modo sin preguntas de `chiche-init`, que hoy se dispara con `--autonomy ≥ A2` cuando otro skill lo encadena.
- A qué posición del run quedan atados `--model`, `--effort` e `--inline` (hoy exigen A3).
- `verdict` de `WorkflowResolutionV1`, `dispatch.ts` y `/issues --autonomy` en Pi.
- Retiro del flag en `design-system`, `chiche-land` e `issue-triage`.
- La fila `rehearsal-host.mjs` de la stop list y el caso de eval `autonomy-stop-list-a3`, que usa `--autonomy A3 --inline`.
- Gates a reescribir: `autonomy-gate`, `agents-gate`, `harness-gate`, `grill-gate`, `issue-triage-gate` y `evals-gate`.
- Qué escribe `chiche-init --update` al migrar un contrato viejo y qué pregunta.
- Salto de versión (mayor, por el retiro de `--autonomy`) y plan de capas.

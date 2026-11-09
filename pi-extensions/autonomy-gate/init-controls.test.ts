// Gate de los controles de autonomía en chiche-init (issue #130, CA-21 a CA-23).
//
// Desde 6.0.0 `chiche-init` escribe `## Autonomy` con tres controles: la
// confianza de `grill`, la confianza de `spec` y la posición del run. Este gate
// lee los cinco `chiche-init/SKILL.md` reales y fija, fuera de los bloques
// compartidos `autonomy-*` (que gatea `autonomy-gate.test.ts`): las tres
// preguntas de la Fase 3 con sus opciones literales y la tool del harness
// (CA-21), el flag `--defaults` con lo que escribe y lo que no hace (CA-22), y
// la fila `Autonomy` de «Upgrade de contrato» con la migración del formato
// viejo (CA-23). Es solo-tests y no importa `autonomy-gate.test.ts`. Que un
// agente haga las tres preguntas en una sesión real es prueba humana (CA-30).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { Harness } from "../harness-gate/interaction.ts";
import { HARNESSES, escapeRegExp, fencedBlocks, firstDifference, normalizeInvocations, parseInteractionTable } from "../harness-gate/interaction.ts";

// Bloques compartidos de autonomía que lleva chiche-init. `autonomy-resolve` conserva el mapa de
// equivalentes de `--autonomy`: el vocabulario retirado se busca fuera de ellos.
const SHARED_BLOCKS = ["autonomy-controls", "autonomy-resolve", "autonomy-contract"] as const;

// Issue #130 CA-14: palabras del modelo de niveles que no pueden quedar fuera de los bloques compartidos.
const RETIRED_WORDS = /--autonomy|\bsupervised\b|\bplan-approved\b|\bunattended\b|\bA[0-5]\b|Rehearsed|unrehearsed|[Uu]mbral(?:es)? de confianza|umbral grill|umbral spec|columna `Umbral`|nivel efectivo|Niveles? de autonomía|Nivel efectivo|Nivel sugerido|Ensayo de niveles/;

async function readRepoFile(path: string): Promise<string> {
	return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

interface Interaction {
	prefix: string;
	tool: string;
}

let tableCache: ReturnType<typeof parseInteractionTable> | null = null;
async function interaction(harness: Harness): Promise<Interaction> {
	if (!tableCache) tableCache = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const tool = tableCache.questionTools[harness];
	assert.ok(tool, `${harness}: la tabla de interacción declara su tool de preguntas`);
	return { prefix: tableCache.prefixes[harness], tool };
}

// La única normalización permitida (docs/harness-interaction-differences.md): invocaciones con el
// prefijo del harness y la tool de preguntas. Las regexes de doctrina se escriben contra esta vista.
function normalize(text: string, { prefix, tool }: Interaction): string {
	return normalizeInvocations(text, prefix).replaceAll(`\`${tool}\``, "`«tool-preguntas»`");
}

function outsideSharedBlocks(markdown: string): string {
	let out = markdown;
	for (const name of SHARED_BLOCKS) {
		out = out.replace(new RegExp(`<!-- ${escapeRegExp(name)}:start -->\\n[\\s\\S]*?\\n<!-- ${escapeRegExp(name)}:end -->`, "g"), "");
	}
	return out;
}

// Sección que abre el primer heading `##` que cumple `heading` y termina en el siguiente `##`.
// Ignora los headings dentro de fences, que son templates.
function section(markdown: string, heading: RegExp): string {
	const lines = markdown.split("\n");
	let fence = false;
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		const match = /^## (.*)$/.exec(line);
		if (!match) continue;
		if (start === -1) {
			if (heading.test(match[1] ?? "")) start = index;
			continue;
		}
		return lines.slice(start, index).join("\n");
	}
	return start === -1 ? "" : lines.slice(start).join("\n");
}

function missing(text: string, patterns: RegExp[]): string[] {
	return patterns.filter((pattern) => !pattern.test(text)).map((pattern) => `falta ${pattern}`);
}

function retiredWords(text: string): string[] {
	return text.split("\n").filter((line) => RETIRED_WORDS.test(line));
}

interface InitSkill {
	path: string;
	raw: string;
	// Fuera de los bloques compartidos y normalizado.
	doctrine: string;
	it: Interaction;
}

async function initSkills(): Promise<Map<Harness, InitSkill>> {
	const skills = new Map<Harness, InitSkill>();
	for (const harness of HARNESSES) {
		const path = `${harness}/chiche-init/SKILL.md`;
		const raw = await readRepoFile(path);
		const it = await interaction(harness);
		skills.set(harness, { path, raw, doctrine: normalize(outsideSharedBlocks(raw), it), it });
	}
	return skills;
}

// ---------------------------------------------------------------------------
// CA-22: --defaults reemplaza al modo sin preguntas

const DEFAULTS_FLAG =
	"- `--defaults` — corre sin preguntar: cada duda se asume conservadora y queda `[NEEDS-INPUT]`, `## Autonomy` se escribe con `80` en `grill`, `80` en `spec` y `ask` en `run`, ninguna política se activa, nada se migra (ni `.sdd/` a `.chiche/`, ni el formato de `## Autonomy`, ni la stop list en prosa) y no se invoca `«skill:coding-policies»` ni `«skill:design-system»`. Ver «Controles de autonomía» y «Controles efectivos».";

test("#130 CA-22: --defaults reemplaza al modo sin preguntas en los cinco chiche-init: firma, lanzador, lo que escribe (80, 80 y ask) y lo que no hace (políticas, migraciones, design-system, coding-policies)", async () => {
	const problems: string[] = [];
	for (const [harness, skill] of await initSkills()) {
		const at = (problem: string) => `${skill.path}: ${problem}`;
		const args = section(skill.doctrine, /^Argumentos$/);
		const [signature] = fencedBlocks(args);
		if (signature?.content !== "«skill:chiche-init» [pistas libres] [--no-verify] [--update] [--no-import] [--defaults]") problems.push(at(`firma: ${signature?.content}`));
		if (!args.split("\n").includes(DEFAULTS_FLAG)) problems.push(at("Argumentos no documenta --defaults con lo que escribe y lo que no hace"));

		const launcher = section(skill.doctrine, /^Fase 0\b/);
		problems.push(...missing(launcher, [
			/^ {28}para revisar despues\. {20}\(--defaults\)$/m,
			/^Atajo: «skill:chiche-init» <pistas> \[--no-verify\] \[--defaults\] saltea este menu\.$/m,
			/^3\. `Sin preguntar nada` — corre desatendido; las dudas se asumen conservadoras y quedan `\[NEEDS-INPUT\]` \(`--defaults`\)\.$/m,
		]).map((problem) => at(`Fase 0: ${problem}`)));

		const gaps = section(skill.doctrine, /^Fase 3 — /);
		problems.push(...missing(gaps, [
			/^- Con `--defaults` \(o si el usuario no responde\): assumption más conservadora \(ej\. "solo local, nunca staging"\), documentada en el doc con `\[NEEDS-INPUT\]`\.$/m,
		]).map((problem) => at(`Fase 3: ${problem}`)));

		const policies = section(skill.doctrine, /^Fase 3\.5\b/);
		problems.push(...missing(policies, [
			/^- Con `--defaults`: ninguna política se activa — son elecciones humanas, no se asumen\.$/m,
			/escribir sin preguntar la fila `guia`[^\n]*también con `--defaults`/,
			/invoca `«skill:coding-policies»`; nunca con `--defaults`: generar el archivo es una elección humana\./,
			/invoca `«skill:design-system»` sin flags, nunca con `--defaults`: la dirección visual es una elección humana\./,
		]).map((problem) => at(`Fase 3.5: ${problem}`)));

		const upgrade = section(skill.doctrine, /^Upgrade de contrato\b/);
		problems.push(...missing(upgrade, [
			/Con `--defaults`: no se agrega ninguna \(varias exigen elección humana\); quedan en el reporte como `mejoras disponibles`\.$/m,
			/^\| Diseño \|[^\n]*la Fase 4 la escribe sin preguntar, también con `--defaults`; el reporte la lista como mejora aplicada \|$/m,
			/^\| Stop list \|[^\n]*; con `--defaults` no migra y queda `mejora disponible` \|$/m,
		]).map((problem) => at(`Upgrade de contrato: ${problem}`)));

		const migration = section(skill.doctrine, /^Migración a \.chiche\//);
		if (!/^- Con `--defaults` no se migra ni se pregunta: el reporte lo lista como `mejora disponible`\.$/m.test(migration)) problems.push(at("Migración a .chiche/: --defaults no migra"));

		const report = section(skill.doctrine, /^Reporte$/);
		problems.push(...missing(report, [
			/^- coding-policies: <referenciado\|generado\|no existe \(ofrecido\)\|--defaults: no ofrecido>$/m,
			/^- design-system: <referenciado\|generado\|no existe \(ofrecido\)\|con sistema \(no ofrecido\)\|--defaults: no ofrecido\|sin superficies UI>$/m,
			/\| mantenida \.sdd\/ \| mejora disponible \(--defaults\) \| no aplica>$/m,
			/^tomadas \("mejoras disponibles" con --defaults\), una linea>$/m,
		]).map((problem) => at(`Reporte: ${problem}`)));

		const mustNot = section(skill.doctrine, /^MUST NOT DO$/);
		problems.push(...missing(mustNot, [
			/con `No ejecutar \(Recomendado\)` primera; con `--defaults` nunca se ejecuta\.$/m,
			/si el usuario no las eligió \(o corrió con `--defaults`\), la sección queda vacía/,
		]).map((problem) => at(`MUST NOT DO: ${problem}`)));

		// El flag propio de chiche-init es el único de autonomía de su firma: los de las otras etapas no son suyos.
		if (/--confidence|--mode\b|--until/.test(args)) problems.push(at(`${harness}: Argumentos nombra un flag de otra etapa`));
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// CA-21: las tres preguntas de la Fase 3

const CONFIDENCE_QUESTION = [
	"**Confianza por etapa.** Después de los gaps, preguntar la confianza con `«tool-preguntas»`, una pregunta por etapa (`grill` y `spec`) — «¿Qué te pregunta el agente en <stage>?» —, con estas opciones, la recomendada primera, y la respuesta libre (Other) para otro entero de 0 a 100:",
	"",
	"1. `80 (Recomendado)` — pregunta solo lo dudoso.",
	"2. `100` — pregunta todo y confirma cada paso.",
	"3. `60` — pregunta menos, asume más.",
	"4. `0` — no pregunta nada.",
	"",
	"Por encima de ese número el agente asume una decisión y la muestra; en ese número o por debajo, la pregunta.",
].join("\n");

const RUN_QUESTION = [
	"**Posición del run.** Después de la confianza, preguntar la posición con `«tool-preguntas»`, una sola vez — «¿Dónde frena el run?» —, con estas opciones, la recomendada primera:",
	"",
	"1. `pr (Recomendado)` — abre el PR, lanza el review y termina.",
	"2. `ask` — frena ante dudas y ofrece el menú tras el PR.",
	"3. `pr-reviewed` — como `pr`, y además corrige el feedback del review solo, hasta 2 rondas.",
	"",
	"Las tres respuestas van a la tabla `| Stage | Value | Since |` de `## Autonomy`, cada una en su fila (`grill`, `spec` y `run`) con `Since` de hoy. Con `--defaults` no se pregunta: escribe `80` en `grill`, `80` en `spec` y `ask` en `run`.",
].join("\n");

// En Pi la respuesta libre no viene sola: la pregunta la pide con `allowOther: true`. Es capa de
// interacción (parámetro de la tool) y la única diferencia tolerada en la Fase 3.
const PI_OTHER = "la respuesta libre (Other, con `allowOther: true`) para otro entero de 0 a 100";
const OTHER = "la respuesta libre (Other) para otro entero de 0 a 100";

function phase3(skill: InitSkill, harness: Harness): string {
	const text = section(skill.doctrine, /^Fase 3 — /);
	return harness === "pi" ? text.replace(PI_OTHER, OTHER) : text;
}

test("#130 CA-21: la Fase 3 de los cinco chiche-init pregunta la confianza de grill y de spec (80 recomendado, 100, 60, 0 y respuesta libre) y la posición del run (pr recomendado, ask, pr-reviewed con «hasta 2 rondas»), con la tool del harness y sin preguntas de nivel, umbral ni ensayo", async () => {
	const problems: string[] = [];
	for (const [harness, skill] of await initSkills()) {
		const at = (problem: string) => `${skill.path}: ${problem}`;
		const text = phase3(skill, harness);
		if (!text.includes(`\n\n${CONFIDENCE_QUESTION}\n\n${RUN_QUESTION}\n\n`)) problems.push(at("la Fase 3 no trae la pregunta de confianza seguida de la de posición del run, con sus opciones literales"));

		// La tool es la del harness, no un token genérico ni la de otro.
		const raw = section(outsideSharedBlocks(skill.raw), /^Fase 3 — /);
		for (const ask of ["preguntar la confianza con", "preguntar la posición con"]) {
			if (!raw.includes(`${ask} \`${skill.it.tool}\``)) problems.push(at(`«${ask}» no nombra \`${skill.it.tool}\``));
		}
		if (harness === "pi" && !raw.includes(PI_OTHER)) problems.push(at("la pregunta de confianza no pide `allowOther: true` para la respuesta libre"));
		if (harness !== "pi" && raw.includes("allowOther")) problems.push(at("`allowOther` es un parámetro de la tool de Pi"));

		// Los párrafos titulados de la fase son exactamente estos tres, y las opciones numeradas, estas siete.
		const titled = [...text.matchAll(/^\*\*([^*\n]+)\.\*\*/gm)].map((match) => match[1]);
		if (titled.join(" | ") !== "Confianza por etapa | Posición del run | Stop list") problems.push(at(`párrafos titulados de la Fase 3: ${titled.join(" | ")}`));
		const options = [...text.matchAll(/^\d+\. `([^`]+)`/gm)].map((match) => match[1]);
		if (options.join(" | ") !== "80 (Recomendado) | 100 | 60 | 0 | pr (Recomendado) | ask | pr-reviewed") problems.push(at(`opciones numeradas de la Fase 3: ${options.join(" | ")}`));

		// No quedan preguntas de nivel por fila, de umbral ni de ensayo, ni reglas que escriban otras filas.
		for (const gone of [/¿Hasta dónde llega el agente solo/, /¿A partir de qué confianza asume/, /\bnivel(?:es)?\b/i, /umbral/i, /ensay/i, /una pregunta por fila/, /`review`/, /`land`/, /una por ambiente/, /`70`|`90`/]) {
			if (gone.test(text)) problems.push(at(`la Fase 3 todavía dice ${gone}`));
		}
	}
	assert.deepEqual(problems, []);
});

test("#130 CA-21: la doctrina de la Fase 3 es idéntica entre harnesses tras normalizar invocaciones y tool de preguntas (Pi suma solo `allowOther: true`)", async () => {
	const skills = await initSkills();
	const reference = skills.get("claude");
	assert.ok(reference, "claude/chiche-init/SKILL.md");
	const expected = phase3(reference, "claude");
	assert.ok(expected.includes("«tool-preguntas»"), "la Fase 3 nombra la tool de preguntas del harness");
	const problems: string[] = [];
	for (const [harness, skill] of skills) {
		const actual = phase3(skill, harness);
		if (actual !== expected) problems.push(`claude vs ${harness}: ${firstDifference(expected, actual)}`);
	}
	assert.deepEqual(problems, []);
});

test("#130 autotest: la guarda de vocabulario retirado distingue el texto de 5.x del de 6.0.0", () => {
	const old = [
		"- Con `--autonomy` ≥ A2 (o si el usuario no responde): assumption más conservadora.",
		"**Nivel de autonomía por etapa.** Después de los gaps, preguntar el nivel, con `supervised (Recomendado)` primera.",
		"**Umbrales de confianza.** Después de los niveles, preguntar el umbral de `grill` y el de `spec`.",
		"Cada respuesta va a la columna `Umbral` de su fila; `Rehearsed` lleva `—` en toda fila.",
		"| Ensayo de niveles | hay filas `unrehearsed` |",
	];
	assert.deepEqual(retiredWords(old.join("\n")), old, "cada línea vieja se marca");
	const current = [
		"- Con `--defaults` (o si el usuario no responde): assumption más conservadora.",
		"**Confianza por etapa.** Después de los gaps, preguntar la confianza.",
		"| Coverage mínimo | umbral anclado al baseline actual |",
		"la stop list del branch default y la del working tree; el nivel sigue saliendo del default.",
		"**Ensayo de la stop list.** Con el archivo escrito, correr el comando canónico.",
	];
	assert.deepEqual(retiredWords(current.join("\n")), [], "el texto nuevo, el umbral de coverage y el ensayo de la stop list no se marcan");
});

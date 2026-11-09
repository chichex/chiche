// Gate anti-drift de la doctrina de bloques de grill (issue #89, CA-1 a CA-6, CA-9, CA-11 y CA-12).
//
// El skill `grill` entrevista sin tope de preguntas y siempre por bloques, en los cuatro
// harnesses, con doctrina idéntica y solo la capa de interacción distinta. Este gate lee los
// SKILL.md reales, exige con regexes la doctrina de cada CA, compara el bloque delimitado
// `grill-blocks` entre harnesses tras normalizar invocaciones y tool de preguntas, y observa el
// wiring del repo (runtime de Pi, README, contrato, CI). Es solo-tests, igual que `design-gate`
// y `chiche-land-gate`: esta carpeta no tiene `index.ts` ni factory, porque el gate del Pi Package
// censa exactamente las factories de produccion. La conducta de un agente siguiendo la doctrina
// (CA-14) es prueba humana y no se verifica aca.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { test } from "node:test";

import type { Harness } from "../harness-gate/interaction.ts";
import {
	HARNESSES,
	escapeRegExp,
	fencedBlocks,
	firstDifference,
	normalizeInvocations,
	parseInteractionTable,
} from "../harness-gate/interaction.ts";

const REPO_ROOT = new URL("../../", import.meta.url);

function repoFile(path: string): URL {
	return new URL(path, REPO_ROOT);
}

async function readRepoFile(path: string): Promise<string> {
	return readFile(repoFile(path), "utf8");
}

async function grillSkill(harness: Harness): Promise<string> {
	return readRepoFile(`${harness}/grill/SKILL.md`);
}

// Archivos trackeados en git (el indice), no lo que haya en el working tree de un dev: un borrador
// local sin trackear no entra al censo. Mismo criterio que pi-package y chiche-land-gate.
function trackedFiles(...pathspecs: string[]): string[] {
	const output = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
		cwd: repoFile("."),
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return output.split("\0").filter(Boolean);
}

export function delimitedBlock(markdown: string, name: string): string | null {
	const block = markdown.match(new RegExp(`<!-- ${escapeRegExp(name)}:start -->\\n([\\s\\S]*?)\\n<!-- ${escapeRegExp(name)}:end -->`));
	return block ? (block[1] ?? "") : null;
}

// Cuerpo de la seccion cuyo encabezado (de cualquier nivel) cumple `heading`, hasta el siguiente
// encabezado del mismo nivel o superior.
function section(markdown: string, heading: RegExp): string {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => /^#{1,6} /.test(line) && heading.test(line));
	if (start === -1) return "";
	const level = (lines[start]?.match(/^#+/)?.[0] ?? "#").length;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		const marker = lines[index]?.match(/^(#{1,6}) /)?.[1];
		if (marker && marker.length <= level) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

export function missing(text: string, patterns: RegExp[]): string[] {
	return patterns.filter((pattern) => !pattern.test(text)).map((pattern) => `falta ${pattern}`);
}

export function present(text: string, patterns: RegExp[]): string[] {
	return patterns.filter((pattern) => pattern.test(text)).map((pattern) => `sobra ${pattern}`);
}

// Lee el bloque delimitado `name`, normaliza las invocaciones de skills del repo a la sintaxis
// de Claude y la tool de preguntas del harness a un token comun. Es la vista que se compara.
async function normalizedBlocks(name: string): Promise<{ blocks: Map<Harness, string>; problems: string[] }> {
	const table = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const blocks = new Map<Harness, string>();
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const path = `${harness}/grill/SKILL.md`;
		const block = delimitedBlock(await readRepoFile(path), name);
		if (block === null) {
			problems.push(`${path}: falta el bloque <!-- ${name}:start/end -->`);
			continue;
		}
		const tool = table.questionTools[harness];
		let normalized = normalizeInvocations(block, table.prefixes[harness]).replace(/«skill:([a-z-]+)»/g, "/$1");
		if (tool !== null) normalized = normalized.replaceAll(`\`${tool}\``, "«tool-preguntas»");
		blocks.set(harness, normalized);
	}
	return { blocks, problems };
}

export function divergences(blocks: Map<Harness, string>): string[] {
	const [reference, ...rest] = HARNESSES;
	return rest
		.filter((harness) => blocks.has(harness) && blocks.get(harness) !== blocks.get(reference))
		.map((harness) => `${reference} vs ${harness}: ${firstDifference(blocks.get(reference) ?? "", blocks.get(harness) ?? "")}`);
}

// ---------------------------------------------------------------------------
// A. Sin tope en la doctrina (CA-1)
// ---------------------------------------------------------------------------

// El nombre del campo retirado del runtime se arma a pedazos: CA-9 exige que no aparezca escrito
// en ningun archivo trackeado de pi-extensions, y este gate tambien lo es.
const RETIRED_FIELD = ["question", "Limit"].join("");
const RETIRED_CONSTANT = ["QUESTION", "LIMIT"].join("_");

export const CAP_PHRASES: RegExp[] = [
	/Límite de 20/,
	/tope de 20/,
	/límite de 20/,
	/20 preguntas/,
	/hasta 20/,
	/elección de bloque/,
	new RegExp(RETIRED_FIELD),
];

const PER_CALL_MENTION: Record<Harness, RegExp> = {
	claude: /hasta 4 preguntas por llamada/,
	codex: /hasta 3 preguntas/,
	opencode: /hasta 4 preguntas por llamada/,
	pi: /hasta 4 preguntas/,
	antigravity: /hasta 4 preguntas/,
};

test("CA-1: ningún grill/SKILL.md habla de un tope de 20 ni de elegir bloque", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		for (const problem of present(await grillSkill(harness), CAP_PHRASES)) problems.push(`${harness}/grill/SKILL.md: ${problem}`);
	}
	assert.deepEqual(problems, []);
});

test("CA-1: las menciones al máximo por llamada de cada tool se conservan", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		for (const problem of missing(await grillSkill(harness), [PER_CALL_MENTION[harness]])) problems.push(`${harness}/grill/SKILL.md: ${problem}`);
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// B. Bloque compartido `grill-blocks` (CA-2 y CA-3)
// ---------------------------------------------------------------------------

const BLOCKS_DOCTRINE: RegExp[] = [
	// (a)
	/Un bloque es una sección coherente del árbol de decisiones/,
	// (b)
	/mapa del reconocimiento lista los bloques en orden de dependencias, cada uno con su estimación/,
	// (c)
	/El agente ordena y anuncia los bloques, sin preguntar cuál abordar[^\n]*respuesta libre de la configuración o en cualquier momento/,
	// (d)
	/Dentro del bloque\.\*\* Se entrevista por rondas sobre la frontera o pregunta a pregunta/,
	// (e)
	/Una sesión recorre todos los bloques, uno tras otro/,
	// (f)
	/Al cerrar un bloque, el agente muestra un resumen corto de lo decidido, anuncia el siguiente y hace UNA pregunta con dos opciones: «Seguir con <bloque>» \(recomendada\) y «Cortar acá y seguir más tarde»\. Cortar es pausar, con la exportación de cuestionario disponible/,
	// Issue #130, CA-16: la pregunta de frontera es una confirmación de paso y existe solo con confianza 100.
	/La pregunta existe solo con confianza `100` \(ver «Tipo y confianza»\): por debajo de 100 el agente muestra el resumen, anuncia el siguiente bloque y sigue sin preguntar/,
	// (g)
	/Después del último bloque no hay frontera[^\n]*se pasa al cierre/,
	// (h)
	/La pregunta de frontera de bloque, la configuración y la confirmación final no son preguntas de decisión y no entran en la estimación/,
	// review #90: el handoff pausado conserva a qué bloque pertenece cada decisión sin cambiar su formato
	/\*\*Handoff pausado\.\*\* Mientras la sesión está `paused`, cada decisión de `## Decisiones resueltas` va con el prefijo de su bloque \(`<Bloque>: \.\.\.`, como `Diseño:`\) y cada entrada de `## Ramas pendientes` lleva el encabezado de su bloque, para reconstruir los bloques al retomar/,
];

test("CA-2: los cuatro grill/SKILL.md llevan el bloque grill-blocks bajo ### Bloques con la doctrina de (a) a (h)", async () => {
	const { blocks, problems } = await normalizedBlocks("grill-blocks");
	for (const [harness, block] of blocks) {
		for (const problem of missing(block, BLOCKS_DOCTRINE)) problems.push(`${harness}/grill: <!-- grill-blocks -->: ${problem}`);
		const skill = await grillSkill(harness);
		if (!/^### Bloques\n\n<!-- grill-blocks:start -->$/m.test(skill)) {
			problems.push(`${harness}/grill: el bloque grill-blocks no está inmediatamente bajo el título \`### Bloques\``);
		}
	}
	assert.deepEqual(problems, []);
});

test("CA-3: el bloque grill-blocks es idéntico entre harnesses tras normalizar invocaciones y tool de preguntas", async () => {
	const { blocks, problems } = await normalizedBlocks("grill-blocks");
	assert.deepEqual([...problems, ...divergences(blocks)], []);
});

// ---------------------------------------------------------------------------
// C. Capa de cada harness fuera del bloque (CA-4)
// ---------------------------------------------------------------------------

test("CA-4: en Claude Code, Codex y opencode el atajo liviano no usa bloques ni frontera de bloque", async () => {
	const problems: string[] = [];
	for (const harness of ["claude", "codex", "opencode"] as const) {
		const shortcut = section(await grillSkill(harness), /^### Atajo liviano \(1 a 3 preguntas\)$/);
		if (shortcut === "") problems.push(`${harness}/grill: falta el atajo liviano`);
		for (const problem of missing(shortcut, [/sin mapa, configuración, bloques ni frontera de bloque, todo en una sola ronda/])) problems.push(`${harness}/grill: atajo liviano ${problem}`);
	}
	assert.deepEqual(problems, []);
});

test("CA-4: en Codex y opencode el Grillado rápido propone las decisiones del bloque en curso y aplica la frontera de bloque", async () => {
	const problems: string[] = [];
	for (const harness of ["codex", "opencode"] as const) {
		const quick = section(await grillSkill(harness), /^## Grillado rápido$/);
		if (quick === "") problems.push(`${harness}/grill: falta la sección Grillado rápido`);
		for (const problem of missing(quick, [/Renderizar las decisiones del bloque en curso en orden de dependencia/, /frontera de bloque/])) problems.push(`${harness}/grill: Grillado rápido ${problem}`);
	}
	assert.deepEqual(problems, []);
});

const PI_BLOCKS_LAYER: RegExp[] = [
	/En Pi, los bloques se persisten como `sections` de `grill_session`, cada una con `status` \(`pending`, `active`, `resolved`\) que se actualiza en cada `checkpoint` y en cada frontera de bloque/,
	/La pregunta de frontera de bloque va por `ask_user_question` con `grill: \{ sessionId, phase: "configuration" \}`, sin `frontierSize`/,
	/El Grillado rápido va bloque a bloque: propuesta y revisión colectiva del bloque en curso, y frontera de bloque entre bloques/,
	// review #90: decision.section = id del bloque; la tool escribe el prefijo al pausar
	/`decision\.section` lleva el id del bloque, y cada rama de `pendingBranches` también con `section`; al pausar, la tool escribe el título del bloque como prefijo de cada decisión y de cada rama/,
	// review #90: un bloque sin checkpoint corrige el status en el checkpoint siguiente o en el pause
	/Si el bloque no tuvo `checkpoint` \(todas sus elecciones quedaron `\[ASSUMED\]`\), el `status` de las secciones se corrige en el primer `checkpoint` del bloque siguiente o en el `pause`/,
];

test("CA-4: en Pi la frontera de bloque va por configuration, los bloques se persisten como sections con status y el Grillado rápido va bloque a bloque", async () => {
	const skill = await grillSkill("pi");
	const problems = missing(skill, PI_BLOCKS_LAYER).map((problem) => `pi/grill: ${problem}`);
	const quick = section(skill, /^### Modalidad C: Grillado rápido$/);
	for (const problem of missing(quick, [/bloque en curso/, /frontera de bloque/])) problems.push(`pi/grill: Modalidad C ${problem}`);
	const frontierBullet = skill.split("\n").find((line) => line.startsWith("- `frontierSize`:")) ?? "";
	for (const problem of missing(frontierBullet, [/Vale 1 en modo adaptativo, de 1 a 4 en rondas y la cantidad de decisiones del bloque en la revisión colectiva del modo rápido/])) problems.push(`pi/grill: frontierSize ${problem}`);
	for (const problem of present(frontierBullet, [/\b\d{2,}\b/])) problems.push(`pi/grill: frontierSize ${problem}`);
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// D. Cierre, reanudación y pausa por bloques (CA-5)
// ---------------------------------------------------------------------------

const BLOCKS_LIFECYCLE: RegExp[] = [
	/todos los bloques estén resueltos/,
	/decisiones(?: resueltas)?,? agrupadas por bloque y enumeradas/,
	/bloques cerrados con sus decisiones resueltas \(agrupadas por su prefijo de bloque\)[^\n]*el bloque en curso[^\n]*bloques pendientes[^\n]*por el bloque en curso/,
	/`## Ramas pendientes`[^\n]*lista lo pendiente del bloque en curso y los bloques no empezados, en orden/,
];

test("CA-5: los cuatro harnesses cierran, reanudan y pausan por bloques sin cambiar el formato del handoff", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const skill = await grillSkill(harness);
		for (const problem of missing(skill, BLOCKS_LIFECYCLE)) problems.push(`${harness}/grill: ${problem}`);
		const templates = fencedBlocks(skill).filter((fence) => fence.content.includes("type=grill"));
		if (templates.length !== 1) problems.push(`${harness}/grill: ${templates.length} templates con marker type=grill`);
		for (const problem of missing(templates[0]?.content ?? "", [/Chiche-Tracking: version=2; type=grill; state=<paused\|finalized>; issue=<#NN\|owner\/repo#NN\|none>; grill=<ref>; project=<ref>/, /## Hechos comprobados[\s\S]*## Decisiones resueltas[\s\S]*## Ramas pendientes[\s\S]*## Diseño[\s\S]*## Handoff/])) problems.push(`${harness}/grill: template del handoff ${problem}`);
	}
	assert.deepEqual(problems, []);
});

// Restos del modelo de sesión acotada a un bloque elegido: con «todos los bloques resueltos» el
// mapa no declara un alcance de sesión y el contrato no lista bloques para futuras sesiones.
const BOUNDED_SESSION_REMNANTS: RegExp[] = [
	/alcance de (?:la|esta) sesión/,
	/bloques pendientes para futuras sesiones/,
	/futuras sesiones/,
	/riesgos, pendientes/,
];

test("review #90: ni el mapa ni el contrato del cierre conservan restos de la sesión acotada", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		for (const problem of present(await grillSkill(harness), BOUNDED_SESSION_REMNANTS)) problems.push(`${harness}/grill/SKILL.md: ${problem}`);
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// E. Límites y clasificación de UI sin tope (CA-6)
// ---------------------------------------------------------------------------

test("CA-6: ## Límites conserva «preguntas compuestas» sin referencia a un tope", async () => {
	const problems: string[] = [];
	for (const harness of ["claude", "codex", "opencode"] as const) {
		const limits = section(await grillSkill(harness), /^## Límites$/);
		if (limits === "") problems.push(`${harness}/grill: falta ## Límites`);
		for (const problem of missing(limits, [/preguntas compuestas: una decisión por pregunta/])) problems.push(`${harness}/grill: ## Límites ${problem}`);
		for (const problem of present(limits, [/\b20\b/, /tope/i, /límite de/i])) problems.push(`${harness}/grill: ## Límites ${problem}`);
	}
	const pi = await grillSkill("pi");
	for (const problem of missing(pi, [/no armes preguntas compuestas/, /una decisión por pregunta/])) problems.push(`pi/grill: ${problem}`);
	assert.deepEqual(problems, []);
});

test("CA-6: la pregunta de clasificación de UI «no es una pregunta de decisión» y el bloque grill-design sigue idéntico", async () => {
	const { blocks, problems } = await normalizedBlocks("grill-design");
	for (const [harness, block] of blocks) {
		for (const problem of missing(block, [/va en el reconocimiento y no es una pregunta de decisión/])) problems.push(`${harness}/grill: <!-- grill-design -->: ${problem}`);
		for (const problem of present(block, CAP_PHRASES)) problems.push(`${harness}/grill: <!-- grill-design -->: ${problem}`);
	}
	assert.deepEqual([...problems, ...divergences(blocks)], []);
});

// ---------------------------------------------------------------------------
// F. Runtime Pi sin tope (CA-9)
// ---------------------------------------------------------------------------

export async function retiredFieldOffenders(): Promise<string[]> {
	const pattern = new RegExp(`${RETIRED_FIELD}|${RETIRED_CONSTANT}`);
	const offenders: string[] = [];
	for (const path of trackedFiles("pi-extensions")) {
		const text = await readRepoFile(path).catch(() => null);
		if (text !== null && pattern.test(text)) offenders.push(path);
	}
	return offenders;
}

test("CA-9: ningún archivo trackeado de pi-extensions nombra el tope de preguntas retirado", async () => {
	assert.deepEqual(await retiredFieldOffenders(), []);
});

// ---------------------------------------------------------------------------
// G. Wiring: README, contrato, CI y forma del gate (CA-11 y CA-12)
// ---------------------------------------------------------------------------

const README_GRILL_ROW: RegExp[] = [
	/La entrevista va por bloques en orden de dependencias/,
	/al cerrar cada bloque muestra un resumen corto/,
	/seguir con el siguiente o cortar y seguir más tarde/,
];

test("CA-11: la fila grill de README.md describe la entrevista por bloques y no menciona un tope por sesión", async () => {
	const readme = await readRepoFile("README.md");
	const rows = readme.split("\n").filter((line) => line.startsWith("| **`grill`**"));
	assert.equal(rows.length, 1, "una sola fila grill en README.md");
	const row = rows[0] ?? "";
	assert.deepEqual(missing(row, README_GRILL_ROW), []);
	assert.deepEqual(present(row, [/\btope\b/i, /\blímite\b/i, /hasta 20/, /20 preguntas/]), []);
});

test("CA-12: el contrato suma la fila del gate de grill y CI lo corre con el glob de extensiones", async () => {
	const contract = await readRepoFile(".chiche/project.md");
	const commands = section(contract, /^## Comandos$/);
	assert.match(commands, /^\| gate de doctrina de grill \| `node --test pi-extensions\/grill-gate\/grill-gate\.test\.ts` \| raiz \| verificado \d{4}-\d{2}-\d{2} \|/m);
	assert.match(await readRepoFile(".github/workflows/ci.yml"), /node --test pi-extensions\/\*\/\*\.test\.ts/);
});

const GATE_FOLDER = "pi-extensions/grill-gate";

// Sin `index.ts` ni factory (default export) entre los archivos trackeados de la carpeta del gate:
// el gate del Pi Package censa exactamente las factories de produccion.
export async function gateShapeProblems(): Promise<string[]> {
	const files = trackedFiles(GATE_FOLDER);
	const problems: string[] = [];
	if (!files.includes(`${GATE_FOLDER}/grill-gate.test.ts`)) problems.push("falta grill-gate.test.ts entre los archivos trackeados");
	for (const path of files) {
		if (basename(path) === "index.ts") problems.push(`${path}: el gate no tiene index.ts`);
		const text = await readRepoFile(path).catch(() => null);
		if (text !== null && /export\s+default/.test(text)) problems.push(`${path}: el gate no exporta una factory por default`);
	}
	return problems;
}

test("CA-12: el gate de grill es solo-tests: sin index.ts ni factory en su carpeta", async () => {
	assert.deepEqual(await gateShapeProblems(), []);
});

test("CA-9 y CA-12: un scratch file untracked real no rompe el gate (solo cuentan los archivos trackeados)", async () => {
	// Borradores locales de un dev (una nota que nombra el campo retirado, un prototipo con factory)
	// no entran en el censo: el contrato habla de archivos trackeados, como pi-package y chiche-land-gate.
	const notes = `${GATE_FOLDER}/.chichex-test-scratch-notes.md`;
	const factory = `${GATE_FOLDER}/.chichex-test-scratch-factory.ts`;
	try {
		await writeFile(repoFile(notes), `borrador que nombra ${RETIRED_FIELD} y ${RETIRED_CONSTANT}\n`, "utf8");
		await writeFile(repoFile(factory), `${["export", "default"].join(" ")} function (pi) {\n\treturn {};\n}\n`, "utf8");
		const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", GATE_FOLDER], {
			cwd: repoFile("."),
			encoding: "utf8",
		}).split("\0");
		assert.ok(untracked.includes(notes) && untracked.includes(factory), "los scratch files existen y git los ve como untracked");
		assert.equal(trackedFiles(GATE_FOLDER).includes(notes), false);
		assert.equal(trackedFiles(GATE_FOLDER).includes(factory), false);
		assert.deepEqual(await retiredFieldOffenders(), []);
		assert.deepEqual(await gateShapeProblems(), []);
	} finally {
		await rm(repoFile(notes), { force: true });
		await rm(repoFile(factory), { force: true });
	}
});

// ---------------------------------------------------------------------------
// H. Autotests del propio gate
// ---------------------------------------------------------------------------

test("autotest: el detector de tope reporta cada frase retirada y acepta la doctrina nueva", () => {
	for (const phrase of ["### Límite de 20", "Tope duro de 20 preguntas de decisión", "tope de 20", "dividilo en bloques de hasta 20", "la elección de bloque", `campo ${RETIRED_FIELD}`]) {
		assert.ok(present(phrase, CAP_PHRASES).length > 0, `detecta: ${phrase}`);
	}
	assert.deepEqual(present("hasta 4 preguntas por llamada y hasta 3 por request_user_input", CAP_PHRASES), []);
	assert.deepEqual(present("Un bloque es una sección coherente del árbol de decisiones", CAP_PHRASES), []);
});

test("autotest: un bloque ausente, incompleto o divergente se reporta con su diagnóstico", () => {
	assert.equal(delimitedBlock("sin bloque", "grill-blocks"), null);
	assert.equal(delimitedBlock("<!-- x:start -->\nhola\n<!-- x:end -->", "x"), "hola");
	const problems = missing("texto sin nada relevante", BLOCKS_DOCTRINE);
	assert.equal(problems.length, BLOCKS_DOCTRINE.length);
	assert.match(problems[0] ?? "", /Un bloque es una sección coherente/);
	const drift = divergences(new Map<Harness, string>([
		["claude", "a\nb"],
		["codex", "a\nc"],
		["opencode", "a\nb"],
		["pi", "a\nb"],
	]));
	assert.deepEqual(drift, ["claude vs codex: linea 2: `b` vs `c`"]);
});

test("autotest: section() recorta hasta el siguiente encabezado del mismo nivel", () => {
	const markdown = "## A\ntexto A\n### A.1\nsub\n## B\ntexto B";
	assert.equal(section(markdown, /^## A$/), "## A\ntexto A\n### A.1\nsub");
	assert.equal(section(markdown, /^### A\.1$/), "### A.1\nsub");
	assert.equal(section(markdown, /^## Z$/), "");
});

// ---------------------------------------------------------------------------
// I. Issue #119, CA-7: el handoff muestra cómo se cerró cada decisión y anota las técnicas para la spec
// ---------------------------------------------------------------------------

test("#119 CA-7: el template del handoff y el contrato visible del cierre terminan cada decisión en «— preguntada» o «— asumida NN %» y el handoff lleva el párrafo **Para la spec.**, en los cinco harnesses; en Pi el % viaja en agreement", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const skill = await grillSkill(harness);
		const template = fencedBlocks(skill).find((fence) => fence.content.includes("type=grill"))?.content ?? "";
		for (const problem of missing(template, [
			/^## Decisiones resueltas\n1\. <decisión y lo acordado> — preguntada\n2\. <decisión y su recomendada> — asumida NN %$/m,
			/^## Handoff\n<vacío mientras esté paused; contrato completo cuando esté finalized, con el párrafo \*\*Para la spec\.\*\* y las decisiones técnicas anotadas, o `ninguna`>$/m,
		])) problems.push(`${harness}/grill: template del handoff ${problem}`);
		// El template no gana secciones nuevas (CA-7): siguen las cinco de siempre.
		const headings = template.split("\n").filter((line) => line.startsWith("## "));
		if (headings.join("|") !== "## Hechos comprobados|## Decisiones resueltas|## Ramas pendientes|## Diseño|## Handoff") problems.push(`${harness}/grill: el template cambió de secciones: ${headings.join(", ")}`);
		const closing = section(skill, /^(## Cierre|## Fase 3: cierre)$/);
		if (closing === "") problems.push(`${harness}/grill: sin sección de cierre`);
		for (const problem of missing(closing, [
			/`— preguntada` o `— asumida NN %`/,
			/\*\*Para la spec\.\*\*[^\n]*decisiones técnicas[^\n]*`ninguna`/,
		])) problems.push(`${harness}/grill: cierre ${problem}`);
	}
	const pi = await grillSkill("pi");
	// Review #123-6: en una sesión pausada también viaja `— preguntada`, al final del texto de agreement.
	for (const problem of missing(pi, [/`— preguntada` o `— asumida NN %` van al final del texto de cada decisión del `handoffMarkdown` y, en una sesión pausada, viajan al final del texto de `agreement`[^\n]*`grill_session` no cambia/])) problems.push(`pi/grill: ${problem}`);
	assert.deepEqual(problems, []);
});

// Review #123-4 → issue #130: en Pi la poda `risk-pruned` y la política `explicit-only` quedan atadas a la confianza de la etapa, como en los otros cuatro.
test("review #123 → #130: en pi/grill risk-pruned asume solo decisiones de producto con confianza > confianza grill, explicit-only equivale a confianza 100 y ningún [ASSUMED] queda sin porcentaje en las reglas de poda", async () => {
	const pi = await grillSkill("pi");
	assert.deepEqual(missing(pi, [
		/Marcá como `\[ASSUMED NN %\]` una decisión de producto cuya opción recomendada supere la confianza de la etapa \(confianza `> confianza grill`, ver «Tipo y confianza»\)/,
		/Una decisión técnica no se asume ni se pregunta: va a `\*\*Para la spec\.\*\*`/,
		/Preguntá las decisiones de producto con confianza `≤ confianza grill`[^\n]*la confianza manda, no la lista/,
		/`explicit-only` \(equivale a confianza `100`: se pregunta toda decisión de producto\)/,
		/usá `risk-pruned`, atada a la confianza: convertí en `\[ASSUMED NN %\]` cada decisión de producto cuya recomendada supere `confianza grill`[^\n]*una con confianza `≤ confianza grill` sigue explícita aunque sea barata de corregir/,
	]).map((problem) => `pi/grill: ${problem}`), []);
	assert.deepEqual(present(pi, [/Marcá como `\[ASSUMED\]` una opción respaldada/, /Preguntá solo decisiones que cambien materialmente/, /convertí cada elección respaldada, de bajo riesgo y reversible en `\[ASSUMED\]`/]).map((problem) => `pi/grill: ${problem}`), []);
});

// ---------------------------------------------------------------------------
// J. Issue #130, CA-16: grill por confianza (firma, cierre, pasos solo con 100, cadena sin niveles)
// ---------------------------------------------------------------------------

// Los cuatro bloques compartidos del dial los fija autonomy-gate (byte a byte): acá se mira la prosa de afuera.
const DIAL_SHARED_BLOCKS = ["autonomy-controls", "autonomy-resolve", "autonomy-confidence", "autonomy-contract"] as const;

export function withoutDialBlocks(markdown: string): string {
	let text = markdown;
	for (const name of DIAL_SHARED_BLOCKS) text = text.replace(new RegExp(`<!-- ${name}:start -->\\n[\\s\\S]*?\\n<!-- ${name}:end -->`, "g"), "");
	return text;
}

// Vocabulario del modelo de niveles, retirado en 6.0.0 (brief de la capa 2: «Palabras que no pueden quedar»).
// Los nombres se arman a pedazos para que este archivo no los lleve escritos de corrido.
export const RETIRED_DIAL_WORDS: RegExp[] = [
	new RegExp(["super", "vised"].join("")),
	new RegExp(["plan", "approved"].join("-")),
	new RegExp(["un", "attended"].join("")),
	/\bA[0-5]\b/,
	new RegExp(["--auto", "nomy"].join("")),
	/[Rr]ehearsed/,
	/\bumbral(?:es)?\b/i,
	/nivel efectivo/i,
	/Niveles de autonomía/i,
	/Nivel sugerido/i,
	/nivel de autonomía/i,
	/NEEDS-INPUT/,
	/autonomizable/,
];

// Pi lleva su propia capa (fases y tools): la prosa de configuración, atajo liviano y `## Límites` vive en los otros cuatro.
const GRILL_PROSE_HARNESSES = ["claude", "codex", "opencode", "antigravity"] as const;

const GRILL_SIGNATURE: Record<Harness, string> = {
	claude: "/grill [tema | #NN | ruta de handoff] [--confidence <n>] [--until pr]",
	codex: "$grill [tema | #NN | ruta de handoff] [--confidence <n>] [--until pr]",
	opencode: "/grill [tema | #NN | ruta de handoff] [--confidence <n>] [--until pr]",
	pi: "/skill:grill [#NN | owner/repo#NN | https://github.com/owner/repo/issues/NN | --resume <sessionId>] [--confidence <n>] [--until pr]",
	antigravity: "/grill [tema | #NN | ruta de handoff] [--confidence <n>] [--until pr]",
};

const GRILL_CHAIN_TARGET: Record<Harness, string> = {
	claude: "ruta-del-handoff",
	codex: "ruta-del-handoff",
	opencode: "ruta-del-handoff",
	pi: "sessionId",
	antigravity: "ruta-del-handoff",
};

test("#130 CA-16: la firma de grill es [--confidence <n>] [--until pr] en los cinco harnesses, con el bullet del flag y la cadena que solo propaga lo recibido", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const skill = await grillSkill(harness);
		const signatures = fencedBlocks(skill).filter((fence) => fence.content.split("\n").some((line) => /^(?:\/|\$|\/skill:)grill /.test(line)));
		if (signatures.length !== 1 || signatures[0]?.content.trim() !== GRILL_SIGNATURE[harness]) problems.push(`${harness}/grill: la firma no es \`${GRILL_SIGNATURE[harness]}\` (hay: ${signatures.map((fence) => fence.content.trim()).join(" | ")})`);
		for (const problem of missing(skill, [
			/^- `--confidence <n>` — confianza de esta corrida, un entero de 0 a 100; manda sobre la fila `grill` de `## Autonomy` del contrato\./m,
			/`0` no pregunta nada, `80` pregunta solo lo dudoso y `100` pregunta todo y además confirma cada paso \(la configuración, la frontera de bloque y el cierre\)/,
			/Ver «Controles de autonomía», «Controles efectivos» y «Tipo y confianza»\./,
			/^- `--until pr` — hasta dónde llega la cadena: [^\n]*por debajo de 100 congela el handoff y encadena sin preguntar; con 100 la confirmación ofrece `Confirmar y crear spec SDD` como única forma de confirmar/m,
			/recibe `--until pr`, más `--confidence <n>` solo si esta corrida lo recibió: `--until pr` no cambia por sí solo la confianza de la spec ni la posición del run/,
			/`--until` con cualquier otro valor aborta listando el único válido \(`pr`\)\. El flag existe solo en `grill` y `chiche-spec`: nunca llega a `chiche-run`\./,
		])) problems.push(`${harness}/grill: argumentos ${problem}`);
	}
	assert.deepEqual(problems, []);
});

const GRILL_CLOSING_COMMON: RegExp[] = [
	/Con confianza `0` no hay aborto por pedido abierto: el reconocimiento corre igual, todas las decisiones de producto quedan asumidas y el contrato las lista de menor a mayor confianza, para que lo más dudoso se vea primero/,
	/[Pp]or debajo de 100 este paso no existe: con el contrato ya visible, el handoff se congela sin preguntar, con lo decidido y lo asumido/,
	/por debajo de 100, sin esperar confirmación/,
	/no se le agrega ningún otro flag/,
	/Sin `--until pr` y por debajo de 100, el cierre termina con el handoff congelado y su ruta, sin encadenar la spec/,
];

// La confirmación de cuatro opciones de hoy (cinco acciones en Codex, opencode y Pi, que separan pausar de exportar), solo con 100.
const GRILL_CLOSING_CONFIRMATION: Record<Harness, RegExp[]> = {
	claude: [/^2\. \*\*Confirmación autocontenida \(solo con confianza `100`\)\.\*\*/m, /- `Confirmar`: [^\n]*\n\s+- `Confirmar y crear spec SDD`: [^\n]*\n\s+- `Ajustar una decisión`: [^\n]*\n\s+- `Pausar o exportar cuestionario`: /, /Con `--until pr`, `Confirmar` a secas no se ofrece: la única confirmación es `Confirmar y crear spec SDD`\./],
	antigravity: [/^2\. \*\*Confirmación autocontenida \(solo con confianza `100`\)\.\*\*/m, /- `Confirmar`: [^\n]*\n\s+- `Confirmar y crear spec SDD`: [^\n]*\n\s+- `Ajustar una decisión`: [^\n]*\n\s+- `Pausar o exportar cuestionario`: /, /Con `--until pr`, `Confirmar` a secas no se ofrece: la única confirmación es `Confirmar y crear spec SDD`\./],
	codex: [/^2\. Solo con confianza `100`: pedir una confirmación explícita y autocontenida: confirmar, ajustar una decisión, pausar, exportar cuestionario para un stakeholder \(ver \*\*Exportar cuestionario\*\*\) o confirmar y crear spec SDD\. Con `--until pr`, la única confirmación es confirmar y crear spec SDD \(sin confirmar a secas\)\./m],
	opencode: [/^2\. Solo con confianza `100`: pedir una confirmación explícita y autocontenida: confirmar, ajustar una decisión, pausar, exportar cuestionario para un stakeholder \(ver \*\*Exportar cuestionario\*\*\) o confirmar y crear spec SDD\. Con `--until pr`, la única confirmación es confirmar y crear spec SDD \(sin confirmar a secas\)\./m],
	pi: [/^### Paso 2: confirmación autocontenida \(solo con confianza `100`\)$/m, /- \*\*Confirmar entendimiento\*\*: [^\n]*\n- \*\*Confirmar y crear spec SDD\*\*: [^\n]*\n- \*\*Ajustar una decisión o supuesto\*\*: [^\n]*\n- \*\*Pausar\*\*: [^\n]*\n- \*\*Exportar cuestionario\*\*: /, /Con `--until pr`, \*\*Confirmar entendimiento\*\* no se ofrece: la única confirmación es \*\*Confirmar y crear spec SDD\*\*/],
};

test("#130 CA-16: el Cierre de grill congela el handoff sin preguntar por debajo de 100, confirma solo con 100, encadena la spec con --until pr sin agregar niveles y con 0 lista lo asumido de menor a mayor confianza", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const closing = section(await grillSkill(harness), /^(## Cierre|## Fase 3: cierre)$/);
		if (closing === "") problems.push(`${harness}/grill: sin sección de cierre`);
		const target = GRILL_CHAIN_TARGET[harness];
		const chain = new RegExp(`\`${escapeRegExp(`${prefixes[harness]}chiche-spec --from-grill <${target}> --until pr`)}\`, más \`--confidence <n>\` solo si esta corrida lo recibió`);
		for (const problem of missing(closing, [
			...GRILL_CLOSING_COMMON,
			...GRILL_CLOSING_CONFIRMATION[harness],
			new RegExp(`\`--from-grill <${target}>\`, más \`--confidence <n>\` solo si esta corrida lo recibió`),
			chain,
		])) problems.push(`${harness}/grill: cierre ${problem}`);
	}
	assert.deepEqual(problems, []);
});

test("#130 CA-16: la configuración de grill se pregunta solo con confianza 100 en Claude Code, Codex, opencode y Antigravity, y el atajo liviano cierra sin preguntar por debajo de 100", async () => {
	const problems: string[] = [];
	for (const harness of GRILL_PROSE_HARNESSES) {
		const skill = await grillSkill(harness);
		const configuration = section(skill, /^## Configuración$/);
		if (configuration === "") problems.push(`${harness}/grill: falta ## Configuración`);
		for (const problem of missing(configuration, [
			/^Solo con confianza `100` \(ver «Tipo y confianza»\) y salvo en el atajo liviano, después del mapa y antes de la primera pregunta, elegí la modalidad con /m,
			/Por debajo de 100 la configuración no se pregunta: rige la modalidad que recomendó el reconocimiento/,
		])) problems.push(`${harness}/grill: ## Configuración ${problem}`);
		const shortcut = section(skill, /^### Atajo liviano \(1 a 3 preguntas\)$/);
		for (const problem of missing(shortcut, [
			/contrato visible — puede ser breve — antes de pedir confirmación \(con confianza `100`\) o de cerrar sin preguntar \(por debajo de 100\)/,
			/Guardá el handoff solo si el usuario lo pide, pausa, o se encadena la spec \(que necesita la ruta\)/,
		])) problems.push(`${harness}/grill: atajo liviano ${problem}`);
	}
	assert.deepEqual(problems, []);
});

// Una decisión asumida por confianza se persiste marcada, nunca como respondida: los principios y los límites
// que prohibían persistir una recomendación sin el OK del usuario conviven con asumir por confianza.
const GRILL_ASSUMED_PRINCIPLE = /[Uu]na decisión asumida por confianza \(ver «Tipo y confianza»\) se persiste marcada `— asumida NN %` con su recomendada, nunca como si la hubiera respondido el usuario/;
const GRILL_ASSUMED_LIMIT = /No persist(?:as|ir) una recomendación como si el usuario la hubiera respondido: una decisión asumida por confianza se persiste marcada `— asumida NN %`, y una preguntada, recién con su respuesta/;
const GRILL_STALE_APPROVAL: RegExp[] = [
	/ninguna recomendación se persiste como decisión antes del OK del usuario/,
	/No persist(?:as|ir) recomendaciones como decisiones antes de la aprobación del usuario/,
	/La confirmación final acepta también todos los `\[ASSUMED\]` visibles/,
	/La confirmación final aprueba tanto las decisiones como los `\[ASSUMED\]` enumerados/,
];

test("#130 CA-16: los principios y límites de grill conviven con asumir por confianza: lo asumido se persiste marcado «— asumida NN %», nunca como respondido por el usuario", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const skill = await grillSkill(harness);
		for (const problem of missing(section(skill, /^## Principios$/), [GRILL_ASSUMED_PRINCIPLE])) problems.push(`${harness}/grill: ## Principios ${problem}`);
		for (const problem of present(skill, GRILL_STALE_APPROVAL)) problems.push(`${harness}/grill: ${problem}`);
	}
	for (const harness of GRILL_PROSE_HARNESSES) {
		for (const problem of missing(section(await grillSkill(harness), /^## Límites$/), [GRILL_ASSUMED_LIMIT])) problems.push(`${harness}/grill: ## Límites ${problem}`);
	}
	// Pi no tiene `## Límites`: la regla vive en «Persistencia de supuestos» y en el contrato visible del cierre.
	const pi = await grillSkill("pi");
	for (const problem of missing(pi, [
		/Con confianza `100` no queda ningún `\[ASSUMED\]` \(se pregunta todo\) y la confirmación final aprueba las decisiones; por debajo de 100 no hay confirmación final: el handoff se congela con cada `\[ASSUMED NN %\]` marcado `— asumida NN %`, nunca como respondido por el usuario/,
	])) problems.push(`pi/grill: ${problem}`);
	assert.deepEqual(problems, []);
});

test("#130 CA-25 (texto): en pi/grill el finalize de grill_session lleva confidence en lugar del nivel y until: \"pr\" materializa --from-grill <sessionId> --until pr sin forzar nada", async () => {
	const pi = await grillSkill("pi");
	assert.deepEqual(missing(pi, [
		/más `--confidence <n>` solo si esta corrida lo recibió: pasalo en el parámetro `confidence` del finalize, un entero de 0 a 100/,
		/con `--until pr`, pasá `until: "pr"` en el finalize sin esperar la elección \*\*Confirmar y crear spec SDD\*\* \(con 100 es la única confirmación; por debajo de 100 no se pregunta\)/,
		/la tool materializa `\/skill:chiche-spec --from-grill <sessionId> --until pr`, más `--confidence <n>` solo si esta corrida lo recibió; no se le agrega ningún otro flag/,
		/Sin pregunta de cierre, con `--until pr` el finalize lleva `continueWithSpec: true` y `until: "pr"` directo/,
	]).map((problem) => `pi/grill: ${problem}`), []);
	assert.deepEqual(present(pi, [/parámetro `autonomy` del finalize/]).map((problem) => `pi/grill: ${problem}`), []);
});

test("#130 CA-14 (grill): fuera de los bloques compartidos del dial, ningún grill/SKILL.md nombra niveles, --autonomy, umbrales ni [NEEDS-INPUT]", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const lines = withoutDialBlocks(await grillSkill(harness)).split("\n");
		lines.forEach((line, index) => {
			for (const problem of present(line, RETIRED_DIAL_WORDS)) problems.push(`${harness}/grill/SKILL.md (línea ${index + 1} sin los bloques): ${problem}`);
		});
	}
	assert.deepEqual(problems, []);
});

test("autotest: el detector del dial retirado marca el vocabulario viejo, deja pasar el nuevo y withoutDialBlocks saca solo los bloques compartidos", () => {
	const retired = [["super", "vised"].join(""), ["plan", "approved"].join("-"), ["un", "attended"].join(""), "con A2 o A3", `${["--auto", "nomy"].join("")} <level>`, "Rehearsed", ["un", "rehearsed"].join(""), "umbral grill", "debajo del umbral", "nivel efectivo", "«Niveles de autonomía»", "**Nivel sugerido.**", "cualquier nivel de autonomía", "[NEEDS-INPUT]", "pedido no autonomizable"];
	for (const phrase of retired) assert.ok(present(phrase, RETIRED_DIAL_WORDS).length > 0, `detecta: ${phrase}`);
	for (const phrase of ["confianza grill", "con confianza `≤ confianza spec`", "`--confidence <n>`", "`--mode pr-reviewed`", "«Controles de autonomía»", "«Controles efectivos»", "**Opción sugerida.**", "por debajo de 100", "`## Autonomy` del contrato", "Modalidad A: Grillado pregunta a pregunta"]) {
		assert.deepEqual(present(phrase, RETIRED_DIAL_WORDS), [], `acepta: ${phrase}`);
	}
	const markdown = ["antes", "<!-- autonomy-resolve:start -->", `${["un", "attended"].join("")} o A3`, "<!-- autonomy-resolve:end -->", "<!-- grill-blocks:start -->", "bloque propio", "<!-- grill-blocks:end -->", "después"].join("\n");
	assert.equal(withoutDialBlocks(markdown), ["antes", "", "<!-- grill-blocks:start -->", "bloque propio", "<!-- grill-blocks:end -->", "después"].join("\n"));
});

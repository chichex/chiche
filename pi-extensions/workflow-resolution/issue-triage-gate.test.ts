import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { ACTIONABLE_ROUTE_CONTRACT } from "../workflow-orchestrator/route-contract.ts";

const HARNESSES = ["claude", "codex", "opencode", "pi"] as const;
type Harness = (typeof HARNESSES)[number];

function repoFile(path: string): URL {
	return new URL(`../../${path}`, import.meta.url);
}

async function readRepoFile(path: string): Promise<string> {
	return readFile(repoFile(path), "utf8");
}

export function artifactAwareBlock(markdown: string): string {
	const match = markdown.match(
		/<!-- artifact-aware:start -->\n([\s\S]*?)\n<!-- artifact-aware:end -->/,
	);
	assert.ok(match?.[1], "bloque normativo artifact-aware presente");
	return match[1];
}

interface InteractionDifferences {
	invocation: Record<Harness, string>;
	questionTool: Record<Harness, string>;
}

export function parseInteractionDifferences(markdown: string): InteractionDifferences {
	const block = markdown.match(
		/<!-- interaction-differences:start -->\n([\s\S]*?)\n<!-- interaction-differences:end -->/,
	);
	assert.ok(block?.[1], "tabla normativa de interacción presente");
	const rows = block[1].split("\n").filter((line) => line.startsWith("|"));
	const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));
	const header = cells(rows[0] ?? "");
	const indexes = new Map(header.map((name, index) => [name, index]));
	const row = (name: string): string[] => cells(rows.find((line) => cells(line)[0] === name) ?? "");
	const invocations = row("invocacion");
	const tools = row("tool-preguntas");
	const invocation = {} as Record<Harness, string>;
	const questionTool = {} as Record<Harness, string>;
	for (const harness of HARNESSES) {
		const index = indexes.get(harness);
		assert.notEqual(index, undefined, `columna ${harness} presente`);
		const invocationPattern = invocations[index!] ?? "";
		assert.ok(invocationPattern.endsWith("nombre"), `${harness}: patrón de invocación válido`);
		invocation[harness] = invocationPattern.slice(0, -"nombre".length);
		questionTool[harness] = tools[index!] ?? "";
	}
	return { invocation, questionTool };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeArtifactAwareBlock(
	block: string,
	harness: Harness,
	differences: InteractionDifferences,
): string {
	const invocation = differences.invocation[harness];
	const questionTool = differences.questionTool[harness];
	// Mismo borde que normalizeInvocations de harness-gate/interaction.ts: una
	// ruta como `.sdd/grills/` no es una invocación de `/grill`.
	let normalized = block.replace(
		new RegExp(`(^|[^A-Za-z0-9.])${escapeRegExp(invocation)}(issue-triage|grill|chiche-spec|chiche-run)(?![A-Za-z0-9-])`, "gm"),
		(_match, before: string, name: string) => `${before}«skill:${name}»`,
	);
	if (questionTool && questionTool !== "—") {
		normalized = normalized.replaceAll(`\`${questionTool}\``, "`«question-tool»`");
	}
	return normalized;
}

export function compareArtifactAwareBlocks(blocks: Map<Harness, string>): string[] {
	const reference = blocks.get("claude") ?? "";
	const differences: string[] = [];
	for (const harness of HARNESSES.slice(1)) {
		if ((blocks.get(harness) ?? "") !== reference) differences.push(`${harness} diverge de claude`);
	}
	return differences;
}

const REQUIRED_ROUTES = [
	"resume-grill",
	"spec-from-grill",
	"update-existing-spec",
	"run-existing-spec",
	"already-implemented",
	"superseded-artifact",
	"audit-existing-spec",
	"artifact-conflict",
] as const;

const REQUIRED_SCHEMA_FIELDS = [
	"version",
	"outcome",
	"code",
	"recommendedClassification",
	"fallbackClassification",
	"recommendedRoute",
	"selectedRoute",
	"stage",
	"mode",
	"repo",
	"cwd",
	"sources",
	"canonicalIssue",
	"summary",
	"impactExample",
	"scope",
	"checklist",
	"evidence",
	"risks",
	"artifacts",
	"verdict",
] as const;

test("issue-triage has one equivalent artifact-aware contract in all existing harnesses", async () => {
	const interaction = parseInteractionDifferences(await readRepoFile("docs/harness-interaction-differences.md"));
	const blocks = new Map<Harness, string>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/issue-triage/SKILL.md`);
		blocks.set(harness, normalizeArtifactAwareBlock(artifactAwareBlock(markdown), harness, interaction));
		assert.doesNotMatch(markdown, /## Fase 6 — Ejecutar la ruta/);
		assert.doesNotMatch(markdown, /Creá un worktree hermano/);
		assert.doesNotMatch(markdown, /Cargá (?:completo )?(?:el skill )?[`~/.a-z-]*(?:grill|chiche-spec)\/SKILL\.md/);
	}
	assert.deepEqual(compareArtifactAwareBlocks(blocks), []);

	const contract = blocks.get("pi") ?? "";
	for (const route of REQUIRED_ROUTES) assert.match(contract, new RegExp(`\\b${route}\\b`), route);
	for (const field of REQUIRED_SCHEMA_FIELDS) assert.match(contract, new RegExp(`\\b${field}\\b`), field);
	for (const rule of [
		"parseSddArtifact",
		"CRLF",
		"Body original",
		"superseded-by",
		"fresh|stale|unknown",
		"parentId",
		"canonicalization",
		"selectedRoute=null",
		"JSON.parse(JSON.stringify(result))",
	]) {
		assert.ok(contract.includes(rule), rule);
	}
	assert.match(contract, /no ejecuta pasos de ningún stage/i);
	assert.match(contract, /en Claude, Codex y OpenCode lo encadena la Fase 7/);
	assert.match(contract, /en Pi lo abre el orquestador de `\/issues`/);
	assert.doesNotMatch(contract, /triage produce contexto y termina/);
});

test("artifact-aware gate reports injected route/schema drift", () => {
	const base = "route=run-existing-spec\nselectedRoute=null";
	const blocks = new Map<Harness, string>([
		["claude", base],
		["codex", base.replace("run-existing-spec", "update-existing-spec")],
		["opencode", base],
		["pi", base],
	]);
	assert.deepEqual(compareArtifactAwareBlocks(blocks), ["codex diverge de claude"]);
});

test("opencode issue-triage uses native skill loading and question gates with a blocking fallback", async () => {
	const markdown = await readRepoFile("opencode/issue-triage/SKILL.md");
	assert.match(markdown, /\/issue-triage #12/);
	assert.match(markdown, /tool `skill`/);
	assert.match(markdown, /`question`[^\n]*Fases 4 y 5/);
	assert.match(markdown, /Confirmar \(Recommended\)/);
	assert.match(markdown, /ruta completa[^\n]*`description`/);
	assert.match(markdown, /Si `question` no está disponible[^\n]*opciones numeradas[^\n]*terminá el turno[^\n]*esperá/);
	const actionable = markdown.split("### Rutas accionables\n")[1]?.split("## Fase 5")[0] ?? "";
	assert.match(actionable, /Con `question`[^\n]*labels[^\n]*Interacción en OpenCode/);
	assert.match(actionable, /En el fallback en texto plano[^\n]*opciones numeradas:/);
	assert.match(markdown, /Pasale sólo el nombre sin la barra[^\n]*`grill`[^\n]*`chiche-spec`[^\n]*`chiche-run`/);
	assert.match(markdown, /argumentos de invocación[^\n]*nunca como invocación pelada/);
	assert.match(markdown, /Si el skill no está instalado o su carga queda denegada[^\n]*comando exacto[^\n]*terminá/);
	assert.doesNotMatch(markdown, /AskUserQuestion|request_user_input|ask_user_question|submit_workflow_resolution|tool `Skill`/);
	assert.doesNotMatch(markdown, /\$sdd-|\/skill:|quick-run/);
});

const CHAINING_HARNESSES = ["claude", "codex", "opencode"] as const;

// Stage → skill dueño; las rutas salen del contrato que usa el orquestador de Pi.
const STAGE_SKILLS: Record<string, string> = {
	grill: "grill",
	spec: "chiche-spec",
	"run-existing-spec": "chiche-run",
};

const START_ROUTE_SKILLS: Record<string, string> = Object.fromEntries(
	Object.entries(ACTIONABLE_ROUTE_CONTRACT).map(([route, { stage }]) => [route, STAGE_SKILLS[stage]!]),
);

export function stageChainBlock(markdown: string): string {
	const match = markdown.match(/<!-- stage-chain:start -->\n([\s\S]*?)\n<!-- stage-chain:end -->/);
	assert.ok(match?.[1], "tabla normativa stage-chain presente");
	return match[1];
}

function stageChainRows(block: string): string[][] {
	return block.split("\n").filter((row) => row.startsWith("|")).slice(2)
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

export function stageChainRoutes(block: string, invocation: string): Map<string, string> {
	const routes = new Map<string, string>();
	for (const [routeCell = "", skillCell = ""] of stageChainRows(block)) {
		const skill = skillCell.replaceAll("`", "");
		for (const route of routeCell.matchAll(/`([a-z-]+)`/g)) {
			routes.set(route[1]!, skill.startsWith(invocation) ? skill.slice(invocation.length) : `?${skill}`);
		}
	}
	return routes;
}

export function stageChainArguments(block: string): Map<string, string> {
	const args = new Map<string, string>();
	for (const [routeCell = "", , argsCell = ""] of stageChainRows(block)) {
		for (const route of routeCell.matchAll(/`([a-z-]+)`/g)) args.set(route[1]!, argsCell);
	}
	return args;
}

test("issue-triage chains the confirmed stage in harnesses without orchestrator", async () => {
	const interaction = parseInteractionDifferences(await readRepoFile("docs/harness-interaction-differences.md"));
	const blocks = new Map<Harness, string>();
	for (const harness of CHAINING_HARNESSES) {
		const markdown = await readRepoFile(`${harness}/issue-triage/SKILL.md`);
		const block = stageChainBlock(markdown);
		const routes = stageChainRoutes(block, interaction.invocation[harness]);
		assert.deepEqual(Object.fromEntries(routes), START_ROUTE_SKILLS, `${harness}: mapeo ruta → skill`);
		const args = stageChainArguments(block);
		assert.match(args.get("spec-from-grill") ?? "", /--from-grill/);
		for (const route of ["update-existing-spec", "audit-existing-spec"]) {
			assert.match(args.get(route) ?? "", /--triage-route/, `${harness}: ${route} distingue update/audit`);
		}
		assert.match(markdown, /code=selectedRoute/);
		assert.match(markdown, /join-\*[^\n]*sin `canonicalIssue`[^\n]*no encadenes/);
		assert.match(markdown, /reescribe el body del issue/);
		blocks.set(harness, normalizeArtifactAwareBlock(block, harness, interaction));
		assert.match(markdown, /## Fase 7 — Encadenar el stage confirmado/);
		assert.doesNotMatch(markdown, /no autoriza a ejecutar el stage/);
		assert.doesNotMatch(markdown, /No invocar ni ejecutar grill, spec o run/);
		assert.match(markdown, /selectedRoute=null[^\n]*no encadenes/i);
	}
	for (const harness of CHAINING_HARNESSES.slice(1)) {
		assert.equal(blocks.get(harness), blocks.get("claude"), `${harness} diverge de claude en stage-chain`);
	}
});

test("codex issue-triage leaves run as a ready command because its sidecar forbids implicit invocation", async () => {
	const markdown = await readRepoFile("codex/issue-triage/SKILL.md");
	assert.match(markdown, /Excepción de Codex: `run-existing-spec` no se encadena/);
	const sidecar = await readRepoFile("codex/chiche-run/agents/openai.yaml");
	assert.match(sidecar, /allow_implicit_invocation:\s*false/, "chiche-run: la excepción de issue-triage depende de esta política");
});

test("chiche-spec advertises its full signature and the supported chained triage targets", async () => {
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		const signature = markdown.match(/## Argumentos\n\n```text\n([^\n]+)\n```/)?.[1];
		assert.ok(signature, `${harness}: firma de argumentos presente`);
		assert.ok(markdown.includes(`Atajo: ${signature} saltea este menu.`), `${harness}: atajo alineado con la firma`);
		assert.match(markdown, /Los argumentos[^\n]*una ruta de spec para actualizarla/, `${harness}: intro menciona la ruta de spec`);
		if (harness === "pi") continue;
		assert.match(markdown, /### Entrada encadenada desde issue-triage/, harness);
		assert.match(markdown, /\| ruta de spec\]/, `${harness}: firma acepta ruta de spec`);
		assert.match(markdown, /--triage-route update-existing-spec\|audit-existing-spec/, harness);
	}
});

test("chiche-spec preserves equivalent chained input safeguards in every chaining harness", async () => {
	const interaction = parseInteractionDifferences(await readRepoFile("docs/harness-interaction-differences.md"));
	const inputBlock = (markdown: string) => {
		const match = markdown.match(/### Entrada encadenada desde issue-triage\n([\s\S]*?)\n<!-- chiche-spec-drafts:start -->/);
		assert.ok(match?.[1], "entrada encadenada presente");
		return match[1];
	};
	const claude = inputBlock(await readRepoFile("claude/chiche-spec/SKILL.md"));
	for (const harness of CHAINING_HARNESSES.slice(1)) {
		const block = inputBlock(await readRepoFile(`${harness}/chiche-spec/SKILL.md`));
		assert.equal(
			normalizeArtifactAwareBlock(block, harness, interaction),
			normalizeArtifactAwareBlock(claude, "claude", interaction),
			`${harness}: entrada encadenada diverge de claude`,
		);
	}
});

test("both READMEs advertise issue-triage and its confirmed chaining in OpenCode", async () => {
	for (const path of ["README.md", "README.en.md"]) {
		const markdown = await readRepoFile(path);
		const row = markdown.split("\n").find((line) => line.startsWith("| **`issue-triage`**")) ?? "";
		assert.match(row, /Claude y OpenCode encadena el skill del stage|Claude and OpenCode chain the stage skill/, path);
		assert.match(row, /Disponible en los (?:cuatro|cinco) harnesses|Available in all (?:four|five) harnesses/, path);
		assert.doesNotMatch(row, /\*\(Codex\/Claude\/Pi\)\*/, path);
		assert.match(markdown, /(?:Para encadenar|Chaining)[^\n]*`grill`[^\n]*`chiche-spec`[^\n]*`chiche-run`/, `${path}: permisos de skills encadenados`);
		const permissionBlock = markdown.match(/```json\n(\{\n  "permission": \{[\s\S]*?\n\})\n```/)?.[1];
		assert.ok(permissionBlock, `${path}: ejemplo completo de permisos`);
		const rules = JSON.parse(permissionBlock).permission.skill;
		assert.equal(Object.keys(rules)[0], "*", `${path}: catch-all primero`);
		assert.equal(rules["*"], "deny", `${path}: deny por default`);
		for (const skill of ["issue-triage", "grill", "chiche-spec", "chiche-run"]) {
			assert.equal(rules[skill], "allow", `${path}: ${skill} habilitado después del catch-all`);
		}
	}
});

// Review #106, F1: quien copió la allowlist anterior (`sdd-spec`/`sdd-run`) con
// `"*": "deny"` pierde `chiche-*` al actualizar. La nota va junto al ejemplo y,
// desde 4.0.0 (CA-24), dice que esas entradas sobran porque los alias se retiraron.
const ALLOWLIST_MIGRATION_NOTE: Record<string, RegExp> = {
	"README.md": /Si venís de la versión anterior[^\n]*agregá `chiche-spec` y `chiche-run`[^\n]*`sdd-spec` y `sdd-run`[^\n]*retiraron en 4\.0\.0/,
	"README.en.md": /Coming from the previous version[^\n]*add `chiche-spec` and `chiche-run`[^\n]*`sdd-spec` and `sdd-run`[^\n]*retired in 4\.0\.0/,
};

test("both READMEs tell who copied the previous OpenCode allowlist to add chiche-spec and chiche-run", async () => {
	for (const [path, note] of Object.entries(ALLOWLIST_MIGRATION_NOTE)) {
		const markdown = await readRepoFile(path);
		const example = markdown.indexOf('"permission": {');
		const noteAt = markdown.search(note);
		const chainingAt = markdown.search(/(?:Para encadenar|Chaining)[^\n]*`grill`/);
		assert.ok(noteAt >= 0, `${path}: nota de migración de la allowlist`);
		assert.ok(example < noteAt && noteAt < chainingAt, `${path}: la nota va entre el ejemplo de permisos y el párrafo de encadenado`);
	}
});

test("pi issue-triage keeps chaining in the orchestrator, not in the skill", async () => {
	const markdown = await readRepoFile("pi/issue-triage/SKILL.md");
	assert.doesNotMatch(markdown, /<!-- stage-chain:start -->/);
	assert.match(markdown, /submit_workflow_resolution/);
});

test("stage-chain gate reports a route mapped to the wrong skill", () => {
	const block = [
		"| `selectedRoute` | Skill | Argumentos |",
		"|---|---|---|",
		"| `grill`, `join-grill` | `/chiche-spec` | `#<N>` |",
	].join("\n");
	assert.equal(stageChainRoutes(block, "/").get("join-grill"), "chiche-spec");
	assert.equal(stageChainRoutes(block, "$").get("grill"), "?/chiche-spec");
});

test("autotest: el normalizador de issue-triage no confunde una ruta .sdd/grills/ con la invocación /grill", async () => {
	const interaction = parseInteractionDifferences(await readRepoFile("docs/harness-interaction-differences.md"));
	assert.equal(
		normalizeArtifactAwareBlock("`/grill` y `<git-common-dir>/sdd/grills/`", "claude", interaction),
		"`«skill:grill»` y `<git-common-dir>/sdd/grills/`",
	);
});

test("autotest: question normalization only replaces the exact backticked tool in every harness", async () => {
	const interaction = parseInteractionDifferences(await readRepoFile("docs/harness-interaction-differences.md"));
	const literal = "question questions questionnaire AskUserQuestion request_user_input ask_user_question `questions` `question_count` `ask_user_questions`";
	for (const harness of HARNESSES) {
		const input = `Gate: \`${interaction.questionTool[harness]}\`\n${literal}`;
		assert.equal(
			normalizeArtifactAwareBlock(input, harness, interaction),
			`Gate: \`«question-tool»\`\n${literal}`,
			`${harness}: preserva prosa y otros identificadores`,
		);
	}
});

// Issue #130, CA-24 (reescribe los pins de #119 CA-15, CA-16 y CA-19): el triage imprime un veredicto para las
// rutas nuevas, que ya no decide niveles; el gate ofrece `→ hasta el PR` o confirmar solo esa etapa, y la tabla
// stage-chain agrega `--until pr` y ningún otro flag de autonomía.
const ALL_HARNESSES = [...HARNESSES, "antigravity"] as const;
const INVOCATION_PREFIX: Record<(typeof ALL_HARNESSES)[number], string> = { claude: "/", codex: "$", opencode: "/", pi: "/skill:", antigravity: "/" };
const VERDICT_BLOCK = [
	"Veredicto: <n> pregunta(s) de producto y <k> técnica(s) hasta el PR.",
	"- Te pregunto: <decisión> (<NN> %)        ← una línea por decisión de producto ≤ confianza grill",
	"- Asumo: <decisión> (<NN> %)              ← una línea por decisión de producto > confianza grill",
	"- Para la spec: <decisión> (<NN> %)       ← una línea por decisión técnica; la spec pregunta las ≤ confianza spec",
	"- Aviso: <riesgo de ejecución>            ← archivos tocados, tests del área; no suma preguntas",
].join("\n");

// Las palabras del dial viejo (brief de la capa 2 del issue #130). Los bloques compartidos `autonomy-controls` y
// `autonomy-resolve` las nombran para explicar el retiro: se sacan antes de buscar.
const RETIRED_DIAL_WORDS = /supervised|plan-approved|unattended|\bA[0-5]\b|--autonomy|Rehearsed|unrehearsed|umbral|nivel efectivo|Niveles de autonomía|Nivel efectivo|Nivel sugerido|supervisado|hasta la spec/;

export function withoutSharedAutonomyBlocks(markdown: string): string {
	let stripped = markdown;
	for (const name of ["autonomy-controls", "autonomy-resolve"]) {
		const block = new RegExp(`<!-- ${name}:start -->\\n[\\s\\S]*?\\n<!-- ${name}:end -->`);
		assert.match(stripped, block, `bloque compartido ${name} presente`);
		stripped = stripped.replace(block, "");
	}
	return stripped;
}

export function triageVerdictBlock(markdown: string): string {
	const match = markdown.match(/<!-- triage-verdict:start -->\n([\s\S]*?)\n<!-- triage-verdict:end -->/);
	assert.ok(match?.[1], "bloque triage-verdict presente");
	return match[1];
}

test("#130 CA-24: issue-triage no lleva flags de autonomía en la firma ni palabras del dial viejo fuera de los bloques compartidos, en los cinco harnesses", async () => {
	for (const harness of ALL_HARNESSES) {
		const markdown = await readRepoFile(`${harness}/issue-triage/SKILL.md`);
		const signature = markdown.match(/## Invocación\n\n```text\n([^\n]+)\n```/)?.[1];
		assert.equal(signature, `${INVOCATION_PREFIX[harness]}issue-triage #12 [#13 ... #N]`, `${harness}: la firma no lleva flags`);
		const own = withoutSharedAutonomyBlocks(markdown);
		for (const [index, line] of own.split("\n").entries()) {
			assert.doesNotMatch(line, RETIRED_DIAL_WORDS, `${harness}: palabra del dial viejo fuera de los bloques compartidos (línea ${index + 1} sin los bloques)`);
		}
		assert.match(own, /Este skill no lleva flags de autonomía: la confirmación de la ruta es humana siempre\./, `${harness}: la confirmación sigue siendo humana`);
		assert.match(own, /Ver «Controles de autonomía» y «Controles efectivos»\./, `${harness}: referencias cruzadas a los bloques nuevos`);
	}
});

test("autotest: withoutSharedAutonomyBlocks saca solo los dos bloques compartidos y exige que estén", () => {
	const markdown = [
		"firma --autonomy",
		"<!-- autonomy-controls:start -->",
		"`--autonomy` se retiró",
		"<!-- autonomy-controls:end -->",
		"<!-- autonomy-resolve:start -->",
		"supervised → usá --confidence 100",
		"<!-- autonomy-resolve:end -->",
		"<!-- triage-verdict:start -->",
		"umbral grill",
		"<!-- triage-verdict:end -->",
	].join("\n");
	const own = withoutSharedAutonomyBlocks(markdown);
	assert.match(own, /firma --autonomy/);
	assert.match(own, /umbral grill/);
	assert.doesNotMatch(own, /se retiró|supervised/);
	assert.match(own.split("\n")[0] ?? "", RETIRED_DIAL_WORDS);
	assert.throws(() => withoutSharedAutonomyBlocks("sin bloques"), /bloque compartido autonomy-controls presente/);
});

test("#130 CA-24: issue-triage imprime el bloque Veredicto literal para grill, spec y join-* antes del gate, lee las dos confianzas del resolver sin decidir niveles, y ofrece las cuatro opciones en orden, en los cinco harnesses con el bloque equivalente", async () => {
	const interaction = parseInteractionDifferences(await readRepoFile("docs/harness-interaction-differences.md"));
	const blocks = new Map<string, string>();
	for (const harness of ALL_HARNESSES) {
		const markdown = await readRepoFile(`${harness}/issue-triage/SKILL.md`);
		const block = triageVerdictBlock(markdown);
		assert.ok(block.includes(VERDICT_BLOCK), `${harness}: el bloque Veredicto no es el literal de la spec`);
		for (const rule of [
			/`grill`, `spec`, `join-grill` o `join-spec`/,
			/su tipo \(`producto` define el qué, `técnica` define el cómo\) y una confianza entera `NN %`/,
			/lee las líneas `confianza grill:` y `confianza spec:` que imprime el resolver de «Controles efectivos»/,
			/`n` \(decisiones de producto con confianza `≤ confianza grill`\) y `k` \(decisiones técnicas con confianza `≤ confianza spec`\)/,
			/`grill` cuando `n > 0`, `spec` cuando `n = 0`/,
			/Las rutas de rechazo y las artifact-aware no llevan veredicto/,
			/promesa de esfuerzo, no un contrato: mandan el grill y la spec reales/,
			/No decide ni cambia ningún control/,
			/`verdict` \(`until` siempre `"pr"`, `thresholds` con las dos confianzas leídas del resolver/,
			/`accepted` en `true` solo si el humano eligió `Confirmar <ruta> → hasta el PR`/,
		]) assert.match(block, rule, `${harness}: ${rule}`);
		assert.doesNotMatch(block, RETIRED_DIAL_WORDS, `${harness}: el veredicto ya no decide niveles ni promete «hasta la spec»`);
		const actionable = markdown.split("### Rutas accionables\n")[1]?.split("## Fase 5")[0] ?? "";
		const options = ["`Confirmar <ruta> → hasta el PR (Recomendado)`", "`Confirmar <ruta>`", "`Usar fallback: <ruta>`", "`Cancelar`"];
		let cursor = -1;
		for (const option of options) {
			const at = actionable.indexOf(option);
			assert.ok(at > cursor, `${harness}: la opción ${option} falta o está fuera de orden`);
			cursor = at;
		}
		const withVerdict = actionable.split("Con veredicto (rutas nuevas), en este orden:\n\n")[1]?.split("\n\n")[0] ?? "";
		assert.deepEqual(withVerdict.split("\n"), options.map((option) => `- ${option}`), `${harness}: el gate con veredicto ofrece exactamente las cuatro opciones`);
		assert.match(actionable, /sin veredicto[^\n]*`Confirmar <ruta recomendada> \(Recomendado\)` \/ `Usar fallback: <ruta>` \/ `Cancelar`/, `${harness}: las rutas artifact-aware conservan el gate de hoy, sin → hasta`);
		assert.match(actionable, /`→ hasta el PR` agrega `--until pr` a los argumentos de la ruta \(tabla `stage-chain`\)/, `${harness}: → hasta el PR es la cadena`);
		assert.match(actionable, /la descripción de la opción dice que la cadena no cambia la confianza ni la posición del run y que la stop list sigue rigiendo/, `${harness}: la opción no impone valores`);
		assert.match(actionable, /`Confirmar <ruta>` a secas encadena solo esa etapa, sin flags/, `${harness}: confirmar a secas`);
		assert.match(actionable, /`accepted` es `true` solo con `Confirmar <ruta> → hasta el PR`; `Confirmar <ruta>` y fallback lo dejan en `false`/, `${harness}: accepted true solo con → hasta el PR`);
		// Review #125-2: cancelar emite verdict null.
		assert.match(actionable, /cancelar emite `verdict: null`/, `${harness}: cancelar no deja accepted false`);
		if (harness === "codex") assert.match(actionable, /En Codex, `→ hasta el PR` termina con el comando `\$chiche-run <target>` listo para enviar/, "codex: hasta el PR no termina en PR");
		if (harness === "pi") assert.match(actionable, /En Pi, el orquestador de `\/issues` arma los argumentos desde `verdict` y `accepted` al despachar la resolución: agrega `--until pr` solo con `accepted: true` y ningún otro flag/, "pi: el orquestador arma la cadena");
		if (harness === "opencode") assert.match(markdown, /`Confirmar → hasta el PR \(Recommended\)` y `Confirmar` con veredicto; `Confirmar \(Recommended\)` sin veredicto; `Usar fallback`, `Cancelar`/, "opencode: labels cortos del gate");
		blocks.set(harness, harness === "antigravity" ? block : normalizeArtifactAwareBlock(block, harness as Harness, interaction));
	}
	// Review #125-6: Antigravity también se compara (su bloque no lleva invocaciones ni tool, así que el crudo es el normalizado).
	for (const harness of ALL_HARNESSES.slice(1)) assert.equal(blocks.get(harness), blocks.get("claude"), `${harness} diverge de claude en triage-verdict`);
});

const STAGE_CHAIN_HARNESSES = [...CHAINING_HARNESSES, "antigravity"] as const;
const UNTIL_ROUTES = ["grill", "join-grill", "spec", "join-spec"] as const;

test("#130 CA-24: la tabla stage-chain agrega --until pr solo a grill, join-grill, spec y join-spec con → hasta el PR y ningún otro flag de autonomía, y WorkflowResolutionV1 declara verdict con until \"pr\" en el contrato de los cinco", async () => {
	for (const harness of STAGE_CHAIN_HARNESSES) {
		const markdown = await readRepoFile(`${harness}/issue-triage/SKILL.md`);
		const block = stageChainBlock(markdown);
		const args = stageChainArguments(block);
		assert.deepEqual([...args.keys()].sort(), Object.keys(START_ROUTE_SKILLS).sort(), `${harness}: la tabla cubre todas las rutas accionables`);
		for (const [route, cell] of args) {
			if ((UNTIL_ROUTES as readonly string[]).includes(route)) {
				assert.equal(cell, "`#<N>` del issue efectivo; con `Confirmar → hasta el PR`, más `--until pr`", `${harness}: ${route} agrega --until pr solo con → hasta el PR`);
			} else {
				assert.doesNotMatch(cell, /--until/, `${harness}: ${route} no lleva --until`);
			}
			assert.doesNotMatch(cell, /--autonomy|--confidence|--mode|supervisado|hasta la spec|\bA[0-5]\b|<level>/, `${harness}: ${route} lleva otro flag de autonomía`);
		}
		assert.equal(args.get("resume-grill"), "ruta del handoff del grill primario para retomar", `${harness}: resume-grill`);
		assert.equal(args.get("spec-from-grill"), "`--from-grill <ruta del handoff finalized primario>`", `${harness}: spec-from-grill`);
		assert.equal(args.get("update-existing-spec"), "ruta de la spec primaria local, o `#<N>` si vive en el issue, más `--triage-route <ruta>`", `${harness}: update-existing-spec`);
		assert.equal(args.get("audit-existing-spec"), args.get("update-existing-spec"), `${harness}: audit-existing-spec`);
		assert.equal(args.get("run-existing-spec"), "ruta de la spec primaria local, o `#<N>` si vive en el issue", `${harness}: run-existing-spec`);
		assert.match(markdown, /`--until pr` es el único flag de autonomía que agrega este skill[^\n]*ninguna ruta lleva `--confidence` ni `--mode`: el skill encadenado lee sus controles del contrato/, `${harness}: la regla de flags de la Fase 7`);
	}
	for (const harness of ALL_HARNESSES) {
		const markdown = await readRepoFile(`${harness}/issue-triage/SKILL.md`);
		const contract = artifactAwareBlock(markdown);
		assert.match(contract, /type WorkflowResolutionV1 = \{\n  version: 1;/, `${harness}: version 1 intacta`);
		assert.match(contract, /verdict: WorkflowVerdict \| null;/, `${harness}: el tipo declara verdict`);
		assert.match(contract, /type VerdictItem = \{ text: string; confidence: number \}/, `${harness}: VerdictItem`);
		assert.match(contract, /type WorkflowVerdict = \{ until: "pr"; accepted: boolean; thresholds: \{ grill: number; spec: number \}; questions: VerdictItem\[\]; assumed: VerdictItem\[\]; forSpec: VerdictItem\[\]; warnings: string\[\] \};/, `${harness}: WorkflowVerdict`);
		assert.doesNotMatch(contract, /"spec"; accepted/, `${harness}: until ya no acepta "spec"`);
		assert.match(contract, /`thresholds` conserva su nombre y lleva `confianza grill` y `confianza spec`, enteros de 0 a 100 como `confidence`/, `${harness}: thresholds lleva las dos confianzas`);
		assert.match(contract, /`until` es siempre `"pr"`; `accepted` es `true` solo con `Confirmar <ruta> → hasta el PR`\./, `${harness}: until y accepted`);
		assert.match(contract, /un `until` distinto de `"pr"` o un veredicto incoherente \(`questions` lleva solo confianzas `≤ thresholds.grill` y `assumed` solo `> thresholds.grill`\) es `invalid-value`/, `${harness}: la prosa del tipo fija la coherencia (review #125-4)`);
		assert.doesNotMatch(contract, RETIRED_DIAL_WORDS, `${harness}: el contrato no nombra el dial viejo`);
	}
});

test("#130 CA-24 y CA-27: las filas issue-triage de los dos README nombran el veredicto, → hasta el PR con --until pr y la confirmación de solo esa etapa, sin niveles", async () => {
	for (const path of ["README.md", "README.en.md"]) {
		const row = (await readRepoFile(path)).split("\n").find((line) => line.startsWith("| **`issue-triage`**")) ?? "";
		for (const pattern of [/`Veredicto:`/, /`Confirmar → hasta el PR`/, /`Confirmar <ruta>`/, /`--until pr`/]) assert.match(row, pattern, `${path}: ${pattern}`);
		assert.doesNotMatch(row, RETIRED_DIAL_WORDS, `${path}: la fila nombra el dial viejo`);
		assert.doesNotMatch(row, /la spec>`/, `${path}: la fila conserva «→ hasta la spec»`);
	}
});

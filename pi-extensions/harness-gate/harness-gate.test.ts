// Gate anti-drift de los productores SDD (issue #10).
//
// Extrae los templates de artefactos con marker Chiche-Tracking de los 16
// SKILL.md ({claude,codex,opencode,pi} × {chiche-init,chiche-spec,chiche-run,grill}),
// valida cada template contra el contrato docs/chiche-tracking-v2.md usando el
// parser de referencia (chiche-artifacts), y exige igualdad byte a byte entre
// harnesses tolerando SOLO las diferencias documentadas en
// docs/harness-interaction-differences.md. El censo lee los dos markers
// (`SDD-Tracking` v1 y `Chiche-Tracking` v2), pero un template de artefacto
// nuevo con `SDD-Tracking: version=1` es un defecto (issue #103, CA-13).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseSddArtifact } from "../chiche-artifacts/index.ts";
import type { Fence, Harness } from "./interaction.ts";
import {
	HARNESSES,
	POSITIONAL_PARAMETER,
	fencedBlocks,
	firstDifference,
	escapeRegExp,
	normalizeInvocations,
	parseInteractionTable,
} from "./interaction.ts";

const SKILLS = ["chiche-init", "chiche-spec", "chiche-run", "grill"] as const;
type Skill = (typeof SKILLS)[number];

type TemplateType = "spec" | "grill" | "project";

// Cuantos templates de marker exige cada skill, por tipo de artefacto.
const EXPECTED_TEMPLATES: Record<Skill, Record<TemplateType, number>> = {
	"chiche-init": { spec: 0, grill: 0, project: 1 },
	"chiche-spec": { spec: 2, grill: 0, project: 0 },
	"chiche-run": { spec: 1, grill: 0, project: 0 },
	grill: { spec: 0, grill: 1, project: 0 },
};

// Forma que debe declarar cada template, en orden de aparicion.
const EXPECTED_SHAPES: Record<Skill, RegExp[]> = {
	"chiche-init": [/type=project; generated-at=<YYYY-MM-DD>/],
	"chiche-spec": [
		/type=spec; state=<draft\|approved>; .*superseded-by=none/,
		/type=spec; state=superseded; .*superseded-by=<ref>/,
	],
	"chiche-run": [/type=spec; state=implemented; .*superseded-by=none/],
	grill: [/type=grill; state=<paused\|finalized>; /],
};

const EXPECTED_ARTIFACT_TYPE: Record<Skill, TemplateType> = {
	"chiche-init": "project",
	"chiche-spec": "spec",
	"chiche-run": "spec",
	grill: "grill",
};

const SDD_RUN_DIRTY_CHECKOUT_DOCTRINE = [
	/checkout sucio no bloquea por sí solo/i,
	/referencia remota actualizada/i,
	/artefactos de entrada del workflow/i,
	/spec target local/i,
	/`\.chiche\/project\.md`/,
	/handoff canónico/i,
	/`CONTEXT\.md`[\s\S]*`docs\/adr\/`/,
	/cambios locales restantes[\s\S]*excluidos[\s\S]*no abortan/i,
	/PRIMER commit/i,
	/checkout original queda intacto/i,
	/prerrequisito faltante o una desviación/i,
];

const FEEDBACK_REMEDIATION_DOCTRINE = [
	/## Fase 6 — Seguimiento y resolución automática del feedback del PR/,
	/Run completo[\s\S]*PR creado/,
	// Issue #102 CA-11, issue #130 CA-20: con `pr` o `pr-reviewed` no se pregunta; «Por posición» fija la conducta.
	/Con `pr` o `pr-reviewed` no se pregunta: ver «Por posición»/,
	/\*\*Por posición\.\*\*[^\n]*Con `pr` no se pregunta[^\n]*termina sin esperar[^\n]*Con `pr-reviewed` no se pregunta[^\n]*hasta 2 rondas[^\n]*30 minutos sin feedback nuevo[^\n]*`Feedback resuelto`[^\n]*`SEGUIMIENTO DE FEEDBACK DETENIDO`/,
	/ID estable \+ `updatedAt`/,
	/threads por `thread\.id` \+ `isResolved`/,
	/conversaci[oó]n[\s\S]*reviews[\s\S]*comentarios inline/,
	/polling[\s\S]*60 segundos[\s\S]*primer plano/,
	/Resolver feedback automáticamente/,
	/autoriza[\s\S]*editar[\s\S]*commitear[\s\S]*pushear[\s\S]*responder[\s\S]*resolver threads/i,
	/validar cada planteo[\s\S]*código[\s\S]*spec[\s\S]*contrato/i,
	/worktree[\s\S]*headRefOid[\s\S]*branch del PR/i,
	/test de regresión[\s\S]*fallar[\s\S]*regresión completa/i,
	/push[\s\S]*mismo branch[\s\S]*force-push/i,
	/resolver[\s\S]*thread[\s\S]*push[\s\S]*verde/i,
	/refrescar[\s\S]*snapshot[\s\S]*respuestas propias[\s\S]*polling/i,
	/ambiguo[\s\S]*fuera de alcance[\s\S]*confirmaci[oó]n expl[ií]cita/i,
	/`Feedback resuelto` solo si[\s\S]*no hay bloqueos[\s\S]*`SEGUIMIENTO DE FEEDBACK DETENIDO`/i,
];

const SDD_SPEC_PUBLICATION_DOCTRINE = [
	/`parseSddArtifact`/,
	/`kind=metadata`[\s\S]*`format=canonical`[\s\S]*`type=spec`/,
	/siempre[\s\S]*`state=draft`[\s\S]*`state=approved`[\s\S]*eleg[\s\S]*run/i,
	/identidad semántica[\s\S]*issue[\s\S]*grill decodificado exacto/i,
	/precheck[\s\S]*antes de cualquier mutación/i,
	/releer[\s\S]*cada destino[\s\S]*misma postcondición/i,
	/`Llevar a issue`[\s\S]*equivalencia normativa/i,
	/transición a `state=approved`[\s\S]*mismo gate/i,
	/staging no-SDD[\s\S]*issue nueva/i,
	/predecesoras[\s\S]*`state=superseded`[\s\S]*`superseded-by`/i,
	/receipt exitoso[\s\S]*`Spec lista`/i,
];

// Issue #45: chiche-spec avanza sin preguntar y cierra con un menú; doctrina
// idéntica entre harnesses dentro del bloque `chiche-spec-flow`.
const SDD_SPEC_FLOW_DOCTRINE = [
	// Review #123-9 → issue #130, CA-17: solo lo que supera la confianza de la etapa se escribe sin preguntar.
	/inferencias técnicas nuevas con confianza `> confianza spec` van a la tabla de la spec marcadas `\[ASSUMED NN %\]` sin preguntar, y solo las de confianza `≤ confianza spec` y las fugas con esa misma regla se preguntan antes de publicar/,
	/decisiones del handoff[\s\S]*confirmadas/i,
	/mecanismo[\s\S]*propuesto[\s\S]*alternativas[\s\S]*sin preguntar/i,
	/`--out`[\s\S]*fuerza/i,
	// Review de #105 (F7): Pi publica las issue-specs nuevas con `Chiche-Tracking`, así que se buscan las dos marcas.
	/`gh issue list --state all --limit 50 --search "SDD-Tracking in:body"` o `gh issue list --state all --limit 50 --search "Chiche-Tracking in:body"` devuelve al menos uno/,
	// Spec #84, CA-14 e issue #103, CA-5: el destino local es el common-dir de chiche, fuera del working tree.
	/`<git-common-dir>\/chiche\/specs\/<slug>\.md`/,
	/staging no-SDD/,
	/`Llevar a issue`/,
	/`Solicitar cambios`/,
	/`chiche-run --mode pr-reviewed`[\s\S]*harnesses con subagentes lo delega en un `implementer`/,
	/`state=approved`[\s\S]*antes de lanzar/i,
	/comments[\s\S]*posteriores[\s\S]*última publicación/i,
	/--paginate/,
	/`updated_at`/,
	/vuelve al menú/i,
	// Issue #130, CA-17: por debajo de 100 no hay menú; la regla de `approved` conserva sus tres transiciones;
	// `--until pr` no exige nada y lanza el run sin flags.
	/Por debajo de 100: el destino sigue la misma regla y no hay menú/,
	/Pasa a `aprobada` \(`state=approved`\) solo cuando el usuario elige correrla desde el menú \(confianza `100`\) o, por debajo de 100, al responder al menos una pregunta \(una técnica con confianza `≤ confianza spec` o una fuga\), o, con `--until pr`, al publicarse/,
	/Con `--until pr`, sea cual sea la confianza: la spec se publica `draft`, pasa a `state=approved` bajo el mismo gate de publicación, registra `spec\.published` y `spec\.approved`, y la corrida lanza `chiche-run <target>` sin flags, exactamente como la opción `chiche-run` del menú, sin preguntar y sin `--until pr`/,
	/`--until pr` no exige ni cambia la confianza: con `100` la spec pregunta todo, no muestra el menú, aprueba y lanza el run; una fuga no frena la cadena/,
	/Sin `--until pr` la corrida termina en `Spec lista`/,
];

// Issue #45: chiche-run imprime el plan y sigue, desvía sin preguntar cuando no
// cambia el alcance y ofrece code review post-PR. Bloque `chiche-run-flow`.
const SDD_RUN_FLOW_DOCTRINE = [
	/imprimir el plan y seguir/i,
	/choca con la spec o con una política/i,
	/`\[DEVIATION\]`[\s\S]*cambia el alcance[\s\S]*preguntar/i,
	/una sola spec candidata \(estado `draft` o `aprobada`/i,
	/`draft`[\s\S]*aprobada al correr/i,
	/`Code review`/,
	/`\.github\/workflows\/claude-review\.yml`[\s\S]*`workflow_dispatch`/,
	/gh workflow run claude-review\.yml -f pr=<N>/,
	/subagente `reviewer`[\s\S]*code review nativo[\s\S]*`--comment`/,
	/sin GHA[\s\S]*no aparece/i,
	/encadena[\s\S]*Fase 6/i,
];

// Hallazgo 3 del review de PR #46: la rama de `Code review` diverge por
// harness (subagente en Claude y, desde el issue #44, en Pi via la tool
// `subagent`) y cada una tiene que quedar gateada.
const CODE_REVIEW_BRANCH: Record<Harness, RegExp> = {
	claude: /`Code review` en Claude Code[\s\S]*`workflow_dispatch`[\s\S]*subagent_type: "reviewer"[\s\S]*`\/code-review --comment`/,
	codex: /`Code review` en Codex[\s\S]*sin subagentes[\s\S]*solo (?:aparece )?(?:si|por GHA)[\s\S]*`workflow_dispatch`/i,
	opencode: /`Code review` en opencode[\s\S]*sin subagentes[\s\S]*solo (?:aparece )?(?:si|por GHA)[\s\S]*`workflow_dispatch`/i,
	pi: /`Code review` en Pi[\s\S]*`workflow_dispatch`[\s\S]*`subagent`[\s\S]*`reviewer`[\s\S]*`\/skill:code-review`/,
	antigravity: /`Code review` en Antigravity[\s\S]*`workflow_dispatch`[\s\S]*invoke_subagent[\s\S]*`\/code-review <PR>`/,
};

// Hallazgo 10 del review de PR #46: en codex y opencode la oferta califica
// `Code review` inline como GHA-only. Pi dejo de calificarla (issue #44).
const CODE_REVIEW_OFFER_QUALIFIED = /`Code review` \(solo con GHA\)/;

// Issue #44: la exploracion de la Fase 2 en Pi delega en subagentes `scout`
// via la tool `subagent`, espejo de los `Explore` de Claude.
const PI_SCOUT_EXPLORATION = /subagentes `scout` con la tool `subagent`/;
// Tope de la exploracion con scouts: sin cantidad maxima ni exhaustividad
// explicita, el agente lanzaba 4 scouts con tasks abiertos que hacian cientos
// de lecturas y bloqueaban la sesion.
const PI_SCOUT_BUDGET_RUN = /como máximo 2[\s\S]{0,120}`Rápida`[\s\S]{0,400}Nunca pedir "explorá el worktree"[\s\S]{0,200}`failed \(timeout\)`[\s\S]{0,80}`Agent timeout`/;
const PI_SCOUT_BUDGET_RUN_OVERFLOW = /más de 2 áreas[\s\S]{0,120}2 de mayor blast radius[\s\S]{0,60}resto inline/;
const PI_SCOUT_BUDGET_SPEC = /como máximo 3[\s\S]{0,200}nunca `Exhaustiva`[\s\S]{0,400}Nunca un task abierto[\s\S]{0,200}`failed \(timeout\)`[\s\S]{0,80}`Agent timeout`/;

const FEEDBACK_REMEDIATION_QUESTION_STYLE: Record<Harness, RegExp> = {
	claude: /usar `AskUserQuestion`[\s\S]*Resolver feedback automáticamente/,
	codex: /usar `request_user_input`[\s\S]*texto plano[\s\S]*Resolver feedback automáticamente/,
	opencode: /preguntar en texto plano[\s\S]*terminar el turno[\s\S]*Resolver feedback automáticamente/,
	pi: /usar `ask_user_question`[\s\S]*Resolver feedback automáticamente/,
	antigravity: /usar `ask_question`[\s\S]*Resolver feedback automáticamente/,
};

// grill: rondas por frontera de dependencias y hechos sin bloqueo en los
// cuatro harnesses; el atajo liviano vive en claude, codex y opencode.
const GRILL_ROUNDS_DOCTRINE = [
	/frontera de dependencias/,
	/(?:acopladas de hecho|cambiaría cómo se formula otra)[\s\S]{0,200}ronda siguiente/,
	/[Rr]ecalculá la frontera/,
];
const GRILL_NON_BLOCKING_FACTS_DOCTRINE = [
	/los hechos los averigua el agente, nunca el usuario/i,
	/solo esperan las preguntas que dependen de ese hecho/i,
	/el resto de la frontera se pregunta ya/i,
	/toda la frontera depende de hechos pendientes[\s\S]{0,200}ronda vacía/i,
	/exploración falla o vence[\s\S]{0,300}supuesto visible/i,
];
const GRILL_LIGHT_SHORTCUT = /### Atajo liviano \(1 a 3 preguntas\)/;
const GRILL_LIGHT_SHORTCUT_HARNESSES: readonly Harness[] = ["claude", "codex", "opencode", "antigravity"];
const GRILL_FACT_EXPLORATION: Record<Harness, RegExp> = {
	claude: /`Agent`[\s\S]{0,80}`Explore`[\s\S]{0,80}background/,
	codex: /subagente `explorer`[\s\S]{0,400}misma ronda/,
	opencode: /subagente `explore`[\s\S]{0,80}`task`[\s\S]{0,400}misma ronda/,
	pi: /`subagent`[\s\S]{0,80}`scout`[\s\S]{0,80}`background: true`/,
	antigravity: /`invoke_subagent`[\s\S]{0,80}`research`[\s\S]{0,80}background/,
};

// Stacks de PRs por spec (issue #66, CA-1/CA-2): `chiche-spec` propone el corte
// en capas dentro de la spec; doctrina idéntica entre harnesses dentro del
// bloque `chiche-spec-delivery`.
const SDD_SPEC_DELIVERY_DOCTRINE = [
	/`## Plan de entrega`[\s\S]*`\| Capa \| Etapa \| CAs \| Justificacion \|`/,
	/cada capa es un grupo coherente de CAs[\s\S]*tests dan verde solos[\s\S]*regresión completa/i,
	/tamaño máximo de PR[\s\S]*activo[\s\S]*cada capa entra en el límite/i,
	/una sola capa[\s\S]*todo entra en un PR/i,
	/propuesta se escribe sin preguntar[\s\S]*`Solicitar cambios`/i,
];

// Stacks de PRs por spec (issue #66, CA-3 a CA-9): `chiche-run` entrega un stack
// nativo de GitHub cuando el Plan de entrega tiene 2 o más capas. Bloque
// `chiche-run-stack`, idéntico entre harnesses.
const SDD_RUN_STACK_DOCTRINE = [
	// CA-3: preflight
	/`## Plan de entrega` de 2 o más capas[\s\S]*`gh` ≥ 2\.90\.0[\s\S]*`git` ≥ 2\.36[\s\S]*`github\/gh-stack`[\s\S]*`gh extension list`/,
	/con `ask`, ofrecer `gh extension install github\/gh-stack` ahí mismo/,
	/con `pr` o `pr-reviewed` frena antes de ramificar[\s\S]*comando exacto/,
	/una sola capa[\s\S]*nada cambia/i,
	// CA-4: ramificado
	/`gh stack init -b <base> sdd\/<slug>\/1-<etapa>`[\s\S]*`\.\.\/<repo>-sdd-<slug>`/,
	/`gh stack add sdd\/<slug>\/<n>-<etapa>`/,
	/no existe el branch pelado `sdd\/<slug>`/,
	/cualquier ref `sdd\/<slug>` o `sdd\/<slug>\/\*`[\s\S]*bloqueo de Fase 1\.4/,
	/slug kebab de hasta 20 caracteres[\s\S]*`Etapa`/,
	// CA-5: verificación por capa
	/antes de `gh stack add`[\s\S]*CAs verificados con su mecanismo[\s\S]*regresión completa[\s\S]*escalera del contrato hasta su techo/,
	/receipt Git por capa[\s\S]*`git diff --name-status <base de la capa>\.\.HEAD`/,
	/CA en FALLA congela su capa[\s\S]*no se abren[\s\S]*el reporte lo dice/,
	// CA-6: resultado por capa
	/`Capa` = `n\/N`[\s\S]*`1\/1` sin stack/,
	/su propio branch/,
	/`state=implemented`[\s\S]*solo en la capa top/,
	// CA-7: publicación
	/`gh stack submit --auto --open`[\s\S]*`gh pr edit --body-file`/,
	/de abajo lleva la spec completa[\s\S]*checklist humano[\s\S]*`Refs #NN`[\s\S]*PR top lleva `Closes #NN`[\s\S]*GitHub cierra el issue solo cuando aterriza la capa top/,
	/checklist humano del PR de abajo suma «verificar que GitHub cierra el issue al mergear la capa top»/,
	/`Capa n\/N del stack · spec en #<PR de abajo>`/,
	/`<título de la spec> — capa n\/N: <etapa>`/,
	/política de generación en FALLA[\s\S]*draft solo la capa que la viola[\s\S]*`gh pr ready --undo`/,
	/`--no-pr`[\s\S]*sin `submit`/,
	/Sigue sin mergear/,
	// CA-8: seguimiento
	/Fase 6[\s\S]*todos los PRs del stack de abajo hacia arriba/,
	/`Code review`[\s\S]*por cada PR/,
	/capa baja[\s\S]*`gh stack sync`[\s\S]*restackear/,
	/worktree del stack se retiene[\s\S]*`Terminar`[\s\S]*solo si está limpio/,
	// Remediación de review PR #67: conflicto de restack y trunk local
	/Si `gh stack sync` o `gh stack rebase` frenan por conflicto, no se resuelve a ciegas[\s\S]*`gh stack rebase --abort`[\s\S]*sin operación a medias[\s\S]*pendiente humano con el comando/,
	/`gh stack sync` no puede fast-forwardear el trunk local[\s\S]*checkouteado y sucio en el checkout original[\s\S]*frena con diagnóstico/,
	// CA-9: force
	/único force permitido es el `--force-with-lease`[\s\S]*`gh stack push`[\s\S]*`gh stack sync`[\s\S]*`gh stack rebase`[\s\S]*`sdd\/<slug>\/\*`/,
	/`git push --force` y `--force-with-lease` a mano siguen prohibidos/,
];

// Valores concretos para instanciar placeholders de un template de marker.
const PLACEHOLDER_SAMPLE: Record<string, string> = {
	"#NN": "#12",
	"owner/repo#NN": "owner/repo#12",
	ref: "some-ref",
	"YYYY-MM-DD": "2026-08-08",
};

const MARKER_LINE = /^[ \t]*<!--\s*(?:SDD|Chiche)-Tracking\s*:.*-->[ \t]*$/i;
const V1_MARKER = /^<!--\s*SDD-Tracking\s*:/i;
const V2_TEMPLATE_PREFIX = "<!-- Chiche-Tracking: version=2; ";

function repoFile(path: string): URL {
	return new URL(`../../${path}`, import.meta.url);
}

async function readRepoFile(path: string): Promise<string> {
	return await readFile(repoFile(path), "utf8");
}

interface CanonicalTemplate {
	line: string;
	type: TemplateType | null;
	fenceLine: number;
}

interface Census {
	canonical: CanonicalTemplate[];
	legacy: { line: string; fenceLine: number }[];
	// Templates que todavía instruyen `SDD-Tracking`: un artefacto nuevo nace v2.
	v1: { line: string; fenceLine: number }[];
	markerFences: Fence[];
}

export function censusTemplates(markdown: string): Census {
	const canonical: CanonicalTemplate[] = [];
	const legacy: { line: string; fenceLine: number }[] = [];
	const v1: { line: string; fenceLine: number }[] = [];
	const markerFences: Fence[] = [];
	for (const fence of fencedBlocks(markdown)) {
		const markers = fence.content.split("\n").filter((line) => MARKER_LINE.test(line));
		if (markers.length === 0) continue;
		markerFences.push(fence);
		for (const raw of markers) {
			const line = raw.trim();
			if (/\bversion\s*=/i.test(line) || /\btype\s*=/i.test(line)) {
				const type = line.match(/\btype=(spec|grill|project)\b/)?.[1] as TemplateType | undefined;
				canonical.push({ line, type: type ?? null, fenceLine: fence.line });
				if (V1_MARKER.test(line)) v1.push({ line, fenceLine: fence.line });
			} else {
				legacy.push({ line, fenceLine: fence.line });
			}
		}
	}
	return { canonical, legacy, v1, markerFences };
}

export function instantiations(template: string): string[] {
	const matches = [...template.matchAll(/<([^<>]+)>/g)];
	if (matches.length === 0) return [template];
	const alternativesAt = matches.map((match) =>
		(match[1] ?? "").split("|").map((alt) => PLACEHOLDER_SAMPLE[alt.trim()] ?? alt.trim()),
	);
	const build = (choices: number[]): string => {
		let result = "";
		let cursor = 0;
		matches.forEach((match, index) => {
			result += template.slice(cursor, match.index) + (alternativesAt[index] ?? [])[choices[index] ?? 0];
			cursor = (match.index ?? 0) + match[0].length;
		});
		return result + template.slice(cursor);
	};
	const variants = new Set<string>();
	matches.forEach((_match, position) => {
		(alternativesAt[position] ?? []).forEach((_alternative, choice) => {
			const choices = matches.map(() => 0);
			choices[position] = choice;
			variants.add(build(choices));
		});
	});
	return [...variants];
}

interface TemplateVerdict {
	ok: boolean;
	problems: string[];
}

export function validateTemplateLine(line: string, expectedType: TemplateType): TemplateVerdict {
	const problems: string[] = [];
	for (const variant of instantiations(line)) {
		const document = `# Artefacto\n${variant}\n\n## Cuerpo\nContenido.\n`;
		const parsed = parseSddArtifact(document);
		if (parsed.kind !== "metadata" || parsed.format !== "canonical") {
			const diagnostics = parsed.diagnostics
				.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
				.join("; ");
			problems.push(`instancia no canonica \`${variant}\` (kind=${parsed.kind}) — ${diagnostics}`);
			continue;
		}
		if (parsed.metadata.type !== expectedType) {
			problems.push(`instancia \`${variant}\` parsea como type=${parsed.metadata.type}, esperado ${expectedType}`);
		}
		if (parsed.markerName !== "Chiche-Tracking" || parsed.version !== 2) {
			problems.push(`instancia \`${variant}\` es un template ${parsed.markerName} v${parsed.version}: los artefactos nuevos nacen Chiche-Tracking: version=2`);
		}
	}
	return { ok: problems.length === 0, problems };
}

// Issue #102 CA-4: el bloque compartido `autonomy-resolve` (gateado por autonomy-gate) nombra el fallback
// `.sdd/project.md` en su prosa y en su comando canónico; los conteos de «una sola frase de fallback» lo excluyen.
function withoutAutonomyResolve(markdown: string): string {
	return markdown.replace(/<!-- autonomy-resolve:start -->\n[\s\S]*?\n<!-- autonomy-resolve:end -->/, "");
}

function delimitedDoctrine(markdown: string, name: string): string {
	const block = markdown.match(new RegExp(`<!-- ${name}:start -->\\n([\\s\\S]*?)\\n<!-- ${name}:end -->`));
	assert.ok(block, `bloque delimitado ${name} presente`);
	return block[1] ?? "";
}

export function compareTemplates(skill: string, byHarness: Map<Harness, string[]>): string[] {
	const divergences: string[] = [];
	const [reference, ...rest] = HARNESSES;
	const referenceTemplates = byHarness.get(reference) ?? [];
	for (const harness of rest) {
		const templates = byHarness.get(harness) ?? [];
		if (templates.length !== referenceTemplates.length) {
			divergences.push(
				`${skill}: ${reference} tiene ${referenceTemplates.length} templates y ${harness} tiene ${templates.length}`,
			);
			continue;
		}
		referenceTemplates.forEach((template, index) => {
			const other = templates[index] ?? "";
			if (template !== other) {
				divergences.push(
					`${skill}: template #${index + 1} difiere entre ${reference} y ${harness} — ${firstDifference(template, other)}`,
				);
			}
		});
	}
	return divergences;
}

function countByType(census: Census): Record<TemplateType, number> {
	const counts: Record<TemplateType, number> = { spec: 0, grill: 0, project: 0 };
	for (const entry of census.canonical) {
		if (entry.type !== null) counts[entry.type] += 1;
	}
	return counts;
}

// --- Gate sobre el arbol real -----------------------------------------------

for (const skill of SKILLS) {
	for (const harness of HARNESSES) {
		test(`${harness}/${skill}: templates de marker v2 esperados, sin template v1 y sin marker legacy`, async () => {
			const census = censusTemplates(await readRepoFile(`${harness}/${skill}/SKILL.md`));
			assert.deepEqual(
				census.legacy,
				[],
				`${harness}/${skill}/SKILL.md instruye un marker legacy (sin version/type)`,
			);
			assert.deepEqual(
				census.v1,
				[],
				`${harness}/${skill}/SKILL.md instruye un template SDD-Tracking v1: los artefactos nuevos nacen Chiche-Tracking: version=2`,
			);
			for (const entry of census.canonical) {
				assert.ok(
					entry.line.startsWith(V2_TEMPLATE_PREFIX),
					`${harness}/${skill}/SKILL.md linea de fence ${entry.fenceLine}: el template no abre con \`${V2_TEMPLATE_PREFIX}\``,
				);
			}
			for (const entry of census.canonical) {
				assert.notEqual(
					entry.type,
					null,
					`${harness}/${skill}/SKILL.md linea de fence ${entry.fenceLine}: template canonico sin type literal`,
				);
			}
			assert.deepEqual(
				countByType(census),
				EXPECTED_TEMPLATES[skill],
				`${harness}/${skill}/SKILL.md no instruye los templates de marker v2 esperados`,
			);
		});
	}
}

test("cada template declara la forma esperada para su skill (estados y supersesion)", async () => {
	const problems: string[] = [];
	for (const skill of SKILLS) {
		for (const harness of HARNESSES) {
			const census = censusTemplates(await readRepoFile(`${harness}/${skill}/SKILL.md`));
			const shapes = EXPECTED_SHAPES[skill];
			if (census.canonical.length !== shapes.length) {
				problems.push(`${harness}/${skill}: ${census.canonical.length} templates, esperados ${shapes.length}`);
				continue;
			}
			shapes.forEach((shape, index) => {
				const line = census.canonical[index]?.line ?? "";
				if (!shape.test(line)) {
					problems.push(`${harness}/${skill}: template #${index + 1} no declara ${shape} — \`${line}\``);
				}
			});
		}
	}
	assert.deepEqual(problems, []);
});

test("cada template de marker instancia a markers canonicos del contrato", async () => {
	const problems: string[] = [];
	for (const skill of SKILLS) {
		for (const harness of HARNESSES) {
			const census = censusTemplates(await readRepoFile(`${harness}/${skill}/SKILL.md`));
			for (const entry of census.canonical) {
				const verdict = validateTemplateLine(entry.line, EXPECTED_ARTIFACT_TYPE[skill]);
				if (!verdict.ok) {
					problems.push(`${harness}/${skill}/SKILL.md (fence linea ${entry.fenceLine}): ${verdict.problems.join("; ")}`);
				}
			}
		}
	}
	assert.deepEqual(problems, []);
});

test("templates byte-equivalentes entre harnesses tras normalizar la invocacion", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const divergences: string[] = [];
	for (const skill of SKILLS) {
		const byHarness = new Map<Harness, string[]>();
		for (const harness of HARNESSES) {
			const markdown = await readRepoFile(`${harness}/${skill}/SKILL.md`);
			const templates = censusTemplates(markdown).markerFences.map((fence) =>
				normalizeInvocations(fence.content, prefixes[harness]),
			);
			if (skill === "chiche-run") {
				const resultado = fencedBlocks(markdown).find((fence) =>
					/^## Resultado de ejecucion/.test(fence.content),
				);
				if (resultado) {
					templates.push(normalizeInvocations(resultado.content, prefixes[harness]));
				} else {
					divergences.push(`chiche-run: ${harness} no instruye el template de ## Resultado de ejecucion`);
				}
			}
			byHarness.set(harness, templates);
		}
		divergences.push(...compareTemplates(skill, byHarness));
	}
	assert.deepEqual(divergences, []);
});

test("chiche-run tolera el checkout sucio, importa artefactos del workflow y aísla el resto en cada harness", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const byHarness = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		const doctrine = delimitedDoctrine(markdown, "chiche-run-dirty-checkout");
		for (const expected of SDD_RUN_DIRTY_CHECKOUT_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-run/SKILL.md no declara ${expected}`);
		}
		assert.doesNotMatch(
			markdown,
			/Única excepción — el spec target sin comitear|CUALQUIER otro path sucio[\s\S]{0,160}abort|cambios pendientes o estado a medias = abort/i,
			`${harness}/chiche-run/SKILL.md todavía bloquea el workflow por suciedad ordinaria`,
		);
		byHarness.set(harness, [normalizeInvocations(doctrine, prefixes[harness])]);
	}
	assert.deepEqual(compareTemplates("chiche-run dirty checkout", byHarness), []);
});

test("chiche-run remedia feedback del PR de forma automática, opt-in y segura en cada harness", async () => {
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		for (const doctrine of FEEDBACK_REMEDIATION_DOCTRINE) {
			assert.match(markdown, doctrine, `${harness}/chiche-run/SKILL.md no declara ${doctrine}`);
		}
		assert.match(
			markdown,
			FEEDBACK_REMEDIATION_QUESTION_STYLE[harness],
			`${harness}/chiche-run/SKILL.md no usa el gate de remediación propio del harness`,
		);
		assert.doesNotMatch(
			markdown,
			/no editar código[\s\S]*turno nuevo/i,
			`${harness}/chiche-run/SKILL.md todavía obliga a detenerse después de detectar feedback`,
		);
	}
});

test("chiche-spec exige la postcondición canónica antes de cualquier éxito observable en cada harness", async () => {
	const commonDoctrine = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		const doctrine = delimitedDoctrine(markdown, "chiche-spec-publication-gate");
		for (const expected of SDD_SPEC_PUBLICATION_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-spec/SKILL.md no declara ${expected}`);
		}
		const doctrineStart = markdown.indexOf("<!-- chiche-spec-publication-gate:start -->");
		const reportStart = markdown.indexOf("## Reporte");
		assert.ok(doctrineStart >= 0 && reportStart >= 0 && doctrineStart < reportStart,
			`${harness}/chiche-spec/SKILL.md declara el gate después del reporte de éxito`);
		if (harness === "pi") {
			assert.match(doctrine, /`persist_sdd_spec`[\s\S]*`details\.receipt`/,
				"Pi debe ejecutar el boundary y comprobar su receipt estructurado");
		} else {
			assert.doesNotMatch(markdown, /`persist_sdd_spec`/,
				`${harness}/chiche-spec/SKILL.md no debe depender del runtime exclusivo de Pi`);
		}
		const normalizedDoctrine = harness === "pi"
			? doctrine.replace(
				/\n\nEn Pi,[\s\S]*$/,
				"\n\nLa ausencia de un runtime dedicado en este harness no relaja ninguna de estas postcondiciones.",
			)
			: doctrine;
		commonDoctrine.set(harness, [normalizedDoctrine]);
	}
	assert.deepEqual(compareTemplates("chiche-spec publication doctrine", commonDoctrine), []);
});

test("chiche-spec avanza sin preguntar inferencias ni mecanismo y cierra con menú en cada harness", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const byHarness = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		assert.doesNotMatch(markdown, /¿Alguna inferencia a revisar\?/, `${harness}/chiche-spec/SKILL.md todavía pregunta las inferencias`);
		assert.doesNotMatch(markdown, /¿Con qué lo verificamos\?/, `${harness}/chiche-spec/SKILL.md todavía pregunta el mecanismo`);
		assert.doesNotMatch(markdown, /¿Con qué intensidad\?/, `${harness}/chiche-spec/SKILL.md todavía pregunta la intensidad`);
		const doctrine = delimitedDoctrine(markdown, "chiche-spec-flow");
		for (const expected of SDD_SPEC_FLOW_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-spec/SKILL.md no declara ${expected}`);
		}
		const flowStart = markdown.indexOf("<!-- chiche-spec-flow:start -->");
		const reportStart = markdown.indexOf("## Reporte");
		assert.ok(flowStart >= 0 && reportStart >= 0 && flowStart < reportStart,
			`${harness}/chiche-spec/SKILL.md declara el flujo después del reporte`);
		byHarness.set(harness, [normalizeInvocations(doctrine, prefixes[harness])]);
	}
	assert.deepEqual(compareTemplates("chiche-spec flow", byHarness), []);
});

test("chiche-spec no contradice que `Llevar a issue` conserva el .md, y Pi revierte la aprobación cancelada", async () => {
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		for (const line of markdown.split("\n")) {
			if (/(?:no crea además una|sin crear una) copia en `\.sdd\/specs\/`/.test(line)) {
				assert.match(line, /Llevar a issue/, `${harness}/chiche-spec/SKILL.md niega la copia local sin exceptuar Llevar a issue`);
			}
		}
		assert.doesNotMatch(delimitedDoctrine(markdown, "chiche-spec-publication-gate"), /`Ambos`/,
			`${harness}/chiche-spec/SKILL.md nombra una opción \`Ambos\` que ya no existe`);
	}
	const pi = await readRepoFile("pi/chiche-spec/SKILL.md");
	assert.match(pi, /`mode: "assume"`[\s\S]*`draft`[\s\S]*`mode: "interactive"`[\s\S]*`approved`/,
		"Pi declara qué mode del runtime publica draft y cuál aprueba");
	assert.match(pi, /cancel[\s\S]{0,200}revert[\s\S]{0,200}`draft`/i, "Pi revierte a draft si se cancela Ejecutar ahora");
});

test("chiche-spec lanza el run con subagente implementer en background en Claude y en Pi, nunca en codex ni opencode", async () => {
	const claude = await readRepoFile("claude/chiche-spec/SKILL.md");
	assert.match(claude, /subagent_type: "implementer"/);
	assert.match(claude, /run_in_background/);
	assert.match(claude, /`general-purpose`[\s\S]*(anunci|avis)/i);
	assert.match(claude, /`\/chiche-run <target> --mode pr-reviewed --inline`/);
	for (const harness of HARNESSES.filter((candidate) => candidate !== "claude")) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		assert.doesNotMatch(markdown, /subagent_type/, `${harness}/chiche-spec/SKILL.md no debe depender de subagentes de Claude`);
	}
	// Issue #44 CA-9/CA-12: Pi lanza la tool `subagent` con el agente bundleado
	// `implementer` en background y el task `/skill:chiche-run <target> --mode pr-reviewed --inline` (issue #102 CA-8, issue #130 CA-18).
	const pi = await readRepoFile("pi/chiche-spec/SKILL.md");
	assert.match(pi, /agent: "implementer"/, "pi/chiche-spec lanza el implementer bundleado");
	assert.match(pi, /background: true/, "pi/chiche-spec lanza el subagente en background");
	assert.match(pi, /`chiche-run --mode pr-reviewed`[\s\S]*`\/skill:chiche-run <target> --mode pr-reviewed --inline`/, "pi/chiche-spec corre chiche-run en pr-reviewed en el hijo");
	// Issue #130, CA-17 y CA-25: `chiche-run` y `--until pr` lanzan sin flags; `launch_sdd_run` lleva `mode`, nunca el nivel.
	assert.match(pi, /`launch_sdd_run` con el target exacto[^\n]*sin `mode`: la sesión hija lee la posición del run del contrato/, "pi/chiche-spec lanza chiche-run sin flags");
	assert.match(pi, /`launch_sdd_run`, el target exacto y `mode: "pr-reviewed"`/, "pi/chiche-spec cae a launch_sdd_run con mode");
	assert.doesNotMatch(pi, /autonomy: /, "pi/chiche-spec ya no pasa autonomy a launch_sdd_run");
	assert.doesNotMatch(pi, /Pi no tiene subagentes/, "pi/chiche-spec ya tiene subagentes");
	assert.match(pi, PI_SCOUT_EXPLORATION, "pi/chiche-spec explora con scouts");
	assert.match(pi, PI_SCOUT_BUDGET_SPEC, "pi/chiche-spec acota los scouts: cantidad, exhaustividad, task cerrado y timeout");
	for (const harness of ["codex", "opencode"] as const) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		assert.doesNotMatch(markdown, /agent: "implementer"|background: true/, `${harness}/chiche-spec/SKILL.md no tiene subagentes`);
	}
});

test("chiche-run imprime el plan y sigue, desvía sin preguntar y ofrece code review post-PR en cada harness", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const byHarness = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		assert.doesNotMatch(markdown, /¿Con qué intensidad la corremos\?/, `${harness}/chiche-run/SKILL.md todavía pregunta la intensidad`);
		assert.doesNotMatch(markdown, /Interactivo: decirlo y preguntar si seguir/, `${harness}/chiche-run/SKILL.md todavía pregunta por specs en draft`);
		assert.doesNotMatch(markdown, /`Aprobar \(Recomendado\)` \/ `Ajustar`/, `${harness}/chiche-run/SKILL.md todavía frena en el gate del plan`);
		const doctrine = delimitedDoctrine(markdown, "chiche-run-flow");
		for (const expected of SDD_RUN_FLOW_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-run/SKILL.md no declara ${expected}`);
		}
		byHarness.set(harness, [normalizeInvocations(doctrine, prefixes[harness])]);
	}
	assert.deepEqual(compareTemplates("chiche-run flow", byHarness), []);
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		assert.match(markdown, CODE_REVIEW_BRANCH[harness], `${harness}/chiche-run/SKILL.md no gatea su rama de Code review`);
		if (harness === "codex" || harness === "opencode") {
			assert.match(markdown, CODE_REVIEW_OFFER_QUALIFIED, `${harness}/chiche-run/SKILL.md ofrece Code review sin calificarlo como GHA-only`);
		}
		if (harness === "pi") {
			// Issue #44 CA-10/CA-12: Pi tiene subagentes via la tool `subagent`.
			assert.doesNotMatch(markdown, CODE_REVIEW_OFFER_QUALIFIED, "pi/chiche-run/SKILL.md ya no califica Code review como GHA-only");
			assert.doesNotMatch(markdown, /sin subagentes/i, "pi/chiche-run/SKILL.md ya no se declara sin subagentes");
			assert.match(markdown, /agent: "reviewer"[\s\S]*background: true[\s\S]*`\/skill:code-review <PR>`/, "pi/chiche-run lanza el reviewer bundleado en background");
			assert.match(markdown, /sin GHA y sin la tool[\s\S]*no aparece|tool `subagent` no est[aá] registrada[\s\S]*no aparece/i, "pi/chiche-run omite la opcion sin GHA ni tool");
			assert.match(markdown, PI_SCOUT_EXPLORATION, "pi/chiche-run explora con scouts en la Fase 2");
			assert.match(markdown, PI_SCOUT_BUDGET_RUN, "pi/chiche-run verifica inline por default y acota los scouts de la Fase 2");
			assert.match(markdown, PI_SCOUT_BUDGET_RUN_OVERFLOW, "pi/chiche-run resuelve el choque entre el tope de 2 scouts y un blast radius de mas de 2 areas");
		}
		if (harness !== "claude") {
			assert.doesNotMatch(markdown, /subagent_type/, `${harness}/chiche-run/SKILL.md no debe depender de subagentes de Claude`);
		}
		// Hallazgo 2: con `pr` o `pr-reviewed` la política de dependencias `preguntar` no puede frenar.
		assert.match(markdown, /`preguntar` → [^\n]*con `pr` o `pr-reviewed`, no agregar la dep/, `${harness}/chiche-run/SKILL.md no frena con pr o pr-reviewed ante deps 'preguntar'`);
	}
	const claude = await readRepoFile("claude/chiche-run/SKILL.md");
	assert.match(claude, /subagent_type: "reviewer"/, "Claude lanza el review con el subagente reviewer");
	assert.match(claude, /`\/code-review --comment`/, "Claude nombra el code review nativo");
});

test("chiche-spec propone el Plan de entrega en el template y el criterio de corte, sin '2+ specs encadenadas', en cada harness", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const byHarness = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		assert.doesNotMatch(markdown, /2\+ specs encadenadas/, `${harness}/chiche-spec/SKILL.md todavía parte por tamaño en specs encadenadas`);
		const template = censusTemplates(markdown).markerFences[0]?.content ?? "";
		assert.match(
			template,
			/## Comportamiento esperado\n[^#]*\n## Plan de entrega\n[^#]*\| Capa \| Etapa \| CAs \| Justificacion \|\n[^#]*\n## Fuera de alcance\n/,
			`${harness}/chiche-spec/SKILL.md: el template no lleva ## Plan de entrega entre Comportamiento esperado y Fuera de alcance con la tabla Capa/Etapa/CAs/Justificacion`,
		);
		const doctrine = delimitedDoctrine(markdown, "chiche-spec-delivery");
		for (const expected of SDD_SPEC_DELIVERY_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-spec/SKILL.md no declara ${expected}`);
		}
		byHarness.set(harness, [normalizeInvocations(doctrine, prefixes[harness])]);
	}
	assert.deepEqual(compareTemplates("chiche-spec delivery", byHarness), []);
});

// Issue #111: toda spec abre con `## Qué hace esto`. El template de la Fase 6 de `chiche-spec` lo lleva como primer
// heading de nivel 2 (CA-1) y el bloque `chiche-spec-readability`, idéntico entre harnesses, fija la vara de la
// sección, la reescritura y la regla de referencias sin numeral (CA-2 a CA-4).
const QUE_HACE_ESTO = "## Qué hace esto";
const QUE_HACE_ESTO_GUIDE = [
	/qué cambia para el usuario/,
	/lenguaje llano/,
	/sin rutas ni líneas de código/,
	/ejemplo/,
];
const CONTEXTO_GUIDE = /2-4 lineas/;

export function queHaceEstoTemplateProblems(template: string): string[] {
	const problems: string[] = [];
	const lines = template.split("\n");
	const markerIndex = lines.findIndex((line) => MARKER_LINE.test(line));
	if (markerIndex < 1 || !/^<!-- Generada por .* -->$/.test(lines[markerIndex - 1] ?? "")) {
		problems.push("el marker Chiche-Tracking no va justo después del comentario «Generada por»");
	}
	const headings = lines.flatMap((line, index) => (/^## /.test(line) ? [{ text: line, index }] : []));
	const section = headings.find((heading) => heading.text === QUE_HACE_ESTO);
	if (section === undefined) {
		problems.push(`falta ${QUE_HACE_ESTO}`);
		return problems;
	}
	if (headings[0] !== section) {
		problems.push(`${QUE_HACE_ESTO} no es el primer heading de nivel 2: antes va \`${headings[0]?.text ?? ""}\``);
		return problems;
	}
	// `parseSddArtifact` lee el marker solo en el preámbulo, antes del primer `##`: la sección va después de los dos comentarios.
	if (markerIndex >= 0 && section.index < markerIndex) {
		problems.push(`${QUE_HACE_ESTO} va antes del marker Chiche-Tracking: tiene que ir después de los dos comentarios, porque el marker se lee solo antes del primer \`##\``);
		return problems;
	}
	const between = markerIndex < 0 ? [] : lines.slice(markerIndex + 1, section.index).filter((line) => line.trim() !== "");
	if (between.length > 0) {
		problems.push(`hay \`${between[0]}\` entre el marker y ${QUE_HACE_ESTO}: va inmediatamente después de los dos comentarios`);
	}
	const next = headings[1];
	if (next?.text !== "## Contexto") {
		problems.push(`después de ${QUE_HACE_ESTO} tiene que ir \`## Contexto\` y va \`${next?.text ?? "nada"}\``);
		return problems;
	}
	const guide = lines.slice(section.index + 1, next.index).join("\n");
	for (const point of QUE_HACE_ESTO_GUIDE) {
		if (!point.test(guide)) problems.push(`la guía de ${QUE_HACE_ESTO} no nombra ${point}`);
	}
	const contextGuide = lines.slice(next.index + 1, headings[2]?.index ?? lines.length).join("\n");
	if (!CONTEXTO_GUIDE.test(contextGuide)) problems.push("`## Contexto` perdió su guía de 2-4 lineas");
	return problems;
}

const SDD_SPEC_READABILITY_DOCTRINE = [
	// CA-2 (a): hoy y después.
	/qué pasa hoy[\s\S]*qué cambia para quien usa el producto/,
	// CA-2 (b): lenguaje llano.
	/lenguaje llano[\s\S]*sin rutas de archivos[\s\S]*sin `archivo:línea`[\s\S]*sin conteos de ocurrencias del código/,
	/nombres que el usuario escribe o ve \(comandos, flags, pantallas, secciones\)[\s\S]*sí van/,
	// CA-2 (c): ejemplo.
	/al menos un ejemplo concreto/,
	// CA-2 (d): el largo sigue al alcance.
	/largo sigue al alcance[\s\S]*dos a cuatro frases[\s\S]*una capa[\s\S]*tabla o subtítulos en negrita[\s\S]*varias capas/,
	// CA-2 (e): cambio interno.
	/no se ve desde afuera \(un refactor, CI, un gate\)[\s\S]*qué gana quien mantiene/,
	// CA-2 (f): sin alcance ni decisiones nuevas.
	/no agrega alcance ni decisiones[\s\S]*lo cubre un CA o `## Fuera de alcance`[\s\S]*decisiones siguen en `## Inferencias`/,
	// CA-2 (g): obligatoria.
	/obligatoria en toda spec[\s\S]*pedido libre, issue o grill[\s\S]*con cualquier confianza/,
	// CA-3: reescritura. Los disparadores son ejemplos (la lista no es exhaustiva) y la sección se actualiza
	// si cambia algo que afirma, no solo los CAs (review de #118).
	/reescribe una spec que no tiene la sección, la agrega/,
	/por ejemplo[\s\S]*re-correr sobre el mismo pedido \(Fase 2, punto 4\)[\s\S]*`Solicitar cambios`[\s\S]*`--triage-route update-existing-spec`[\s\S]*`--triage-route audit-existing-spec`[\s\S]*ruta de spec/,
	/si la reescritura cambia algo que la sección afirma \(CAs, alcance\)[\s\S]*actualiza la sección en la misma pasada/,
	// CA-4: referencias sin numeral.
	/referencias internas \(inferencias, capas, decisiones del handoff\)[\s\S]*no llevan numeral/,
	/`inferencia 7`[\s\S]*`capa 2`[\s\S]*`decisión 4`[\s\S]*nunca `inferencia #7`/,
	// El motivo es exacto: GitHub no linkea dentro del código y linkea al issue o PR con ese número (review de #118).
	/`#NN` queda solo para issues y PRs[\s\S]*GitHub convierte un numeral seguido de un número, fuera del código, en un link al issue o PR con ese número/,
	/columna `#` de la tabla de inferencias no cambia/,
].map((pattern) => new RegExp(pattern.source, "i"));

// Referencia interna con numeral: un sustantivo de referencia interna seguido de `#` y un número, con o sin espacio,
// o de un placeholder (`#N`, `#<n>`) que un agente copiaría literal. `#NN` (issue o PR) y `issue #42` no entran.
const INTERNAL_NUMERAL = /\b(?:inferencias?|capas?|decisi[oó]n(?:es)?|CAs?|pasos?|filas?|preguntas?|riesgos?|criterios?)\s*#(?:\d+|N\b|<)/gi;
const NUMERAL_COUNTEREXAMPLE = "`inferencia #7`";

export function internalNumeralProblems(markdown: string): string[] {
	const block = markdown.match(/<!-- chiche-spec-readability:start -->\n[\s\S]*?\n<!-- chiche-spec-readability:end -->/)?.[0];
	// El bloque nombra el contraejemplo una vez: es la única referencia con numeral que puede escribir.
	// El reemplazo es una función: con un string, un `$&` o `$'` del bloque se interpretaría como patrón especial.
	const cleaned = block === undefined ? markdown : markdown.replace(block, () => block.replace(NUMERAL_COUNTEREXAMPLE, ""));
	return [...cleaned.matchAll(INTERNAL_NUMERAL)].map((match) => `referencia interna con numeral: \`${match[0]}\``);
}

test("issue #111 CA-1: el template de chiche-spec abre con `## Qué hace esto` justo después de los dos comentarios, en cada harness", async () => {
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		const template = censusTemplates(markdown).markerFences[0]?.content ?? "";
		assert.deepEqual(queHaceEstoTemplateProblems(template), [], `${harness}/chiche-spec/SKILL.md: template de la Fase 6`);
	}
});

test("issue #111 CA-2 y CA-3: chiche-spec fija la vara de `## Qué hace esto` y su reescritura en un bloque idéntico, entre el template y chiche-spec-delivery, y en MUST DO", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const byHarness = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		const doctrine = delimitedDoctrine(markdown, "chiche-spec-readability");
		for (const expected of SDD_SPEC_READABILITY_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-spec/SKILL.md no declara ${expected}`);
		}
		assert.doesNotMatch(doctrine, /convierte cualquier `#`/, `${harness}/chiche-spec/SKILL.md exagera el motivo: GitHub no linkea dentro del código`);
		const lines = markdown.split("\n");
		const template = censusTemplates(markdown).markerFences[0];
		assert.ok(template, `${harness}/chiche-spec/SKILL.md sin template de spec`);
		const templateEnd = template.line + template.content.split("\n").length + 1;
		const start = lines.indexOf("<!-- chiche-spec-readability:start -->") + 1;
		const end = lines.indexOf("<!-- chiche-spec-readability:end -->") + 1;
		const delivery = lines.indexOf("<!-- chiche-spec-delivery:start -->") + 1;
		assert.ok(
			templateEnd < start && start < end && end < delivery,
			`${harness}/chiche-spec/SKILL.md: chiche-spec-readability va después del template y antes de chiche-spec-delivery (template hasta la línea ${templateEnd}, bloque ${start}-${end}, delivery ${delivery})`,
		);
		const mustDo = markdown.match(/## MUST DO\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
		assert.match(
			mustDo,
			/^- Abrir toda spec con `## Qué hace esto`[^\n]*según la vara de «Qué hace esto»[^\n]*lenguaje llano[^\n]*ejemplo[^\n]*agregarla si falta[^\n]*actualizarla/m,
			`${harness}/chiche-spec/SKILL.md ## MUST DO no manda abrir toda spec con ## Qué hace esto`,
		);
		byHarness.set(harness, [normalizeInvocations(doctrine, prefixes[harness])]);
	}
	assert.deepEqual(compareTemplates("chiche-spec readability", byHarness), []);
});

test("issue #111 CA-4: ningún chiche-spec/SKILL.md escribe una referencia interna con numeral y la columna `#` de la tabla de inferencias sigue", async () => {
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-spec/SKILL.md`);
		assert.ok(
			delimitedDoctrine(markdown, "chiche-spec-readability").includes(NUMERAL_COUNTEREXAMPLE),
			`${harness}/chiche-spec/SKILL.md: chiche-spec-readability no nombra el contraejemplo ${NUMERAL_COUNTEREXAMPLE}`,
		);
		assert.deepEqual(internalNumeralProblems(markdown), [], `${harness}/chiche-spec/SKILL.md`);
		assert.match(
			markdown,
			/\| # \| Inferencia \| Eleccion propuesta \| Alternativa razonable \| Confianza \|/,
			`${harness}/chiche-spec/SKILL.md: la tabla de inferencias perdió su columna #`,
		);
	}
});

test("issue #111 CA-5: la fila chiche-spec de README.md y README.en.md dice que toda spec abre con `## Qué hace esto`", async () => {
	const expected: Record<string, RegExp> = {
		"README.md": /Toda spec abre con `## Qué hace esto`.*qué cambia.*lenguaje llano.*ejemplo/,
		"README.en.md": /Every spec opens with `## Qué hace esto`.*what changes.*plain language.*example/,
	};
	for (const [file, pattern] of Object.entries(expected)) {
		const row = (await readRepoFile(file)).split("\n").find((line) => line.startsWith("| **`chiche-spec`** |"));
		assert.ok(row, `${file} sin fila chiche-spec`);
		assert.match(row, pattern, `${file}: la fila chiche-spec no dice que toda spec abre con ## Qué hace esto`);
	}
});

const SYNTHETIC_HEAD = [
	"# Spec — <titulo>",
	"<!-- Generada por /chiche-spec el <fecha>. Fuente: <pedido libre | issue #NN | grill <ref>>. Estado: <aprobada|draft> -->",
	"<!-- Chiche-Tracking: version=2; type=spec; state=<draft|approved>; issue=<#NN|owner/repo#NN|none>; grill=<ref|none>; superseded-by=none -->",
	"",
];
const SYNTHETIC_SECTION = [
	QUE_HACE_ESTO,
	"<qué cambia para el usuario, en lenguaje llano: sin rutas ni líneas de código y con un ejemplo; el largo sigue al alcance>",
	"",
];
const SYNTHETIC_CONTEXT = ["## Contexto", "<por que existe el pedido + que hay en el codigo hoy; 2-4 lineas con referencias reales>", ""];
const SYNTHETIC_TAIL = ["## Diseño", "<solo si el pedido toca una superficie UI>", "", "## Comportamiento esperado", "<CA-1..CA-n>"];

function syntheticTemplate(...parts: string[][]): string {
	return [...SYNTHETIC_HEAD, ...parts.flat(), ...SYNTHETIC_TAIL].join("\n");
}

test("autotest: queHaceEstoTemplateProblems acepta el template canónico y exige diagnóstico sin la sección, con la sección después de Contexto y con otro heading entre el marker y la sección", () => {
	assert.deepEqual(queHaceEstoTemplateProblems(syntheticTemplate(SYNTHETIC_SECTION, SYNTHETIC_CONTEXT)), []);

	const sinSeccion = queHaceEstoTemplateProblems(syntheticTemplate(SYNTHETIC_CONTEXT));
	assert.ok(sinSeccion.some((problem) => /falta ## Qué hace esto/.test(problem)), `sin la sección: ${sinSeccion.join(" | ")}`);

	const despuesDeContexto = queHaceEstoTemplateProblems(syntheticTemplate(SYNTHETIC_CONTEXT, SYNTHETIC_SECTION));
	assert.ok(
		despuesDeContexto.some((problem) => /no es el primer heading de nivel 2: antes va `## Contexto`/.test(problem)),
		`sección después de Contexto: ${despuesDeContexto.join(" | ")}`,
	);

	const otroHeading = queHaceEstoTemplateProblems(
		syntheticTemplate(["## Resumen", "<texto>", ""], SYNTHETIC_SECTION, SYNTHETIC_CONTEXT),
	);
	assert.ok(
		otroHeading.some((problem) => /no es el primer heading de nivel 2: antes va `## Resumen`/.test(problem)),
		`otro heading entre el marker y la sección: ${otroHeading.join(" | ")}`,
	);

	// `parseSddArtifact` lee el marker solo antes del primer `##`: una sección arriba de los dos comentarios deja la spec sin marker.
	const antesDeLosComentarios = queHaceEstoTemplateProblems(
		[SYNTHETIC_HEAD[0], "", ...SYNTHETIC_SECTION, SYNTHETIC_HEAD[1], SYNTHETIC_HEAD[2], "", ...SYNTHETIC_CONTEXT, ...SYNTHETIC_TAIL].join("\n"),
	);
	assert.ok(
		antesDeLosComentarios.some((problem) => /va antes del marker/.test(problem)),
		`sección antes de los dos comentarios: ${antesDeLosComentarios.join(" | ") || "sin diagnóstico"}`,
	);

	const comentarioExtra = queHaceEstoTemplateProblems(syntheticTemplate(["<!-- nota -->", ""], SYNTHETIC_SECTION, SYNTHETIC_CONTEXT));
	assert.ok(comentarioExtra.some((problem) => /entre el marker y ## Qué hace esto/.test(problem)), `comentario extra: ${comentarioExtra.join(" | ")}`);

	const otraSiguiente = queHaceEstoTemplateProblems(syntheticTemplate(SYNTHETIC_SECTION, ["## Resumen", "<texto>", ""], SYNTHETIC_CONTEXT));
	assert.ok(otraSiguiente.some((problem) => /tiene que ir `## Contexto` y va `## Resumen`/.test(problem)), `otro heading después: ${otraSiguiente.join(" | ")}`);

	const sinGuia = queHaceEstoTemplateProblems(syntheticTemplate([QUE_HACE_ESTO, "<resumen>", ""], SYNTHETIC_CONTEXT));
	assert.equal(sinGuia.length, QUE_HACE_ESTO_GUIDE.length, `guía sin los cuatro puntos: ${sinGuia.join(" | ")}`);

	const contextoSinGuia = queHaceEstoTemplateProblems(syntheticTemplate(SYNTHETIC_SECTION, ["## Contexto", "<texto libre>", ""]));
	assert.ok(contextoSinGuia.some((problem) => /perdió su guía de 2-4 lineas/.test(problem)), `Contexto sin guía: ${contextoSinGuia.join(" | ")}`);
});

test("autotest: internalNumeralProblems deja pasar el contraejemplo del bloque y marca cualquier otra referencia interna con numeral", () => {
	const block = (body: string) => `<!-- chiche-spec-readability:start -->\n${body}\n<!-- chiche-spec-readability:end -->`;
	const limpio = `Se pide un issue (#42).\n\n${block(`Va \`inferencia 7\`, nunca ${NUMERAL_COUNTEREXAMPLE}.`)}\n`;
	assert.deepEqual(internalNumeralProblems(limpio), []);
	assert.equal(internalNumeralProblems(`${limpio}Ver inferencia #3 y la Capa #2.\n`).length, 2);
	assert.equal(internalNumeralProblems(`${block(`nunca ${NUMERAL_COUNTEREXAMPLE} ni ${NUMERAL_COUNTEREXAMPLE}`)}\n`).length, 1);
	assert.equal(internalNumeralProblems("La decisión #4 y los CA #1.\n").length, 2);
	// Otros sustantivos de referencia interna.
	assert.equal(internalNumeralProblems("El paso #2, la fila #3, la pregunta #1, el riesgo #2 y el criterio #4.\n").length, 5);
	// Forma sin espacio y placeholders que un agente copiaría literal.
	assert.equal(internalNumeralProblems("Va inferencia#7 y capa#2.\n").length, 2);
	assert.equal(internalNumeralProblems("Placeholders: inferencia #N, capa #<n> y decisión #N.\n").length, 3);
	// Los issues y PRs reales, y el placeholder `#NN` de issue, no se marcan.
	assert.deepEqual(internalNumeralProblems("El issue #111, el PR #118, un `#NN` y la fuente `issue #NN` son reales.\n"), []);
	// Un `$` en el bloque no es un patrón de reemplazo: el texto limpio no se corrompe.
	assert.deepEqual(
		internalNumeralProblems(`Ver el issue #42.\n\n${block(`Va \`inferencia 7\`, nunca ${NUMERAL_COUNTEREXAMPLE}. Con Codex: $& $' $$ y $\`.`)}\n`),
		[],
	);
});

test("chiche-run entrega un stack de PRs por capas con preflight, verificación por capa y force acotado en cada harness", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const byHarness = new Map<Harness, string[]>();
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		const doctrine = delimitedDoctrine(markdown, "chiche-run-stack");
		for (const expected of SDD_RUN_STACK_DOCTRINE) {
			assert.match(doctrine, expected, `${harness}/chiche-run/SKILL.md no declara ${expected}`);
		}
		// CA-6: el template de resultado lleva la columna Capa.
		const resultado = fencedBlocks(markdown).find((fence) => /^## Resultado de ejecucion/.test(fence.content));
		assert.match(
			resultado?.content ?? "",
			/\| CA \| Capa \| Estado \| Evidencia \|\n\|---\|---\|---\|---\|\n\| CA-1 \| 1\/1 \|/,
			`${harness}/chiche-run/SKILL.md: el template de Resultado de ejecucion no lleva la columna Capa`,
		);
		// Remediación de review PR #67: con 2 o más capas el push lo hace gh stack submit.
		const phase5 = markdown.match(/## Fase 5 — PR\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
		assert.match(
			phase5,
			/con 2 o más capas el push lo hace `gh stack submit`[\s\S]*solo verifica aptitud y stop list[\s\S]*no ejecuta `git push -u origin sdd\/<slug>`/,
			`${harness}/chiche-run/SKILL.md: Fase 5 paso 1 sigue ordenando git push -u con 2 o más capas`,
		);
		// CA-10: el reporte sugiere chiche-land y lista los PRs por capa.
		const report = fencedBlocks(markdown).find((fence) => /^Run completo:/.test(fence.content));
		assert.ok(report, `${harness}/chiche-run/SKILL.md no instruye el bloque Run completo`);
		assert.match(report.content, new RegExp(`siguiente paso: ${escapeRegExp(prefixes[harness])}chiche-land <stack\\|PR>`), `${harness}/chiche-run/SKILL.md: Run completo sin la línea siguiente paso`);
		assert.match(report.content, /PRs por capa/, `${harness}/chiche-run/SKILL.md: Run completo no lista los PRs por capa`);
		// CA-9: MUST DO y MUST NOT DO nombran el force acotado.
		for (const heading of ["MUST DO", "MUST NOT DO"]) {
			const section = markdown.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1] ?? "";
			assert.match(section, /--force-with-lease[\s\S]*`gh stack (?:push|sync|rebase)`/, `${harness}/chiche-run/SKILL.md ## ${heading} no acota el force a gh stack`);
		}
		byHarness.set(harness, [
			normalizeInvocations(doctrine, prefixes[harness]),
			normalizeInvocations(report.content, prefixes[harness]),
		]);
	}
	assert.deepEqual(compareTemplates("chiche-run stack", byHarness), []);
});

const RIESGO_DE_MERGE_TEMPLATE = [
	"## Riesgo de merge",
	"Reversible con un revert: <sí | no>. <si no: qué cambió afuera del repo y cómo se vuelve atrás: backup, flag, script, comando>",
	"Si sale mal, le pega a: <usuarios, sistemas o flujos afectados, una frase>",
].join("\n");

test("chiche-run pide el loop rojo antes de tocar código y la sección Riesgo de merge en el body del PR", async () => {
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		const risk = fencedBlocks(markdown).filter((fence) => /^## Riesgo de merge/.test(fence.content));
		assert.equal(risk.length, 1, `${harness}/chiche-run/SKILL.md: debe traer un solo template de Riesgo de merge`);
		assert.equal(risk[0]?.content, RIESGO_DE_MERGE_TEMPLATE, `${harness}/chiche-run/SKILL.md: el template de Riesgo de merge no es byte-idéntico`);
		// El template fenced lleva su propio "## " en columna 0: la subsección se delimita por la Fase 6, no por el primer "\n## ".
		const risk5 = markdown.match(/### Riesgo de merge en el body\n([\s\S]*?)(?=\n## Fase 6)/)?.[1] ?? "";
		assert.match(risk5, /es `no` y el body no dice cómo se vuelve atrás[^\n]*`--draft`/, `${harness}/chiche-run/SKILL.md: la regla de draft por riesgo sin rollback no está en la subsección`);
		assert.match(risk5, /PR de abajo[\s\S]*capas superiores/, `${harness}/chiche-run/SKILL.md: no distingue PR de abajo y capas superiores`);
		assert.match(risk5, /el draft va a la capa que no se revierte/, `${harness}/chiche-run/SKILL.md: no dice qué capa del stack sale en draft`);
		assert.match(risk5, /antes de `## Riesgo de merge`[\s\S]*conserva esa sección/, `${harness}/chiche-run/SKILL.md: no protege la sección ante la Fase 6`);
		assert.match(risk5, /`pendiente tuyo`/, `${harness}/chiche-run/SKILL.md: el draft por riesgo no se reporta`);
		const budget = markdown.match(/\n3\. \*\*Presupuesto por CA\*\*[^\n]*(?:\n   [^\n]*)*/)?.[0] ?? "";
		assert.match(budget, /loop rojo/, `${harness}/chiche-run/SKILL.md: el presupuesto por CA no exige el loop rojo`);
		assert.match(budget, /no cuentan/, `${harness}/chiche-run/SKILL.md: sin loop rojo los intentos no cuentan`);
		assert.match(budget, /después de implementarlo/, `${harness}/chiche-run/SKILL.md: el loop rojo no está acotado a CAs rotos`);
		assert.match(budget, /sin loop rojo»[^\n]*se sigue con los demás/, `${harness}/chiche-run/SKILL.md: falta el tope cuando no se arma el loop`);
		assert.match(markdown, /salvo la FALLA «sin loop rojo»/, `${harness}/chiche-run/SKILL.md: Timeouts no exceptúa la FALLA sin loop rojo`);
	}
});

test("los implementer exigen el loop rojo antes de declarar una FALLA con diagnóstico", async () => {
	for (const file of ["agents/implementer.md", "pi-extensions/subagent/agents/implementer.md"]) {
		const markdown = await readRepoFile(file);
		const section = markdown.match(/## 6\. Tope de tres intentos honestos\n([\s\S]*?)(?=\n## 7)/)?.[1] ?? "";
		assert.match(section, /loop rojo/, `${file}: §6 no menciona el loop rojo`);
		assert.match(section, /sin loop rojo/i, `${file}: §6 no define la FALLA sin loop rojo`);
	}
});

test("grill nombra en cada harness la tool de preguntas que declara la tabla", async () => {
	const { questionTools } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const missing: string[] = [];
	for (const harness of HARNESSES) {
		const tool = questionTools[harness];
		if (tool === null) continue;
		const markdown = await readRepoFile(`${harness}/grill/SKILL.md`);
		const name = escapeRegExp(`\`${tool}\``);
		const usage = new RegExp(`(?:UNA llamada a |[Uu]s(?:ar|á) (?:la tool )?|invocá )${name}`);
		const negated = new RegExp(`no (?:hay|existe)[^.\\n]{0,60}${name}`, "i");
		if (!usage.test(markdown)) missing.push(`${harness}/grill/SKILL.md no instruye usar \`${tool}\``);
		if (negated.test(markdown)) missing.push(`${harness}/grill/SKILL.md niega \`${tool}\``);
	}
	assert.deepEqual(missing, []);
});

test("grill entrevista por rondas con hechos sin bloqueo en cada harness y atajo liviano fuera de Pi", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/grill/SKILL.md`);
		const expected = [...GRILL_ROUNDS_DOCTRINE, ...GRILL_NON_BLOCKING_FACTS_DOCTRINE, GRILL_FACT_EXPLORATION[harness]];
		if (GRILL_LIGHT_SHORTCUT_HARNESSES.includes(harness)) expected.push(GRILL_LIGHT_SHORTCUT);
		for (const pattern of expected) {
			if (!pattern.test(markdown)) problems.push(`${harness}/grill/SKILL.md no declara ${pattern}`);
		}
	}
	assert.deepEqual(problems, []);
});

test("autotest: la fila tool-preguntas mapea `—` a null y quita backticks", () => {
	const doc = [
		"<!-- interaction-differences:start -->",
		"| Campo | claude | codex | opencode | pi | antigravity |",
		"|---|---|---|---|---|---|",
		"| invocacion | `/nombre` | `$nombre` | `/nombre` | `/skill:nombre` | `/nombre` |",
		"| tool-preguntas | `AskUserQuestion` | `request_user_input` | — | `ask_user_question` | `ask_question` |",
		"<!-- interaction-differences:end -->",
	].join("\n");
	assert.deepEqual(parseInteractionTable(doc).questionTools, {
		claude: "AskUserQuestion",
		codex: "request_user_input",
		opencode: null,
		pi: "ask_user_question",
		antigravity: "ask_question",
	});
});

test("ultracode no aparece en ningún skill de claude/", async () => {
	const listing = spawnSync("git", ["ls-files", "claude/"], { cwd: fileURLToPath(repoFile("")), encoding: "utf8" });
	assert.equal(listing.status, 0, listing.stderr);
	const files = listing.stdout.split("\n").filter((path) => path.endsWith(".md"));
	assert.ok(files.length > 0, "git ls-files lista skills de claude/");
	const offenders: string[] = [];
	for (const path of files) {
		if (/ultracode/i.test(await readRepoFile(path))) offenders.push(path);
	}
	assert.deepEqual(offenders, []);
});

test(".chiche/project.md lleva el marker canonico type=project", async () => {
	const parsed = parseSddArtifact(await readRepoFile(".chiche/project.md"));
	assert.equal(parsed.kind, "metadata", "el contrato del repo tiene metadata SDD");
	assert.ok(parsed.kind === "metadata" && parsed.format === "canonical", "el marker es canonico, no legacy");
	assert.ok(
		parsed.kind === "metadata" && parsed.format === "canonical" && parsed.metadata.type === "project",
		"el marker declara type=project",
	);
});

// --- #103 CA-21: los alias sdd-<x> se retiraron en 4.0.0 ---------------------

const RETIRED_ALIASES = ["sdd-init", "sdd-spec", "sdd-run", "sdd-land"] as const;

// Lineas que el grep de CA-21 puede devolver: solo las de los README que dicen que los
// nombres "se retiraron en 4.0.0" / "were retired in 4.0.0" (una linea que solo menciona
// "retirar" otra cosa no cuenta) y la frase de la instalacion manual que manda borrar a
// mano las cuatro carpetas (quien copio con `cp -R` no tiene manifest que las pode).
const RETIREMENT_NOTE =
	/^README(?:\.en)?\.md:\d+:(?:.*(?:\bse retiraron en 4\.0\.0|\bwere retired in 4\.0\.0)|Si copiaste a mano, no hay manifest: borrá vos las carpetas |If you copied by hand there is no manifest: delete the )/;

// Los nombres retirados en los archivos TRACKEADOS (git grep): un archivo suelto sin
// trackear no cuenta. Estado 0 si hay coincidencias, 1 si no hay, mayor que 1 si git falla.
// El borde es "fin de linea o un caracter que no continua el identificador": `\b` no sirve
// porque `-` es borde de palabra y `sdd-spec-publication` (identificador persistido) pasaria.
function grepRetiredNames(cwd: string) {
	return spawnSync(
		"git",
		["grep", "-n", "-E", "sdd-(init|spec|run|land)([^A-Za-z0-9_-]|$)", "--", "claude", "codex", "opencode", "pi", "antigravity", "agents", "evals", "README.md", "README.en.md"],
		{ cwd, encoding: "utf8" },
	);
}

test("#103 CA-21: ninguna carpeta sdd-* reaparece en ningun harness", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		for (const alias of RETIRED_ALIASES) {
			const text = await readRepoFile(`${harness}/${alias}/SKILL.md`).catch(() => null);
			if (text !== null) problems.push(`${harness}/${alias}/SKILL.md: el alias se retiro en 4.0.0`);
		}
	}
	assert.deepEqual(problems, []);
});

test("#103 CA-21: fuera de la nota de retiro de los README nadie nombra sdd-init|spec|run|land", () => {
	const grep = grepRetiredNames(fileURLToPath(repoFile("")));
	assert.equal(grep.status, 0, `el grep debe hallar la nota de retiro de los README (estado ${grep.status}): ${grep.stderr}`);
	const lines = grep.stdout.split("\n").filter((line) => line.length > 0);
	assert.deepEqual(lines.filter((line) => !RETIREMENT_NOTE.test(line)), [], "solo queda la nota de retiro de los README");
	for (const readme of ["README.md", "README.en.md"]) {
		assert.ok(lines.some((line) => line.startsWith(`${readme}:`)), `${readme} registra el retiro`);
	}
});

test("#103 CA-21: el grep mira archivos trackeados: un archivo suelto sin trackear que nombra sdd-run no falla el gate", async () => {
	const repo = await mkdtemp(join(tmpdir(), "chiche-ca21-"));
	try {
		const git = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
		};
		git("init", "-q");
		for (const dir of ["claude", "codex", "opencode", "pi", "antigravity", "agents", "evals"]) await mkdir(join(repo, dir), { recursive: true });
		await writeFile(join(repo, "README.md"), "Los nombres `sdd-run` y `sdd-land` se retiraron en 4.0.0.\n");
		await writeFile(join(repo, "README.en.md"), "The names `sdd-run` and `sdd-land` were retired in 4.0.0.\n");
		git("add", "README.md", "README.en.md");
		await writeFile(join(repo, "claude", "scratch.md"), "borrador suelto: sdd-run\n");

		const grep = grepRetiredNames(repo);
		assert.equal(grep.status, 0, grep.stderr);
		const lines = grep.stdout.split("\n").filter((line) => line.length > 0);
		assert.equal(lines.length, 2, `solo las lineas trackeadas de los dos README: ${lines.join(" | ")}`);
		for (const line of lines) assert.match(line, RETIREMENT_NOTE);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("#103 CA-21: el borde del grep no confunde sdd-spec-publication ni sdd-spec-inspection con sdd-spec, pero sí cuenta el nombre al final de línea o antes de puntuación", async () => {
	const repo = await mkdtemp(join(tmpdir(), "chiche-ca21-boundary-"));
	try {
		const git = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
		};
		git("init", "-q");
		for (const dir of ["claude", "codex", "opencode", "pi", "antigravity", "agents", "evals"]) await mkdir(join(repo, dir), { recursive: true });
		await writeFile(join(repo, "README.md"), "# readme\n");
		await writeFile(join(repo, "README.en.md"), "# readme\n");
		// Identificadores persistidos de la capa 2: `-` es borde de palabra, pero no son el nombre retirado.
		await writeFile(join(repo, "pi", "persisted.ts"), 'const a = "sdd-spec-publication";\nconst b = "sdd-spec-inspection";\n');
		git("add", ".");

		const persisted = grepRetiredNames(repo);
		assert.equal(persisted.status, 1, `los identificadores persistidos no cuentan (estado ${persisted.status}): ${persisted.stdout}${persisted.stderr}`);
		assert.equal(persisted.stdout, "");

		// Controles: el nombre retirado sí cuenta al final de línea y antes de cualquier puntuación.
		await writeFile(join(repo, "agents", "names.md"), "usá sdd-land\n`sdd-init`, sdd-run. (sdd-spec) sdd-land:\n");
		git("add", ".");
		const names = grepRetiredNames(repo);
		assert.equal(names.status, 0, names.stderr);
		const lines = names.stdout.split("\n").filter((line) => line.length > 0);
		assert.deepEqual(lines.map((line) => line.split(":")[0]), ["agents/names.md", "agents/names.md"], `solo las dos líneas de names.md: ${lines.join(" | ")}`);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("autotest: RETIREMENT_NOTE acepta las frases de retiro y de instalación manual de los README y rechaza cualquier otra linea", () => {
	assert.match("README.md:22:Los nombres anteriores `sdd-init` y `sdd-run` se retiraron en 4.0.0: migrá.", RETIREMENT_NOTE);
	assert.match("README.en.md:24:The previous names `sdd-init` were retired in 4.0.0: migrate.", RETIREMENT_NOTE);
	assert.match("README.md:271:Si copiaste a mano, no hay manifest: borrá vos las carpetas `sdd-init`, `sdd-spec`, `sdd-run` y `sdd-land` de cada destino.", RETIREMENT_NOTE);
	assert.match("README.en.md:273:If you copied by hand there is no manifest: delete the `sdd-init`, `sdd-spec`, `sdd-run` and `sdd-land` folders from each destination yourself.", RETIREMENT_NOTE);
	assert.doesNotMatch("README.md:30:Para retirar el tag de `sdd-run` usá git tag -d.", RETIREMENT_NOTE);
	assert.doesNotMatch("README.md:32:Antes: Si copiaste a mano, no hay manifest: borrá vos las carpetas `sdd-run`.", RETIREMENT_NOTE);
	assert.doesNotMatch("claude/grill/SKILL.md:9:Si copiaste a mano, no hay manifest: borrá vos las carpetas `sdd-run`.", RETIREMENT_NOTE);
	assert.doesNotMatch("README.md:31:`sdd-spec` se retiraron en 3.0.0.", RETIREMENT_NOTE);
	assert.doesNotMatch("claude/grill/SKILL.md:9:`sdd-run` se retiraron en 4.0.0.", RETIREMENT_NOTE);
});

// --- #103 CA-17: el arbol usa chichex/chiche --------------------------------

// El nombre viejo del repo. Se arma con join para que este archivo no se encuentre a si mismo.
const OLD_REPO_NAME = ["chichex", "skills"].join("/");

interface OldNameAllowance {
	file: string;
	test: RegExp;
	// Cantidad exacta de lineas del archivo que esta entrada debe cubrir; sin ella, una o mas.
	exactly?: number;
}

// Unicas lineas trackeadas que pueden seguir nombrando el repo viejo (decision L46 de la spec chiche-rename).
// Los artefactos historicos congelados de .chiche/grills y .chiche/specs quedan fuera del grep.
const OLD_NAME_ALLOWANCES: OldNameAllowance[] = [
	// La nota de instalacion de cada README: una sola linea por README.
	{ file: "README.md", test: /\bse llamaba `chichex\/skills`/, exactly: 1 },
	{ file: "README.en.md", test: /\bwas named `chichex\/skills`/, exactly: 1 },
	// install.sh: el rotulo viejo del bloque de Codex (para reemplazarlo) y la deteccion en `pi list`,
	// que sigue reconociendo la fuente que el usuario tipeo antes del renombre. El comentario de esa
	// deteccion se admite con su texto exacto: un comentario nuevo que nombre el repo viejo falla.
	{ file: "install.sh", test: /^CODEX_LEGACY_(?:BEGIN|END)=/ },
	{ file: "install.sh", test: /grep -F -q -e 'chichex\/skills'/ },
	{ file: "install.sh", test: /^ {2}# y también la fuente vieja `git:github\.com\/chichex\/skills`: `pi list` muestra$/ },
	// Los tests que ejercitan ese bloque viejo y esa deteccion.
	{ file: "pi-extensions/agents-gate/agents-gate.test.ts", test: /"# (?:>>>|<<<) chichex\/skills: prefer Codex over Pi (?:>>>|<<<)"/ },
	{ file: "pi-extensions/agents-gate/agents-gate.test.ts", test: /^test\("issue #103 CA-10: install\.sh codex reemplaza el bloque viejo chichex\/skills de config\.toml/ },
	{ file: "pi-extensions/pi-package/pi-package.test.ts", test: /"# (?:>>>|<<<) chichex\/skills: prefer Codex over Pi (?:>>>|<<<)"/ },
	{ file: "pi-extensions/pi-package/pi-package.test.ts", test: /rotulo viejo chichex\/skills;/ },
	{ file: "pi-extensions/pi-package/pi-package.test.ts", test: /assert\.doesNotMatch\(configAfter, \/chichex\\\/skills\/, "the old chichex\/skills block must be replaced/ },
	{ file: "pi-extensions/pi-package/pi-package.test.ts", test: /for \(const source of \["git:github\.com\/chichex\/skills", "git:github\.com\/chichex\/chiche"\]\)/ },
	// El titulo de este gate nombra el repo viejo (el resto de este archivo lo arma con OLD_REPO_NAME).
	{ file: "pi-extensions/harness-gate/harness-gate.test.ts", test: /^test\("issue #103 CA-17: el árbol usa chichex\/chiche; chichex\/skills solo sobrevive/ },
	// Entradas fechadas de `## Decisiones humanas` (historia del renombre) y la limitacion de la deteccion en `## Gaps`.
	{ file: ".chiche/project.md", test: /^- \d{4}-\d{2}-\d{2}: / },
	{ file: ".chiche/project.md", test: /^- La deteccion de "el Pi Package nativo ya esta instalado"/ },
];

// Tope de lineas por archivo, ademas de la allowlist: install.sh nombra el repo viejo en cuatro lineas
// (los dos rotulos del bloque de Codex, el comentario de la deteccion y su grep sobre `pi list`).
const OLD_NAME_FILE_LIMITS: Record<string, number> = { "install.sh": 4 };

// Lineas `archivo:numero:texto` de git grep que ninguna entrada cubre, las entradas con `exactly`
// que no cubren exactamente esa cantidad de lineas y los archivos que pasan su tope de lineas.
function oldNameProblems(grepLines: string[], allowances: OldNameAllowance[], limits: Record<string, number> = {}): string[] {
	const problems: string[] = [];
	const covered = new Map<OldNameAllowance, number>();
	const perFile = new Map<string, number>();
	for (const line of grepLines) {
		const match = /^([^:]+):(\d+):(.*)$/.exec(line);
		if (match === null) {
			problems.push(`${line}: salida de git grep ilegible`);
			continue;
		}
		const [, file, , text] = match;
		perFile.set(file ?? "", (perFile.get(file ?? "") ?? 0) + 1);
		const entry = allowances.find((allowance) => allowance.file === file && allowance.test.test(text ?? ""));
		if (entry === undefined) problems.push(`${file}:${match[2]}: nombra el repo viejo y no esta en la allowlist`);
		else covered.set(entry, (covered.get(entry) ?? 0) + 1);
	}
	for (const allowance of allowances) {
		if (allowance.exactly !== undefined && (covered.get(allowance) ?? 0) !== allowance.exactly) {
			problems.push(`${allowance.file}: la nota ${allowance.test} debe aparecer ${allowance.exactly} vez y aparece ${covered.get(allowance) ?? 0}`);
		}
	}
	for (const [file, limit] of Object.entries(limits)) {
		const count = perFile.get(file) ?? 0;
		if (count > limit) problems.push(`${file}: nombra el repo viejo en ${count} lineas y el tope es ${limit}`);
	}
	return problems;
}

// Archivos TRACKEADOS (git grep), sin los artefactos historicos congelados. Estado 0 si hay
// coincidencias, 1 si no hay, mayor que 1 si git falla.
function grepOldRepoName(cwd: string) {
	return spawnSync("git", ["grep", "-n", "-F", OLD_REPO_NAME, "--", ".", ":!.chiche/grills", ":!.chiche/specs"], { cwd, encoding: "utf8" });
}

test("issue #103 CA-17: el árbol usa chichex/chiche; chichex/skills solo sobrevive en la allowlist", () => {
	const grep = grepOldRepoName(fileURLToPath(repoFile("")));
	assert.ok(grep.status === 0 || grep.status === 1, `git grep fallo (estado ${grep.status}): ${grep.stderr}`);
	const lines = grep.stdout.split("\n").filter((line) => line.length > 0);
	assert.deepEqual(oldNameProblems(lines, OLD_NAME_ALLOWANCES, OLD_NAME_FILE_LIMITS), []);
});

test("autotest: oldNameProblems rechaza una linea fuera de la allowlist y una nota de README repetida o ausente", () => {
	const allowances: OldNameAllowance[] = [
		{ file: "README.md", test: /\bse llamaba `chichex\/skills`/, exactly: 1 },
		{ file: "install.sh", test: /^CODEX_LEGACY_(?:BEGIN|END)=/ },
	];
	const noteTest = allowances[0]?.test;
	const note = `README.md:10:**El repo se llamaba \`${OLD_REPO_NAME}\`.** Actualizá el remote.`;
	const legacy = `install.sh:52:CODEX_LEGACY_BEGIN="# >>> ${OLD_REPO_NAME}: prefer Codex over Pi >>>"`;
	const uncovered = (file: string, line: number) => `${file}:${line}: nombra el repo viejo y no esta en la allowlist`;
	const noteCount = (count: number) => `README.md: la nota ${noteTest} debe aparecer 1 vez y aparece ${count}`;

	assert.deepEqual(oldNameProblems([note, legacy], allowances), []);
	assert.deepEqual(oldNameProblems([`README.md:99:pi install git:github.com/${OLD_REPO_NAME}`, note], allowances), [uncovered("README.md", 99)]);
	assert.deepEqual(oldNameProblems([`package.json:10:"repository": "https://github.com/${OLD_REPO_NAME}.git"`], allowances), [
		uncovered("package.json", 10),
		noteCount(0),
	]);
	assert.deepEqual(oldNameProblems([note, `README.md:11:Tambien se llamaba \`${OLD_REPO_NAME}\`.`], allowances), [noteCount(2)]);
	assert.deepEqual(oldNameProblems([note, `install.sh:60:echo ${OLD_REPO_NAME}`], allowances), [uncovered("install.sh", 60)]);
});

test("issue #103 CA-17: el grep mira archivos trackeados y deja afuera .chiche/grills y .chiche/specs", async () => {
	const repo = await mkdtemp(join(tmpdir(), "chiche-ca17-"));
	try {
		const git = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
			assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
		};
		git("init", "-q");
		for (const dir of [".chiche/grills", ".chiche/specs"]) await mkdir(join(repo, dir), { recursive: true });
		await writeFile(join(repo, "README.md"), `antes \`${OLD_REPO_NAME}\`\n`);
		await writeFile(join(repo, ".chiche/grills/historico.md"), `${OLD_REPO_NAME}\n`);
		await writeFile(join(repo, ".chiche/specs/historica.md"), `${OLD_REPO_NAME}\n`);
		git("add", "README.md", ".chiche");
		await writeFile(join(repo, "suelto.md"), `${OLD_REPO_NAME}\n`);

		const grep = grepOldRepoName(repo);
		assert.equal(grep.status, 0, grep.stderr);
		assert.deepEqual(grep.stdout.split("\n").filter((line) => line.length > 0), [`README.md:1:antes \`${OLD_REPO_NAME}\``]);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

// --- #103 CA-18: los README presentan chiche ------------------------------------

const README_PITCH = [
	{ path: "README.md", tagline: "vos elegís cuánto decide el agente", flow: "## El flujo chiche", retirement: "se retiraron en 4.0.0" },
	{ path: "README.en.md", tagline: "you choose how much the agent decides", flow: "## The chiche workflow", retirement: "were retired in 4.0.0" },
] as const;

const CHICHE_FLOW_CHAIN = "chiche-init → chiche-spec → chiche-run → chiche-land";
// La unica mencion de SDD como nombre de la suite: la nota tecnica del pitch.
const SDD_TECHNICAL_NOTE = "Spec-Driven Development (SDD)";
// SDD como palabra suelta; `SDD-Tracking`, `sdd-events-v1` o `SDD` entre backticks son identificadores.
const SDD_STANDALONE = /(^|[^\w`-])SDD(?=[^\w`-]|$)/g;

// Cuantas veces una linea nombra SDD como palabra suelta.
function standaloneSddCount(line: string): number {
	return (line.match(SDD_STANDALONE) ?? []).length;
}

// Review #109 (6): la nota tecnica nombra SDD exactamente una vez (la de «Spec-Driven Development (SDD)»);
// cualquier otra linea, ninguna. Antes la linea de la nota quedaba exenta entera.
function sddMentionProblems(path: string, lines: string[]): string[] {
	const problems: string[] = [];
	lines.forEach((line, index) => {
		const count = standaloneSddCount(line);
		if (line.includes(SDD_TECHNICAL_NOTE)) {
			if (count !== 1) problems.push(`${path}:${index + 1}: la nota técnica nombra SDD ${count} veces y debe nombrarlo 1`);
		} else if (count > 0) problems.push(`${path}:${index + 1}: nombra SDD como suite fuera de la nota técnica`);
	});
	return problems;
}

test("issue #103 CA-18 (issue #130 CA-27): los README se titulan # chiche, abren con el tagline, nombran los tres controles del dial, y el flujo chiche", async () => {
	const problems: string[] = [];
	for (const readme of README_PITCH) {
		const markdown = await readRepoFile(readme.path);
		const lines = markdown.split("\n");
		if (lines[0] !== "# chiche") problems.push(`${readme.path}: la línea 1 es «${lines[0]}» y debe ser «# chiche»`);
		// Las primeras 8 líneas: título, tagline y el párrafo de apertura.
		const opening = lines.slice(0, 8).join("\n");
		if (!opening.toLowerCase().includes(readme.tagline)) problems.push(`${readme.path}: las primeras 8 líneas no dicen «${readme.tagline}»`);
		// El tagline «anda un chiche» se retiró en 5.6.3 y no vuelve.
		if (markdown.toLowerCase().includes("anda un chiche")) problems.push(`${readme.path}: dice «anda un chiche», el tagline retirado`);
		// Issue #130 CA-27: las primeras 8 líneas nombran los tres controles del dial (confianza, posición del run y cadena).
		for (const token of ["`grill`", "`chiche-spec`", "`ask`", "`pr`", "`pr-reviewed`", "`--until pr`"]) {
			if (!opening.includes(token)) problems.push(`${readme.path}: las primeras 8 líneas no nombran ${token}`);
		}

		const flowStart = lines.indexOf(readme.flow);
		if (flowStart === -1) problems.push(`${readme.path}: falta el heading «${readme.flow}»`);
		else {
			const flowEnd = lines.findIndex((line, index) => index > flowStart && line.startsWith("## "));
			const flow = lines.slice(flowStart, flowEnd === -1 ? undefined : flowEnd).join("\n");
			if (!flow.includes(CHICHE_FLOW_CHAIN)) problems.push(`${readme.path}: la sección «${readme.flow}» no nombra «${CHICHE_FLOW_CHAIN}»`);
		}

		const noteCount = markdown.split(SDD_TECHNICAL_NOTE).length - 1;
		if (noteCount !== 1) problems.push(`${readme.path}: «${SDD_TECHNICAL_NOTE}» aparece ${noteCount} veces y debe aparecer 1`);
		problems.push(...sddMentionProblems(readme.path, lines));

		if (!markdown.includes(readme.retirement)) problems.push(`${readme.path}: perdió la nota de retiro «${readme.retirement}»`);
	}
	assert.deepEqual(problems, []);
});

// --- Autotests del gate: puede fallar y con que diagnostico ------------------

test("autotest: la nota técnica admite un solo SDD suelto y el resto de las líneas ninguno", () => {
	const note = `Por detrás es **${SDD_TECHNICAL_NOTE}**: contrato → spec → ejecución → cierre.`;
	assert.deepEqual(sddMentionProblems("README.md", ["# chiche", note, "`SDD-Tracking` y `sdd-events-v1` son identificadores."]), []);
	assert.deepEqual(sddMentionProblems("README.md", [`${note} SDD manda.`]), ["README.md:1: la nota técnica nombra SDD 2 veces y debe nombrarlo 1"]);
	assert.deepEqual(sddMentionProblems("README.md", [note, "## El workflow SDD"]), ["README.md:2: nombra SDD como suite fuera de la nota técnica"]);
});

test("autotest: una divergencia entre harnesses se reporta con la linea que difiere", () => {
	const byHarness = new Map<Harness, string[]>([
		["claude", ["# Spec — <titulo>\nlinea comun"]],
		["codex", ["# Spec — <titulo>\nlinea comun"]],
		["opencode", ["# Spec — <titulo>\nlinea DIVERGENTE"]],
		["pi", ["# Spec — <titulo>\nlinea comun"]],
		["antigravity", ["# Spec — <titulo>\nlinea comun"]],
	]);
	const divergences = compareTemplates("chiche-spec", byHarness);
	assert.equal(divergences.length, 1);
	assert.match(divergences[0] ?? "", /opencode/);
	assert.match(divergences[0] ?? "", /DIVERGENTE/);
});

test("autotest: un template que falta en un harness se reporta como diferencia de cantidad", () => {
	const byHarness = new Map<Harness, string[]>([
		["claude", ["template"]],
		["codex", ["template"]],
		["opencode", []],
		["pi", ["template"]],
		["antigravity", ["template"]],
	]);
	const divergences = compareTemplates("grill", byHarness);
	assert.equal(divergences.length, 1);
	assert.match(divergences[0] ?? "", /1 templates y opencode tiene 0/);
});

test("autotest: un template no canonico falla la validacion con diagnostico del contrato", () => {
	const verdict = validateTemplateLine(
		"<!-- Chiche-Tracking: version=2; type=spec; state=<draft|approved>; issue=<#NN|owner/repo#NN|none>; grill=<ref|none> -->",
		"spec",
	);
	assert.equal(verdict.ok, false);
	assert.match(verdict.problems.join("\n"), /missing-key/);
});

test("autotest: un template Chiche-Tracking v2 canonico pasa la validacion", () => {
	const line = "<!-- Chiche-Tracking: version=2; type=spec; state=<draft|approved>; issue=<#NN|owner/repo#NN|none>; grill=<ref|none>; superseded-by=none -->";
	assert.deepEqual(validateTemplateLine(line, "spec"), { ok: true, problems: [] });
	const census = censusTemplates(["```markdown", "# Spec — X", line, "```"].join("\n"));
	assert.equal(census.canonical.length, 1);
	assert.deepEqual(census.v1, []);
	assert.deepEqual(census.legacy, []);
});

test("autotest: un template SDD-Tracking v1 se censa y se reporta como template v1", () => {
	const line = "<!-- SDD-Tracking: version=1; type=spec; state=<draft|approved>; issue=<#NN|owner/repo#NN|none>; grill=<ref|none>; superseded-by=none -->";
	const census = censusTemplates(["```markdown", "# Spec — X", line, "```"].join("\n"));
	assert.equal(census.canonical.length, 1, "el censo todavia lee el marker v1");
	assert.equal(census.v1.length, 1, "pero lo clasifica como template v1");
	const verdict = validateTemplateLine(line, "spec");
	assert.equal(verdict.ok, false);
	assert.match(verdict.problems.join("\n"), /template SDD-Tracking v1: los artefactos nuevos nacen Chiche-Tracking: version=2/);
});

test("autotest: un marker legacy dentro de un template se clasifica como legacy", () => {
	const census = censusTemplates(
		["```markdown", "# Spec — X", "<!-- SDD-Tracking: issue=#9; grill=none -->", "```"].join("\n"),
	);
	assert.equal(census.canonical.length, 0);
	assert.equal(census.legacy.length, 1);
});

test("autotest: la normalizacion reduce las tres sintaxis de invocacion al mismo token", () => {
	const claude = normalizeInvocations("<!-- Generada por /chiche-spec el <fecha>. -->", "/");
	const codex = normalizeInvocations("<!-- Generada por $chiche-spec el <fecha>. -->", "$");
	const pi = normalizeInvocations("<!-- Generada por /skill:chiche-spec el <fecha>. -->", "/skill:");
	assert.equal(claude, codex);
	assert.equal(codex, pi);
	assert.match(claude, /«skill:chiche-spec»/);
	assert.equal(normalizeInvocations("archivo en .sdd/grills/x.md", "/"), "archivo en .sdd/grills/x.md");
	assert.match(
		normalizeInvocations("invoca `/coding-policies go`", "/"),
		/«skill:coding-policies»/,
		"la lista de skills normalizables incluye coding-policies",
	);
});

// Spec #84 (CA-13 a CA-16) e issue #103 (CA-1, CA-5): los borradores de
// planificación se escriben en <git-common-dir>/chiche/, fuera del working
// tree, y se leen de cuatro lugares: los trackeados `.chiche/` y `.sdd/` y los
// locales <git-common-dir>/chiche/ y <git-common-dir>/sdd/. Ante el mismo
// nombre gana el trackeado sobre el local y chiche sobre sdd. Cada skill lleva
// un bloque delimitado byte a byte idéntico entre harnesses con esa doctrina.
const COMMON_DIR_COMMAND = /`git rev-parse --path-format=absolute --git-common-dir`/;
const DRAFTS_PRECEDENCE = /ante el mismo nombre gana el trackeado sobre el local y `chiche` sobre `sdd`/;
// Decisión humana del review de #86: Codex no escribe en `.git/` con su sandbox por defecto.
// Issue #103, T7c (S14): grill, chiche-spec y chiche-run escriben o copian bajo `.chiche/`, así que el fallback sin
// escalación de los tres es `.chiche/` del cwd, nunca `.sdd/`; esos borradores los resuelve chiche-land en su Fase 5.
const CODEX_NEUTRAL_LINE = /Si el harness no puede escribir en `<git-common-dir>\/chiche\/`, su capa de interacción dice cómo pedir permiso o caer a `\.chiche\/` del cwd/;
const SDD_RUN_NEUTRAL_LINE = /Si el harness no puede escribir en `<git-common-dir>\/chiche\/` o `<git-common-dir>\/sdd\/`, su capa de interacción dice cómo pedir permiso o caer a `\.chiche\/` del cwd/;

// Los cuatro lugares de `kind`, en el orden de precedencia de CA-1 y dentro
// de una misma cláusula (sin `;` de por medio): `.chiche/<kind>/`,
// `.sdd/<kind>/`, `<git-common-dir>/chiche/<kind>/`, `<git-common-dir>/sdd/<kind>/`.
function fourPlacesInOrder(kind: string): RegExp {
	const escaped = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const places = [`\`\\.chiche\\/${escaped}\\/\``, `\`\\.sdd\\/${escaped}\\/\``, `\`<git-common-dir>\\/chiche\\/${escaped}\\/\``, `\`<git-common-dir>\\/sdd\\/${escaped}\\/\``];
	return new RegExp(`en este orden: ${places.join("[^;\\n]*")}`);
}

const GRILL_DRAFTS_DOCTRINE = [
	/El handoff, el cuestionario y la carpeta de capturas se escriben en `<git-common-dir>\/chiche\/grills\/`, fuera del working tree/,
	COMMON_DIR_COMMAND,
	/Fuera de un repo git, en `\.chiche\/grills\/` del cwd/,
	/Para leer o retomar se miran los cuatro lugares, en este orden: `\.chiche\/grills\/` y `\.sdd\/grills\/` del árbol[^;\n]*`<git-common-dir>\/chiche\/grills\/` y `<git-common-dir>\/sdd\/grills\/`/,
	fourPlacesInOrder("grills"),
	DRAFTS_PRECEDENCE,
	/Todo guardado se escribe en `<git-common-dir>\/chiche\/grills\/`, aunque el handoff retomado venga de otro de los cuatro lugares/,
	/imprime su ruta absoluta/,
	CODEX_NEUTRAL_LINE,
];

const SDD_SPEC_DRAFTS_DOCTRINE = [
	/La spec local se escribe en `<git-common-dir>\/chiche\/specs\/<slug>\.md`, fuera del working tree/,
	COMMON_DIR_COMMAND,
	/fuera de un repo git, en `\.chiche\/specs\/` del cwd/,
	fourPlacesInOrder("specs"),
	fourPlacesInOrder("grills"),
	DRAFTS_PRECEDENCE,
	// L4 del issue #103: el artefacto existente se actualiza en su lugar; lo nuevo va a chiche.
	/`\.chiche\/specs\/<slug>\.md` es su ruta lógica \(`\.sdd\/specs\/<slug>\.md` si ya vive en un lugar `sdd`\): si el nombre ya existe en alguno de los cuatro lugares, se actualiza en su lugar; si no, se escribe en `<git-common-dir>\/chiche\/specs\/`/,
	/Los handoffs de `--from-grill` y la Fase 0 se listan de los cuatro lugares, en este orden/,
	// Review de #86: raíz física en el árbol; en el common-dir, `Proyecto` o el worktree principal.
	/La raíz operativa de un handoff depende de dónde está: en `\.chiche\/grills\/` o `\.sdd\/grills\/` del árbol es la raíz física del checkout que lo contiene; en `<git-common-dir>\/chiche\/grills\/` o `<git-common-dir>\/sdd\/grills\/` es su campo `Proyecto` si nombra un worktree del mismo repo[^\n]*y, si no, el worktree principal de ese common-dir/,
	CODEX_NEUTRAL_LINE,
	/imprime la ruta absoluta de la spec local/,
];

const SDD_RUN_DRAFTS_DOCTRINE = [
	/\*\*Borradores del common-dir\*\*: los artefactos de entrada se toman de `<git-common-dir>\/chiche\/` y de `<git-common-dir>\/sdd\/`/,
	COMMON_DIR_COMMAND,
	/la spec target, el handoff canónico, su carpeta de capturas y las specs predecesoras/,
	/Por compatibilidad, también los que sigan sin trackear en `\.chiche\/` o `\.sdd\/` del checkout original/,
	/Se copian al worktree con el mismo nombre, bajo `\.chiche\/grills\/` y `\.chiche\/specs\/` \(también los de `<git-common-dir>\/sdd\/` y los de un `\.sdd\/` sin trackear\), y entran en el PRIMER commit/,
	// Review de #86: el borrado espera al push, así la única copia nunca queda en un branch local.
	/las copias de `<git-common-dir>\/chiche\/` y de `<git-common-dir>\/sdd\/` se borran recién después del push del branch \(o con el PR abierto\)/,
	/Con `--no-pr`, o si el run termina antes del push, se conservan y el reporte las nombra/,
	SDD_RUN_NEUTRAL_LINE,
];

const ISSUE_TRIAGE_DRAFTS_DOCTRINE = [
	/los trackeados `\.chiche\/grills\/`, `\.chiche\/specs\/`, `\.sdd\/grills\/` y `\.sdd\/specs\/` del árbol[^\n]*los locales `<git-common-dir>\/chiche\/grills\/`, `<git-common-dir>\/chiche\/specs\/`, `<git-common-dir>\/sdd\/grills\/` y `<git-common-dir>\/sdd\/specs\/`/,
	COMMON_DIR_COMMAND,
	/El inventario y el linaje se resuelven en los cuatro lugares de cada tipo \(`grills` o `specs`\), en este orden/,
	fourPlacesInOrder("<tipo>"),
	DRAFTS_PRECEDENCE,
	/Un `superseded-by=\.chiche\/specs\/<x>\.md` o `superseded-by=\.sdd\/specs\/<x>\.md` se busca por nombre en ese mismo orden, y los cuatro cuentan como dentro del proyecto/,
];

// Ningún bloque de borradores conserva la doctrina de dos lugares ni un
// fallback a `.sdd/` del cwd: desde T7c todo se escribe y se copia bajo `.chiche/` (S14).
const DRAFTS_STALE = [/los dos lugares/, /gana el del árbol/, /caer a `\.sdd\/` del cwd/];

async function draftsBlocks(skill: string, block: string, patterns: RegExp[]): Promise<string[]> {
	const problems: string[] = [];
	const byHarness = new Map<Harness, string>();
	for (const harness of HARNESSES) {
		const doctrine = delimitedDoctrine(await readRepoFile(`${harness}/${skill}/SKILL.md`), block);
		for (const pattern of patterns) {
			if (!pattern.test(doctrine)) problems.push(`${harness}/${skill}/SKILL.md (${block}) no declara ${pattern}`);
		}
		for (const stale of DRAFTS_STALE) {
			if (stale.test(doctrine)) problems.push(`${harness}/${skill}/SKILL.md (${block}) todavía declara ${stale}`);
		}
		byHarness.set(harness, doctrine);
	}
	// Issue #103, CA-5: el bloque es idéntico byte a byte, sin normalizar invocaciones.
	const [reference, ...rest] = HARNESSES;
	for (const harness of rest) {
		const left = byHarness.get(reference!) ?? "";
		const right = byHarness.get(harness) ?? "";
		if (left !== right) problems.push(`${skill} (${block}): ${reference} vs ${harness} — ${firstDifference(left, right)}`);
	}
	return problems;
}

test("autotest: fourPlacesInOrder exige los cuatro lugares en orden y en una misma cláusula", () => {
	const pattern = fourPlacesInOrder("grills");
	const ordered = "en este orden: `.chiche/grills/` y `.sdd/grills/` del árbol, y `<git-common-dir>/chiche/grills/` y `<git-common-dir>/sdd/grills/`; ante el mismo nombre";
	assert.match(ordered, pattern);
	assert.doesNotMatch(ordered.replace("`.chiche/grills/` y `.sdd/grills/`", "`.sdd/grills/` y `.chiche/grills/`"), pattern, "chiche antes que sdd");
	assert.doesNotMatch(ordered.replace("del árbol, y", "del árbol; y"), pattern, "una sola cláusula");
	assert.doesNotMatch(ordered.replace(", y `<git-common-dir>/chiche/grills/`", ""), pattern, "los cuatro lugares");
	assert.match("en este orden: `.chiche/<tipo>/`, `.sdd/<tipo>/`, `<git-common-dir>/chiche/<tipo>/` y `<git-common-dir>/sdd/<tipo>/`", fourPlacesInOrder("<tipo>"));
});

test("#84 CA-13, #103 CA-5: grill escribe handoff, cuestionario y capturas en <git-common-dir>/chiche/grills y retoma de los cuatro lugares en los cinco harnesses", async () => {
	const problems = await draftsBlocks("grill", "grill-drafts", GRILL_DRAFTS_DOCTRINE);
	for (const harness of HARNESSES) {
		const file = `${harness}/grill/SKILL.md`;
		const markdown = await readRepoFile(file);
		if (!/`<git-common-dir>\/chiche\/grills\/<fecha>-<slug>\.md`/.test(markdown)) problems.push(`${file}: el handoff no se escribe en <git-common-dir>/chiche/grills/<fecha>-<slug>.md`);
		if (!/`<git-common-dir>\/chiche\/grills\/<fecha>-<slug>-cuestionario\.md`/.test(markdown)) problems.push(`${file}: el cuestionario no se escribe en <git-common-dir>/chiche/grills/`);
		if (/`(?:<git-common-dir>\/sdd|\.sdd|\.chiche)\/grills\/<fecha>-<slug>(?:-cuestionario)?\.md`/.test(markdown)) problems.push(`${file}: todavía escribe fuera de <git-common-dir>/chiche/grills/<fecha>-<slug>.md`);
		if (/handoffs? (?:previos )?(?:de los dos lugares|en `\.sdd\/grills\/` y `<git-common-dir>\/sdd\/grills\/`)/.test(markdown)) problems.push(`${file}: todavía lista los handoffs de dos lugares`);
		if (harness !== "pi" && !/list(?:á|ar) por fecha los handoffs de los cuatro lugares \(`\.chiche\/grills\/\*\.md`, `\.sdd\/grills\/\*\.md`, `<git-common-dir>\/chiche\/grills\/\*\.md` y `<git-common-dir>\/sdd\/grills\/\*\.md`\)/.test(markdown)) {
			problems.push(`${file}: la reanudación no lista los handoffs de los cuatro lugares`);
		}
		if (harness === "pi" && !/handoffs portables de cada root conocido bajo `\.chiche\/grills\/` y `\.sdd\/grills\/` y de `<git-common-dir>\/chiche\/grills\/` y `<git-common-dir>\/sdd\/grills\/`/.test(markdown)) {
			problems.push(`${file}: /grills y select_grill_session no combinan los cuatro lugares`);
		}
		const design = delimitedDoctrine(markdown, "grill-design");
		if (!/se copian a `<git-common-dir>\/chiche\/grills\/<nombre-real-del-handoff>\/`/.test(design)) problems.push(`${file}: las capturas no se copian a <git-common-dir>/chiche/grills/`);
	}
	assert.deepEqual(problems, []);
});

test("#84 CA-14, #103 CA-5: chiche-spec escribe la spec local en <git-common-dir>/chiche/specs y su Fase 0 lista los cuatro lugares en los cinco harnesses", async () => {
	const problems = await draftsBlocks("chiche-spec", "chiche-spec-drafts", SDD_SPEC_DRAFTS_DOCTRINE);
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		const markdown = await readRepoFile(file);
		const flow = delimitedDoctrine(markdown, "chiche-spec-flow");
		if (!/`<git-common-dir>\/chiche\/specs\/<slug>\.md`/.test(flow)) problems.push(`${file}: el destino local de chiche-spec-flow no es <git-common-dir>/chiche/specs/<slug>.md`);
		if (/`<git-common-dir>\/sdd\/specs\/(?:issue-NN-)?<slug>\.md`/.test(flow)) problems.push(`${file}: chiche-spec-flow todavía escribe en <git-common-dir>/sdd/specs/`);
		if (!/`local` = `<git-common-dir>\/chiche\/specs\/`/.test(markdown)) problems.push(`${file}: --out local no apunta a <git-common-dir>/chiche/specs/`);
		if (/`local` = `\.sdd\/specs\/`/.test(markdown)) problems.push(`${file}: --out local todavía apunta a .sdd/specs/`);
		if (!/Revisar `\.chiche\/specs\/`, `\.sdd\/specs\/`, `<git-common-dir>\/chiche\/specs\/` y `<git-common-dir>\/sdd\/specs\/`/.test(markdown)) problems.push(`${file}: la búsqueda de una spec previa no mira los cuatro lugares`);
		if (/`\.sdd\/grills\/` (?:o|y) (?:en )?`<git-common-dir>\/sdd\/grills\/`|`\.sdd\/specs\/` y `<git-common-dir>\/sdd\/specs\/`|`\.sdd\/grills\/\*\.md` y `<git-common-dir>\/sdd\/grills\/\*\.md`/.test(markdown)) {
			problems.push(`${file}: todavía enumera dos lugares de handoffs o specs`);
		}
		if (/ra[ií]z operativa (?:de un handoff )?sale (?:de su|del) campo `Proyecto`[^\n]*no de d[oó]nde est[aá] guardado el archivo/.test(markdown)) {
			problems.push(`${file}: la raíz operativa de un handoff del árbol todavía sale de Proyecto`);
		}
	}
	assert.deepEqual(problems, []);
});

test("#84 CA-15, #103 CA-5: chiche-run toma los artefactos de entrada de <git-common-dir>/chiche/ y <git-common-dir>/sdd/, los commitea en el worktree y borra las copias", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const markdown = await readRepoFile(`${harness}/chiche-run/SKILL.md`);
		const doctrine = delimitedDoctrine(markdown, "chiche-run-dirty-checkout");
		for (const pattern of [...SDD_RUN_DRAFTS_DOCTRINE, /checkout original queda intacto/i]) {
			if (!pattern.test(doctrine)) problems.push(`${harness}/chiche-run/SKILL.md (chiche-run-dirty-checkout) no declara ${pattern}`);
		}
		if (!/Listar las specs de `\.chiche\/specs\/`, `\.sdd\/specs\/`, `<git-common-dir>\/chiche\/specs\/` y `<git-common-dir>\/sdd\/specs\/`/.test(markdown)) {
			problems.push(`${harness}/chiche-run/SKILL.md: la Fase 0 no lista las specs de los cuatro lugares`);
		}
	}
	assert.deepEqual(problems, []);
});

// Issue #103, CA-14 (S14): chiche-run copia al worktree los artefactos de entrada bajo `.chiche/` aunque
// vengan de `<git-common-dir>/sdd/` o de un `.sdd/` sin trackear, y deja su evidencia en
// `.chiche/evidence/`. Un argumento `.chiche/specs/<x>.md` o `.sdd/specs/<x>.md` se resuelve por nombre
// en los cuatro lugares (review de #107, 3); solo una ruta fuera de esas dos formas se lee tal cual.
test("#103 CA-14: chiche-run copia los artefactos de entrada al worktree bajo .chiche/ y deja la evidencia en .chiche/evidence/", async () => {
	const problems: string[] = [];
	const argumentCompat = new RegExp(`Un argumento \`\\.chiche\\/specs\\/<x>\\.md\` o \`\\.sdd\\/specs\\/<x>\\.md\`[^\\n]*se resuelve por nombre[^\\n]*${fourPlacesInOrder("specs").source}[^\\n]*${DRAFTS_PRECEDENCE.source}[^\\n]*Solo una ruta que no es ninguna de esas dos formas se lee tal cual\\.`);
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		const markdown = await readRepoFile(file);
		const doctrine = delimitedDoctrine(markdown, "chiche-run-dirty-checkout");
		const copyLine = doctrine.split("\n").find((line) => line.includes("Se copian al worktree")) ?? "";
		if (!/Se copian al worktree con el mismo nombre, bajo `\.chiche\/grills\/` y `\.chiche\/specs\/`/.test(copyLine)) {
			problems.push(`${file}: la copia al worktree no va bajo .chiche/grills/ y .chiche/specs/`);
		}
		if (/`\.sdd\/(?:grills|specs)\/`/.test(copyLine)) problems.push(`${file}: la frase de la copia todavía nombra .sdd/grills/ o .sdd/specs/ como destino`);
		if (!/entran en el PRIMER commit/.test(copyLine)) problems.push(`${file}: las copias ya no entran en el PRIMER commit`);
		if (/\.sdd\/evidence\//.test(markdown)) problems.push(`${file}: la evidencia todavía va a .sdd/evidence/`);
		for (const literal of ["bajo `.chiche/evidence/<slug>/`", "/raw/<sha>/.chiche/evidence/<slug>/<pantalla>.png", "`.chiche/evidence/` queda fuera de los gates"]) {
			if (!markdown.includes(literal)) problems.push(`${file}: no dice ${literal}`);
		}
		if (!/^\S*chiche-run \[\.chiche\/specs\/<spec>\.md \| #NN/m.test(markdown)) problems.push(`${file}: el argumento de ejemplo no es .chiche/specs/<spec>.md`);
		if (!argumentCompat.test(markdown)) problems.push(`${file}: no dice que un argumento .chiche/specs/<x>.md o .sdd/specs/<x>.md se resuelve por nombre en los cuatro lugares y que solo otra ruta se lee tal cual`);
		if (/Ruta → leerla\./.test(markdown)) problems.push(`${file}: «Ruta → leerla.» manda a leer literal también las rutas .chiche/specs/ y .sdd/specs/`);
	}
	assert.deepEqual(problems, []);
});

// Issue #103, CA-14 (S14), decisión (d) de L30: en la Fase 5, chiche-land barre los borradores de ambos
// common-dirs cuyo blob ya está en origin/<default>. El bloque es idéntico byte a byte entre harnesses.
const CHICHE_LAND_COMMON_DIR_DOCTRINE = [
	/antes de clasificar los paths sucios, barre los dos common-dirs, `<git-common-dir>\/chiche\/` y `<git-common-dir>\/sdd\/`/,
	COMMON_DIR_COMMAND,
	/con `<kind>` = `specs` o `grills`, incluida la carpeta de capturas de un handoff/,
	/`git hash-object <archivo>` es igual a `git rev-parse origin\/<default>:\.chiche\/<kind>\/<nombre>` o a `git rev-parse origin\/<default>:\.sdd\/<kind>\/<nombre>`/,
	/Se borra con `rm -- <archivo>` y va al reporte como `ya aterrizados` con su ruta/,
	/Un borrador sin gemelo aterrizado, o con otro contenido, nunca se toca/,
	/Con `--dry-run` se lista lo que se borraría y no se borra/,
	/con `--clean-only` el barrido corre igual/,
];

test("#103 CA-14: chiche-land barre en la Fase 5 los borradores ya aterrizados de ambos common-dirs, con un bloque idéntico", async () => {
	const problems: string[] = [];
	const blocks = new Map<Harness, string>();
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-land/SKILL.md`;
		const markdown = await readRepoFile(file);
		if (markdown.split("<!-- chiche-land-common-dir:start -->").length !== 2) {
			problems.push(`${file}: debe traer un solo bloque chiche-land-common-dir`);
			continue;
		}
		const block = delimitedDoctrine(markdown, "chiche-land-common-dir");
		blocks.set(harness, block);
		for (const pattern of CHICHE_LAND_COMMON_DIR_DOCTRINE) {
			if (!pattern.test(block)) problems.push(`${file} (chiche-land-common-dir) no declara ${pattern}`);
		}
		const at = markdown.indexOf("<!-- chiche-land-common-dir:start -->");
		const phase5 = markdown.indexOf("## Fase 5 — Checkout principal");
		const phase6 = markdown.indexOf("## Fase 6 — ");
		if (!(phase5 !== -1 && phase5 < at && at < phase6)) problems.push(`${file}: el bloque no está dentro de la Fase 5`);
		if (!(markdown.indexOf("Primero `git fetch --prune`") < at && at < markdown.indexOf("- **Sucio**"))) {
			problems.push(`${file}: el barrido no va después del git fetch --prune y antes de clasificar los paths sucios`);
		}
		if (!/- ya aterrizados: <paths \| ninguno> · del common-dir: <rutas \| ninguno> · sin resolver: <paths \| ninguno>/.test(markdown)) {
			problems.push(`${file}: el reporte no lista los ya aterrizados del common-dir`);
		}
	}
	const [reference, ...rest] = HARNESSES;
	for (const harness of rest) {
		const a = blocks.get(reference);
		const b = blocks.get(harness);
		if (a !== undefined && b !== undefined && a !== b) problems.push(`chiche-land-common-dir ${reference} vs ${harness}: ${firstDifference(a, b)}`);
	}
	assert.deepEqual(problems, []);
});

// Issue #103, decisión (a) de L30 y T7c: el contrato es `.chiche/project.md`; una sola frase de fallback a
// `.sdd/project.md` por skill, donde se lee por primera vez, y en ningún otro lugar. La migración
// (`chiche-init --update`) la ofrece la frase misma, con la invocación de cada harness.
const CONTRACT_FALLBACK_SKILLS = ["chiche-run", "chiche-land", "chiche-spec", "grill", "coding-policies", "design-system", "issue-triage"] as const;
// Review de #107-2 (3): `coding-policies` y `design-system` también ESCRIBEN el contrato, así que la frase dice «se lee y se escribe ahí».
const CONTRACT_FALLBACK_SENTENCE = /Un repo inicializado antes del renombre lo tiene en `\.sdd\/project\.md`: se lee y se escribe ahí, y `[^`\s]*chiche-init --update` ofrece migrarlo\./;
// Review de #107 (2): `coding-policies` es el único skill que ESCRIBE un archivo del contrato viejo, así que suma una
// segunda mención de `.sdd/coding-policies.md`: el destino por defecto de un repo sin migrar, regenerado en el lugar.
const CODING_POLICIES_DESTINATION_FALLBACK = /Si `\.chiche\/coding-policies\.md` no existe y `\.sdd\/coding-policies\.md` sí \(repo sin migrar o con `Mantener \.sdd\/`\), ese es el default y la opción `\(Recomendado\)`: se regenera en el lugar preservando `## Ajustes de este proyecto`, `CLAUDE\.md` conserva su import y `[^`\s]*chiche-init --update` lo migra después\./;
test("#103 L30 (a), T7c: los skills leen el contrato de .chiche/project.md con una sola frase de fallback a .sdd/project.md", async () => {
	const problems: string[] = [];
	for (const skill of CONTRACT_FALLBACK_SKILLS) {
		for (const harness of HARNESSES) {
			const file = `${harness}/${skill}/SKILL.md`;
			// Issue #102 CA-4: el bloque `autonomy-resolve` lee el contrato del branch default con el mismo
			// fallback a `.sdd/project.md` (prosa y comando canónico); autonomy-gate lo verifica, así que queda fuera del conteo.
			const markdown = withoutAutonomyResolve(await readRepoFile(file));
			if (!markdown.includes("`.chiche/project.md`")) problems.push(`${file}: no lee .chiche/project.md`);
			if ((markdown.match(/\.sdd\/project\.md/g) ?? []).length !== 1) problems.push(`${file}: debe nombrar .sdd/project.md una sola vez, en la frase de fallback`);
			if (!CONTRACT_FALLBACK_SENTENCE.test(markdown)) problems.push(`${file}: falta la frase de fallback del contrato`);
			if ((markdown.match(/Un repo inicializado antes del renombre lo tiene en/g) ?? []).length !== 1) problems.push(`${file}: la frase de fallback debe aparecer una sola vez`);
			const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
			if (frontmatter.includes(".sdd/")) problems.push(`${file}: el frontmatter todavía nombra .sdd/`);
			if (skill === "coding-policies") {
				if ((markdown.match(/\.sdd\/coding-policies\.md/g) ?? []).length !== 1) problems.push(`${file}: debe nombrar .sdd/coding-policies.md una sola vez, en la frase de fallback del destino`);
				if (!CODING_POLICIES_DESTINATION_FALLBACK.test(markdown)) problems.push(`${file}: falta la frase de fallback del destino a .sdd/coding-policies.md`);
				if ((markdown.match(/Si `\.chiche\/coding-policies\.md` no existe/g) ?? []).length !== 1) problems.push(`${file}: la frase de fallback del destino debe aparecer una sola vez`);
				if (!markdown.includes("`.chiche/coding-policies.md`")) problems.push(`${file}: el destino por defecto no es .chiche/coding-policies.md`);
			}
		}
	}
	assert.deepEqual(problems, []);
});

// Review de #107-2 (3): en un repo sin migrar `.chiche/project.md` no existe; el enganche y el reporte nombran el contrato con su fallback para no
// leer «no existe» sobre un contrato que sí está (en `.sdd/project.md`).
test("review #107-2 (3): el enganche y el reporte de coding-policies y design-system nombran el contrato con su fallback", async () => {
	const problems: string[] = [];
	const contract = "el contrato (`.chiche/project.md` o su fallback)";
	for (const harness of HARNESSES) {
		const policies = `${harness}/coding-policies/SKILL.md`;
		const policiesText = await readRepoFile(policies);
		for (const literal of [
			`Detectar en la raíz \`CLAUDE.md\`, \`AGENTS.md\` y ${contract}.`,
			`3. **El contrato (\`.chiche/project.md\` o su fallback)** — en la tabla de \`## Politicas de generacion\``,
			`en ${contract}, comparando la fila entera`,
		]) {
			if (!policiesText.includes(literal)) problems.push(`${policies}: falta «${literal}»`);
		}
		if (!/^- enganche: .* · contrato \(\.chiche\/project\.md o su fallback\) <agregado\|actualizado\|ya estaba\|omitido\|sin seccion\|no existe>$/m.test(policiesText)) problems.push(`${policies}: el enum del reporte no dice «contrato (.chiche/project.md o su fallback)»`);
		if (/ · \.chiche\/project\.md <agregado/.test(policiesText)) problems.push(`${policies}: el enum del reporte todavía nombra solo .chiche/project.md`);

		const design = `${harness}/design-system/SKILL.md`;
		const designText = await readRepoFile(design);
		for (const literal of [
			`**Rama de registro** (la superficie ya tenía sistema): solo ${contract}`,
			`1. **El contrato (\`.chiche/project.md\` o su fallback)** — fila de la superficie en \`## Diseño\` del contrato`,
		]) {
			if (!designText.includes(literal)) problems.push(`${design}: falta «${literal}»`);
		}
		if (!/^- enganche: <no intentado> \| contrato \(\.chiche\/project\.md o su fallback\) <agregado\|actualizado\|ya estaba\|omitido\|sin seccion\|no existe> · /m.test(designText)) problems.push(`${design}: el enum del reporte no dice «contrato (.chiche/project.md o su fallback)»`);
		if (/\| \.chiche\/project\.md <agregado/.test(designText)) problems.push(`${design}: el enum del reporte todavía nombra solo .chiche/project.md`);
		for (const [file, text] of [[policies, policiesText], [design, withoutAutonomyResolve(designText)]] as const) {
			if ((text.match(/\.sdd\/project\.md/g) ?? []).length !== 1) problems.push(`${file}: debe nombrar .sdd/project.md una sola vez, en la frase de fallback`);
		}
	}
	assert.deepEqual(problems, []);
});

// Review de #107-2 (2): code-review lee la spec del PR de los cuatro lugares, con la precedencia de chiche-paths, y el contrato con su fallback.
test("review #107-2 (2): code-review busca la spec del PR en los cuatro lugares y lee el contrato con su fallback", async () => {
	const problems: string[] = [];
	for (const harness of ["codex", "opencode", "pi", "antigravity"] as const) {
		const file = `${harness}/code-review/SKILL.md`;
		const markdown = await readRepoFile(file);
		const lookup = "4. `.chiche/specs/`, `.sdd/specs/`, `<git-common-dir>/chiche/specs/`, `<git-common-dir>/sdd/specs/` (en ese orden de precedencia), `specs/`, `docs/`, `prd/` u otra ruta explícita del repo que coincida con el PR;";
		if (!markdown.split("\n").includes(lookup)) problems.push(`${file}: la lista de la spec no nombra los cuatro lugares en orden de precedencia`);
		if (!markdown.includes("Usar `.chiche/project.md` o su fallback como fuente principal si existe.")) problems.push(`${file}: la fuente principal no nombra el fallback`);
		if ((markdown.match(/\.sdd\/project\.md/g) ?? []).length !== 1) problems.push(`${file}: debe nombrar .sdd/project.md una sola vez, en la frase de fallback`);
		if (!/\(un repo inicializado antes del renombre lo tiene en `\.sdd\/project\.md`: se lee y se escribe ahí, y `[^`\s]*chiche-init --update` ofrece migrarlo\)/.test(markdown)) problems.push(`${file}: falta la frase de fallback del contrato`);
	}
	assert.deepEqual(problems, []);
});

test("#84 CA-16, #103 CA-5: issue-triage resuelve el linaje en los cuatro lugares y los READMEs dicen dónde viven los borradores", async () => {
	const problems = await draftsBlocks("issue-triage", "issue-triage-drafts", ISSUE_TRIAGE_DRAFTS_DOCTRINE);
	for (const harness of ["claude", "codex", "opencode"] as const) {
		const file = `${harness}/issue-triage/SKILL.md`;
		const markdown = await readRepoFile(file);
		if (!/dentro de `cwd`, de `<git-common-dir>\/chiche\/` o de `<git-common-dir>\/sdd\/`/.test(markdown)) problems.push(`${file}: los artefactos del common-dir no cuentan chiche y sdd`);
		if (!/ubicado directamente bajo `<cwd>\/\.chiche\/grills\/`, `<cwd>\/\.sdd\/grills\/`, `<git-common-dir>\/chiche\/grills\/` o `<git-common-dir>\/sdd\/grills\/`/.test(markdown)) {
			problems.push(`${file}: spec-from-grill no acepta el handoff de los cuatro lugares`);
		}
	}
	for (const path of ["README.md", "README.en.md"]) {
		const readme = await readRepoFile(path);
		for (const literal of ["`<git-common-dir>/chiche/grills/`", "`<git-common-dir>/chiche/specs/`", "`<git-common-dir>/chiche/events.jsonl`", "`<git-common-dir>/sdd/events.jsonl`", "`git rev-parse --path-format=absolute --git-common-dir`"]) {
			if (!readme.includes(literal)) problems.push(`${path}: no menciona ${literal}`);
		}
		// Issue #103, T7c: el README dice que `.sdd/` se sigue leyendo, que `chiche-init --update` lo migra y que
		// chiche-run copia bajo `.chiche/`; la fila de chiche-init nombra el contrato nuevo.
		const spanish = path === "README.md";
		const migrates = spanish ? "`chiche-init --update` migra `.sdd/` a `.chiche/`" : "`chiche-init --update` migrates `.sdd/` to `.chiche/`";
		if (!readme.includes(migrates)) problems.push(`${path}: no dice que ${migrates}`);
		// Review de #107 (7): las filas `grill` y `chiche-spec` escriben en <git-common-dir>/chiche/grills/ y leen de los cuatro lugares.
		const grillRow = readme.split("\n").find((line) => line.startsWith("| **`grill`** |")) ?? "";
		const specRow = readme.split("\n").find((line) => line.startsWith("| **`chiche-spec`** |")) ?? "";
		const places = "(`.chiche/grills/`, `.sdd/grills/`, `<git-common-dir>/chiche/grills/` and `<git-common-dir>/sdd/grills/`)";
		const lugares = "(`.chiche/grills/`, `.sdd/grills/`, `<git-common-dir>/chiche/grills/` y `<git-common-dir>/sdd/grills/`)";
		for (const literal of spanish
			? [`persiste sesiones en \`<git-common-dir>/chiche/grills/\`, fuera del working tree, y las reanuda de los cuatro lugares ${lugares}`, "escribe además el handoff interoperable en `<git-common-dir>/chiche/grills/` del proyecto"]
			: [`persists sessions in \`<git-common-dir>/chiche/grills/\`, outside the working tree, and resumes them from the four places ${places}`, "writes the interoperable handoff into the project's `<git-common-dir>/chiche/grills/`"]) {
			if (!grillRow.includes(literal)) problems.push(`${path}: la fila grill no dice «${literal}»`);
		}
		const specLiteral = spanish ? `parte de un handoff finalizado de \`grill\` de los cuatro lugares ${lugares}` : `starts from a finalized \`grill\` handoff in the four places ${places}`;
		if (!specRow.includes(specLiteral)) problems.push(`${path}: la fila chiche-spec no dice «${specLiteral}»`);
		for (const [name, row] of [["grill", grillRow], ["chiche-spec", specRow]] as const) {
			if (/(?:persiste|persists)[^|]*<git-common-dir>\/sdd\/grills\/`, (?:fuera|outside)|(?:en|in) `<git-common-dir>\/sdd\/grills\/` (?:o|or) `\.sdd\/grills\/`/.test(row)) problems.push(`${path}: la fila ${name} todavía escribe o lee solo en <git-common-dir>/sdd/grills/`);
		}
		if (!readme.includes(spanish ? "a `.chiche/` de su worktree" : "into its worktree's `.chiche/`")) problems.push(`${path}: chiche-run no copia a .chiche/ del worktree`);
		if (/a `\.sdd\/` de su worktree|worktree's `\.sdd\/`/.test(readme)) problems.push(`${path}: chiche-run todavía copia a .sdd/ del worktree`);
		const initRow = readme.match(/^\| \*\*`chiche-init`\*\* \|[^\n]*\|$/m)?.[0] ?? "";
		if (!initRow.includes("`.chiche/project.md`") || initRow.includes(".sdd/project.md")) problems.push(`${path}: la fila de chiche-init no nombra solo .chiche/project.md`);
	}
	assert.deepEqual(problems, []);
});

test("#84 review #86, #103 CA-5, CA-14, review #105: en Codex, escribir o borrar en <git-common-dir> pide escalación o cae al cwd", async () => {
	const problems: string[] = [];
	const shared = /En Codex, el sandbox por defecto deja `\.git\/` en solo lectura \(`mkdir: \.git\/chiche: Operation not permitted`\): pedir escalación para escribir en `<git-common-dir>\/chiche\/`/;
	const fallback: Record<string, RegExp> = {
		grill: /sin permiso, escribir en `\.chiche\/` del cwd y decirlo en el reporte[^\n]*`\$chiche-land`/,
		"chiche-spec": /sin permiso, escribir en `\.chiche\/` del cwd y decirlo en el reporte[^\n]*`\$chiche-land`/,
		"chiche-run": /pedir escalación para escribir en `<git-common-dir>\/chiche\/` y `<git-common-dir>\/sdd\/`, donde se borran las copias; sin permiso, dejarlas y decirlo en el reporte\. Los borradores que `\$grill` y `\$chiche-spec` hayan dejado en `\.chiche\/` o `\.sdd\/` del cwd entran/,
	};
	for (const [skill, pattern] of Object.entries(fallback)) {
		const codex = await readRepoFile(`codex/${skill}/SKILL.md`);
		if (!shared.test(codex)) problems.push(`codex/${skill}/SKILL.md: falta la escalación de Codex`);
		if (!pattern.test(codex)) problems.push(`codex/${skill}/SKILL.md: falta el fallback ${pattern}`);
		if (/sin permiso, escribir en `\.sdd\/` del cwd/.test(codex)) problems.push(`codex/${skill}/SKILL.md: el fallback todavía va a .sdd/ del cwd`);
		for (const harness of ["claude", "opencode", "pi", "antigravity"] as const) {
			if (/pedir escalación para escribir en `<git-common-dir>/.test(await readRepoFile(`${harness}/${skill}/SKILL.md`))) problems.push(`${harness}/${skill}/SKILL.md: la escalación es solo de Codex`);
		}
	}
	// Issue #103, CA-14: el barrido de la Fase 5 borra dentro de `.git/`; solo Codex lo dice (capa de interacción).
	const sweepEscalation = /En Codex, el sandbox por defecto deja `\.git\/` en solo lectura: pedir escalación para borrar en `<git-common-dir>\/chiche\/` y `<git-common-dir>\/sdd\/` los borradores ya aterrizados; sin permiso, van a `sin resolver` con la ruta y el comando\./;
	for (const harness of HARNESSES) {
		const has = sweepEscalation.test(await readRepoFile(`${harness}/chiche-land/SKILL.md`));
		if (harness === "codex" && !has) problems.push("codex/chiche-land/SKILL.md: falta la escalación del barrido del common-dir");
		if (harness !== "codex" && has) problems.push(`${harness}/chiche-land/SKILL.md: la escalación del barrido es solo de Codex`);
	}
	const doc = await readRepoFile("docs/harness-interaction-differences.md");
	if (!/En Codex[^\n]*`codex sandbox -P :workspace`[^\n]*Codex 0\.146\.0[^\n]*borradores en `<git-common-dir>\/chiche\/`[^\n]*escalación[^\n]*sin permiso, escriben en `\.chiche\/` del cwd y lo dicen en el reporte, y esos borradores los resuelve `chiche-land` en su Fase 5/.test(doc)) problems.push("docs/harness-interaction-differences.md: falta la diferencia de Codex con `.git/`");
	if (/borradores en `<git-common-dir>\/sdd\/`|escriben en `\.sdd\/` del cwd/.test(doc)) problems.push("docs/harness-interaction-differences.md: la diferencia de Codex todavía escribe borradores en sdd o cae a .sdd/");
	// Review de #107 (9): `chiche-land` no escribe borradores; su barrido tiene frase propia y, sin permiso, va a `sin resolver`.
	if (!/\. `chiche-land` no escribe borradores: su barrido de la Fase 5 borra los ya aterrizados de `<git-common-dir>\/chiche\/` y `<git-common-dir>\/sdd\/`, pide escalación en Codex y, sin permiso, los manda a `sin resolver` con la ruta y el comando\./.test(doc)) problems.push("docs/harness-interaction-differences.md: la diferencia de Codex no trae la frase propia del barrido de chiche-land");
	if (/y `chiche-land` \(al barrer/.test(doc)) problems.push("docs/harness-interaction-differences.md: chiche-land sigue agrupado entre los skills que escriben borradores");
	if (!/La secuencia de migración de `chiche-init --update` pide la escalación entera en Codex[^\n]*`git mv` escribe `\.git\/index`[^\n]*sin permiso no se migra nada[^\n]*`mantenida \.sdd\/ \(sin permiso para escribir \.git\/\)`/.test(doc)) problems.push("docs/harness-interaction-differences.md: falta la escalación de la migración de chiche-init en Codex");
	assert.deepEqual(problems, []);
});

// Review de #105 (F2): Pi escribe `Chiche-Tracking: version=2`, así que un
// artefacto que otro harness actualiza puede traer cualquiera de los dos
// markers. Cada regla de actualización lo dice, y la regla principal de cada
// skill lo dice con esta frase literal. Los templates de artefactos nuevos
// ya emiten `Chiche-Tracking: version=2` (issue #103, CA-13): el census de
// arriba los exige v2.
const MARKER_BOTH = "`SDD-Tracking: version=1` o `Chiche-Tracking: version=2`";
const MARKER_NEVER_ANOTHER = "nunca se agrega otro";
// Review de #107 (4): una reescritura migra v1 → v2 en su lugar (docs/chiche-tracking-v2.md; es lo que hace
// `upsertSddMetadata` en Pi), así que ninguna regla promete conservar el nombre o la versión del marker.
const MARKER_UPDATE_RULE = "El marker de un artefacto existente es `SDD-Tracking: version=1` o `Chiche-Tracking: version=2`: al reescribirlo se reemplaza en su lugar por `Chiche-Tracking: version=2` conservando los demás campos, y nunca se agrega otro al lado.";
const MARKER_KEEPS_VERSION = /conserv\w+ su nombre|preserva su nombre|su nombre y su versión|su nombre, su versión/;

interface MarkerUpdateRule {
	anchor: RegExp;
	full: boolean;
	harnesses?: readonly Harness[];
}

const MARKER_UPDATE_RULES: Record<"grill" | "chiche-spec" | "chiche-run", MarkerUpdateRule[]> = {
	grill: [
		{ anchor: /Guardar de nuevo hace upsert/, full: true, harnesses: ["claude", "codex", "opencode", "antigravity"] },
		{ anchor: /En Pi lo escribe y actualiza la tool/, full: false, harnesses: ["pi"] },
	],
	"chiche-spec": [
		{ anchor: /`--triage-route update-existing-spec\|audit-existing-spec` exige un target explícito/, full: false, harnesses: ["claude", "codex", "opencode", "antigravity"] },
		{ anchor: /Re-correr sobre la misma spec hace upsert/, full: true },
		{ anchor: /la opción upsertea el marker/, full: false },
		{ anchor: /Ser idempotente: re-correr sobre el mismo pedido/, full: false },
	],
	"chiche-run": [
		{ anchor: /Actualizar la spec \(único artefacto que el run modifica/, full: false },
		{ anchor: /La transición preserva la identidad/, full: true },
		{ anchor: /Mantener la identidad del marker/, full: false },
	],
};

export function markerUpdateProblems(file: string, markdown: string, rules: MarkerUpdateRule[], harness: Harness): string[] {
	const problems: string[] = [];
	for (const rule of rules) {
		if (rule.harnesses && !rule.harnesses.includes(harness)) continue;
		const lines = markdown.split("\n").filter((line) => rule.anchor.test(line));
		if (lines.length === 0) problems.push(`${file}: falta la regla ${rule.anchor}`);
		for (const line of lines) {
			if (!line.includes(MARKER_BOTH)) problems.push(`${file} ${rule.anchor}: no nombra ${MARKER_BOTH}`);
			if (!line.includes(MARKER_NEVER_ANOTHER)) problems.push(`${file} ${rule.anchor}: no dice «${MARKER_NEVER_ANOTHER}»`);
			if (rule.full && !line.includes(MARKER_UPDATE_RULE)) problems.push(`${file} ${rule.anchor}: no lleva la regla literal del marker existente`);
			if (MARKER_KEEPS_VERSION.test(line)) problems.push(`${file} ${rule.anchor}: promete conservar el nombre o la versión del marker, y una reescritura migra v1 → v2`);
		}
	}
	return problems;
}

test("autotest: markerUpdateProblems exige los dos markers y que nunca se agregue otro en cada regla", () => {
	const rules: MarkerUpdateRule[] = [{ anchor: /hace upsert/, full: true }];
	assert.deepEqual(markerUpdateProblems("x", `Guardar hace upsert. ${MARKER_UPDATE_RULE}`, rules, "claude"), []);
	assert.equal(markerUpdateProblems("x", "Guardar hace upsert del marker `SDD-Tracking`, nunca se agrega otro.", rules, "claude").length, 2);
	const keeping = "Guardar hace upsert. El marker de un artefacto es `SDD-Tracking: version=1` o `Chiche-Tracking: version=2`: el existente se reemplaza en su lugar conservando su nombre y su versión, y nunca se agrega otro al lado.";
	assert.equal(markerUpdateProblems("x", keeping, rules, "claude").length, 2, "la regla vieja ni es la literal ni migra v1 → v2");
	assert.equal(markerUpdateProblems("x", "Guardar hace upsert. `SDD-Tracking: version=1` o `Chiche-Tracking: version=2`: preserva su nombre, su versión; nunca se agrega otro.", [{ ...rules[0]!, full: false }], "claude").length, 1);
	assert.deepEqual(markerUpdateProblems("x", "sin la regla", rules, "claude"), ["x: falta la regla /hace upsert/"]);
	assert.deepEqual(markerUpdateProblems("x", "sin la regla", [{ ...rules[0]!, harnesses: ["pi"] }], "claude"), []);
});

test("review #105 (F2): toda regla que actualiza el marker de un artefacto existente acepta SDD-Tracking v1 o Chiche-Tracking v2 y nunca agrega otro, en los cinco harnesses", async () => {
	const problems: string[] = [];
	for (const [skill, rules] of Object.entries(MARKER_UPDATE_RULES)) {
		for (const harness of HARNESSES) {
			const file = `${harness}/${skill}/SKILL.md`;
			problems.push(...markerUpdateProblems(file, await readRepoFile(file), rules, harness));
		}
	}
	const pi = await readRepoFile("pi/grill/SKILL.md");
	if (/garantiza el marker `SDD-Tracking`/.test(pi)) problems.push("pi/grill/SKILL.md: la tool todavía «garantiza el marker `SDD-Tracking`»");
	if (!/cada `pause` y `finalize` upsertea [^\n]* y escribe el marker `Chiche-Tracking: version=2`/.test(pi)) problems.push("pi/grill/SKILL.md: no dice que la tool escribe `Chiche-Tracking: version=2`");
	// Issue #103, T7c: un marker legacy sin `version=` migra a v2 con los mismos campos (no "al formato v1").
	const legacyMigration = "Un marker `SDD-Tracking` legacy (sin `version=`) se migra a `Chiche-Tracking: version=2` en la misma pasada, con los mismos campos.";
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		const markdown = await readRepoFile(file);
		if (!markdown.includes(legacyMigration)) problems.push(`${file}: el marker legacy sin version= no migra a Chiche-Tracking: version=2`);
		if (/se migra al formato v1/.test(markdown)) problems.push(`${file}: todavía migra el marker legacy al formato v1`);
	}
	assert.deepEqual(problems, []);
});

// Spec #84 (CA-17, CA-18 y CA-20): worktrees con dueño, temporales con trap y
// los skills del contrato cierran con Commit + PR.
// Review de #87: todo `git worktree remove` (con o sin backticks) va en el
// patrón literal de la doctrina, no alcanza con un unlock cercano.
function unlockBeforeEveryRemove(markdown: string): boolean {
	const removes = (markdown.match(/git worktree remove/g) ?? []).length;
	const paired = (markdown.match(/`git worktree unlock` y después `git worktree remove`/g) ?? []).length;
	return removes > 0 && removes === paired;
}

test("autotest: unlockBeforeEveryRemove rechaza un unlock ajeno cerca y un remove en prosa", () => {
	assert.equal(unlockBeforeEveryRemove("nunca `git worktree unlock` ajeno; `git worktree remove` de lo propio"), false);
	assert.equal(unlockBeforeEveryRemove("con `git worktree unlock` y después `git worktree remove`; si no, removerlo con git worktree remove"), false);
	assert.equal(unlockBeforeEveryRemove("con `git worktree unlock` y después `git worktree remove`."), true);
});

test("#84 CA-17: chiche-run crea su worktree con --lock --reason y lo desbloquea antes de removerlo", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		const markdown = await readRepoFile(file);
		if (!/`git worktree add --lock --reason "chiche-run <slug>" \.\.\/<repo>-sdd-<slug> -b sdd\/<slug> <base-ref>`/.test(delimitedDoctrine(markdown, "chiche-run-dirty-checkout"))) problems.push(`${file}: el worktree del PR único no nace con --lock --reason "chiche-run <slug>"`);
		if (!/`git worktree add --lock --reason "chiche-run <slug>" \.\.\/<repo>-sdd-<slug> -b sdd\/<slug>\/1-<etapa> <base-ref>`/.test(delimitedDoctrine(markdown, "chiche-run-stack"))) problems.push(`${file}: el worktree del stack no nace con --lock --reason "chiche-run <slug>"`);
		if (!unlockBeforeEveryRemove(markdown)) problems.push(`${file}: algún git worktree remove no va precedido de git worktree unlock`);
		if (!/retenerlo bloqueado para la Fase 6[^\n]*el reporte lo dice/.test(markdown)) problems.push(`${file}: el worktree retenido para la Fase 6 no queda bloqueado ni lo dice el reporte`);
		if (!/- worktree: <removido \| conservado bloqueado \(`chiche-run <slug>`\) en <ruta>>/.test(markdown)) problems.push(`${file}: el reporte no dice si el worktree quedó bloqueado`);
		if (!/`[/$](?:skill:)?chiche-land` solo lo remueve, limpio, cuando su branch ya se mergeó/.test(markdown)) problems.push(`${file}: contradice la excepción de chiche-land para el lock de chiche-run`);
		if (!/Si el worktree ya no existe porque `[/$](?:skill:)?chiche-land` lo removió tras el merge, es una salida normal y no se reintenta/.test(markdown)) problems.push(`${file}: la Fase 6 no tolera el worktree removido por chiche-land`);
	}
	assert.deepEqual(problems, []);
});

test("#84 CA-18: code-review y grill limpian sus temporales con trap", async () => {
	const problems: string[] = [];
	for (const harness of ["codex", "opencode", "pi"] as const) {
		const file = `${harness}/code-review/SKILL.md`;
		const markdown = await readRepoFile(file);
		if (/--lock/.test(markdown)) problems.push(`${file}: el worktree de review no lleva lock`);
		for (const pattern of [
			/review_dir="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/<repo>-review-<PR>-XXXXXX"\)"/,
			// Review de #87: sin lock; un SIGKILL deja el worktree en $TMPDIR y `git worktree prune` lo poda.
			/trap 'git worktree remove --force "\$review_dir"[^']*' EXIT/,
			/git worktree add --detach "\$review_dir" <head-sha>/,
			/[Uu]n `SIGKILL` no corre el `trap`[^\n]*`git worktree prune` lo poda/,
			/vive dentro de un solo comando de shell/,
		]) {
			if (!pattern.test(markdown)) problems.push(`${file}: falta ${pattern}`);
		}
	}
	for (const harness of HARNESSES) {
		const file = `${harness}/grill/SKILL.md`;
		const design = delimitedDoctrine(await readRepoFile(file), "grill-design");
		if (!/trap 'rm -rf -- "<scratch>"' EXIT/.test(design)) problems.push(`${file}: el scratch de capturas no se borra con trap`);
		if (!/`cp -R -- "<scratch>\/\." "<destino>\/" && rm -rf -- "<scratch>"`/.test(design)) problems.push(`${file}: el scratch se borra aunque la copia falle`);
		if (!/si la copia falla, se conserva y el reporte nombra su ruta y las capturas que no se copiaron/.test(design)) problems.push(`${file}: la copia fallida no conserva el scratch`);
	}
	assert.deepEqual(problems, []);
});

test("#84 CA-20: chiche-init, coding-policies y design-system cierran con Commit + PR en los cuatro harnesses", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const problems: string[] = [];
	let reference: string | null = null;
	for (const skill of ["chiche-init", "coding-policies", "design-system"] as const) {
		for (const harness of HARNESSES) {
			const file = `${harness}/${skill}/SKILL.md`;
			const markdown = await readRepoFile(file);
			const block = delimitedDoctrine(markdown, "commit-pr-close");
			for (const pattern of [
				/`Commit \+ PR \(Recomendado\)` \/ `Dejar sin commitear`/,
				new RegExp(`\`git worktree add --lock --reason "${skill} <YYYY-MM-DD>" \\.\\./<repo>-${skill}-<YYYY-MM-DD> -b chore/${skill}-<YYYY-MM-DD> origin/<default>\``),
				/Copiar al worktree, con la misma ruta relativa, solo los paths que esta corrida escribió; commitear, pushear ese branch y abrir el PR/,
				/`git worktree unlock` y después `git worktree remove`/,
				/`ya aterrizado`/,
				// Review de #87; issue #102 CA-5: la aptitud consulta la stop list de ## Autonomy.
				/ninguna fila de la stop list matchea `git push -u origin <branch>`/,
				/se copia solo si `HEAD:<path>` del checkout es igual a `origin\/<default>:<path>` y el path no tenía cambios antes de la corrida/,
				/`git status --porcelain=v1 -z` que la corrida tomó antes de escribir su primer archivo/,
				/el primer sufijo libre \(`-2`, `-3`…\)/,
				new RegExp(`\`gh pr create --base <default> --title "chore\\(${skill}\\): <YYYY-MM-DD>" --body-file <archivo>\``),
				/el cierre queda como commit local sin PR: el reporte nombra el branch, el motivo y el comando para seguir/,
				/En modo desatendido, si el skill lo tiene, no se pregunta y el cierre queda en `Dejar sin commitear`/,
				/Si un skill encadena a otro \(`[/$](?:skill:)?chiche-init` encadena `[/$](?:skill:)?coding-policies` y `[/$](?:skill:)?design-system`\), el cierre lo ofrece una sola vez el que encadenó/,
			]) {
				if (!pattern.test(block)) problems.push(`${file} (commit-pr-close): falta ${pattern}`);
			}
			// Solo los slots del nombre del skill; la regla de encadenado nombra chiche-init a propósito.
			const normalized = normalizeInvocations(block, prefixes[harness])
				.replaceAll(`"${skill} <YYYY-MM-DD>"`, `"<skill> <YYYY-MM-DD>"`)
				.replaceAll(`<repo>-${skill}-`, "<repo>-<skill>-")
				.replaceAll(`chore/${skill}-`, "chore/<skill>-")
				.replaceAll(`chore(${skill})`, "chore(<skill>)");
			const outside = markdown.replace(/<!-- commit-pr-close:start -->[\s\S]*?<!-- commit-pr-close:end -->/, "");
			if (!/pregunta del cierre `Commit \+ PR`/.test(outside)) problems.push(`${file}: la capa de interacción no nombra la pregunta del cierre`);
			if (reference === null) reference = normalized;
			else if (normalized !== reference) problems.push(`${file}: commit-pr-close diverge — ${firstDifference(reference, normalized)}`);
		}
	}
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-init/SKILL.md`;
		if (/^- No commitear nada\.$/m.test(await readRepoFile(file))) problems.push(`${file}: MUST NOT DO todavía prohíbe todo commit`);
	}
	assert.deepEqual(problems, []);
});

// --- Issue #119, capa 2 → issue #130, capa 2: la spec por confianza (CA-17 y CA-18) y los README ---------

// Review #123-1: el ejemplo de la Fase 3 es técnico (lo de producto que llega a la spec es una fuga).
const SPEC_CONFIDENCE_TABLE = /^\| 1 \| ¿Donde se guarda la preferencia del toggle\? \| En localStorage, junto a las otras preferencias \| En el perfil del user, via API \| 70 % \|\n\| 2 \| ¿Como se expone el toggle en el codigo\? \| Con el hook useTheme existente \| Un context nuevo \| 95 % \|$/m;
// Issue #130, CA-17: Resolucion vale `confirmada` o `[ASSUMED NN %]`; una fuga se marca en la tabla.
const SPEC_RESOLUTION_VALUES = /^<la tabla de Fase 3 \+ columna Resolucion: confirmada \(del handoff, o respondida por el usuario antes de publicar o en Solicitar cambios\) \| \[ASSUMED NN %\]; la fila de una fuga suma ` · fuga`>$/m;
const SPEC_RISKS_TEMPLATE = /^<las \[ASSUMED NN %\] de menor a mayor confianza, las fugas marcadas `fuga`, dependencias, flakiness conocida,$/m;
// Issue #130, CA-18: la línea del reporte reemplaza a la del umbral.
const SPEC_REPORT_CONFIDENCE = /^- confianza spec: <n> · preguntadas: <k> · fugas: <f>$/m;
const SPEC_REPORT_REVIEW_FIRST = /^- revisar primero: <fugas y asumidas del grill con NN ≤ confianza grill; después las \[ASSUMED NN %\], de menor a mayor confianza \| ninguna>$/m;
const SPEC_MENU_SUGGESTION = /\*\*Opción sugerida\.\*\* La primera opción del menú, marcada `\(Recomendado\)`, es `chiche-run --mode pr-reviewed` cuando `f = 0` y `a = 0` \(`f` = fugas, decisiones de producto que llegaron a la spec sin cerrar; `a` = decisiones `— asumida NN %` del handoff con `NN ≤ confianza grill`, las que el grill asumió en o debajo de la confianza del grill\), y `chiche-run` en cualquier otro caso; el texto de la pregunta dice el motivo \(`fugas: <f>, asumidas del grill en o debajo de su confianza: <a>`\)\. Las demás opciones no cambian\./;

const SPEC_SIGNATURE: Record<Harness, string> = {
	claude: "/chiche-spec [pedido libre | #NN | URL de issue | ruta de spec] [--from-grill [ruta.md]] [--triage-route update-existing-spec|audit-existing-spec] [--out local|issue] [--confidence <n>] [--until pr]",
	codex: "$chiche-spec [pedido libre | #NN | URL de issue | ruta de spec] [--from-grill [ruta.md]] [--triage-route update-existing-spec|audit-existing-spec] [--out local|issue] [--confidence <n>] [--until pr]",
	opencode: "/chiche-spec [pedido libre | #NN | URL de issue | ruta de spec] [--from-grill [ruta.md]] [--triage-route update-existing-spec|audit-existing-spec] [--out local|issue] [--confidence <n>] [--until pr]",
	pi: "/skill:chiche-spec [pedido libre | #NN | URL de issue | ruta de spec] [--from-grill [ID|ruta.md]] [--out local|issue] [--confidence <n>] [--until pr]",
	antigravity: "/chiche-spec [pedido libre | #NN | URL de issue | ruta de spec] [--from-grill [ruta.md]] [--triage-route update-existing-spec|audit-existing-spec] [--out local|issue] [--confidence <n>] [--until pr]",
};

// Los cuatro bloques compartidos del dial los fija autonomy-gate; acá se mira la prosa de afuera.
function withoutDialBlocks(markdown: string): string {
	let text = markdown;
	for (const name of ["autonomy-controls", "autonomy-resolve", "autonomy-confidence", "autonomy-contract"]) {
		text = text.replace(new RegExp(`<!-- ${name}:start -->\\n[\\s\\S]*?\\n<!-- ${name}:end -->`, "g"), "");
	}
	return text;
}

// Vocabulario del modelo de niveles, retirado en 6.0.0. Los nombres se arman a pedazos para que este archivo
// no los lleve escritos de corrido (el brief de la capa 2 los prohíbe fuera de los bloques compartidos).
const RETIRED_DIAL_WORDS: RegExp[] = [
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
];

export function retiredDialProblems(file: string, markdown: string): string[] {
	const problems: string[] = [];
	withoutDialBlocks(markdown).split("\n").forEach((line, index) => {
		for (const pattern of RETIRED_DIAL_WORDS) if (pattern.test(line)) problems.push(`${file} (línea ${index + 1} sin los bloques): sobra ${pattern}`);
	});
	return problems;
}

test("#130 CA-17: la firma de chiche-spec lleva [--confidence <n>] [--until pr] en los cinco harnesses (también en el atajo de la Fase 0), con el bullet del flag y --until pr sin exigir nada", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		const markdown = await readRepoFile(file);
		const signature = markdown.split("\n").filter((line) => /^(?:\/|\$|\/skill:)chiche-spec \[/.test(line));
		if (signature.length !== 1 || signature[0] !== SPEC_SIGNATURE[harness]) problems.push(`${file}: la firma no es \`${SPEC_SIGNATURE[harness]}\` (hay: ${signature.join(" | ")})`);
		for (const [label, pattern] of [
			["atajo de la Fase 0", /^Atajo: [^\n]*\[--out local\|issue\] \[--confidence <n>\] \[--until pr\] saltea este menu\.$/m],
			["bullet --confidence", /^- `--confidence <n>` — confianza de esta corrida, un entero de 0 a 100; manda sobre la fila `spec` de `## Autonomy` del contrato\. Las inferencias técnicas y las fugas con confianza `≤ <n>` se preguntan antes de publicar y las que la superan quedan `\[ASSUMED NN %\]`: `0` no pregunta nada, `80` pregunta solo lo dudoso y `100` pregunta todo y termina en el menú final; por debajo de 100 no hay menú\./m],
			["bullet --confidence: contrato faltante", /Si falta el contrato, con confianza menor que 100 corre `[^`\s]*chiche-init --defaults` y con 100 ofrece `[^`\s]*chiche-init`\./],
			["referencias cruzadas", /Las decisiones ya confirmadas por grill nunca se degradan a supuestos\. Ver «Controles de autonomía», «Controles efectivos» y «Tipo y confianza»\./],
			["bullet --until pr", /^- `--until pr` — hasta dónde llega la cadena; no exige ni cambia ningún otro control: qué se pregunta lo sigue decidiendo la confianza\. Con el flag, la spec se publica `draft`, pasa a `approved` bajo el gate de publicación \(registra `spec\.published` y `spec\.approved`\) y lanza `[^`\s]*chiche-run <target>` sin flags: el run lee su posición del contrato \(ver «Flujo sin fricción»\)\. Con 100 y `--until pr` pregunta todo, no muestra el menú, aprueba y lanza el run\. Sin `--until pr` termina en `Spec lista`\. `--until` con cualquier otro valor aborta listando el único válido \(`pr`\)\. El flag no existe en `chiche-run`: al lanzarlo no se le pasa\./m],
		] as const) {
			if (!pattern.test(markdown)) problems.push(`${file}: falta ${label}`);
		}
		if (/--until pr exige/.test(markdown)) problems.push(`${file}: el diagnóstico «--until pr exige …» no existe más`);
	}
	assert.deepEqual(problems, []);
});

test("#130 CA-17: chiche-spec pregunta antes de publicar las técnicas con confianza ≤ confianza spec en rondas de hasta cuatro y las fugas con la misma regla, sin contrato encadena chiche-init --defaults por debajo de 100, y la tabla lleva confirmada | [ASSUMED NN %] con la fuga marcada", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		const markdown = await readRepoFile(file);
		for (const [label, pattern] of [
			["tabla de la Fase 3 con NN %", SPEC_CONFIDENCE_TABLE],
			["valores de Resolucion", SPEC_RESOLUTION_VALUES],
			["Riesgos y gaps del template", SPEC_RISKS_TEMPLATE],
			["Fase 1: sin contrato y confianza 100", /^- \*\*Si NO existe y la confianza es `100`\*\*: frenar\.[^\n]*ofrecer `[^`\s]*chiche-init --defaults` como vía rápida\.$/m],
			["Fase 1: sin contrato y confianza menor que 100", /^- \*\*Si NO existe y la confianza es menor que 100\*\*: correr `[^`\s]*chiche-init --defaults` automáticamente, anotarlo en el reporte, y seguir\.$/m],
			["Fase 3: confianza entera", /`Confianza` es un entero `NN %`: la probabilidad de que la elección propuesta sea la correcta; la confianza de la etapa es la `confianza spec` que imprime el resolver de «Controles efectivos» \(ver «Tipo y confianza»\)/],
			["Fase 3: preguntar antes de publicar", /Antes de publicar, las inferencias con confianza `≤ confianza spec` se preguntan[^\n]*en rondas de hasta cuatro[^\n]*y las fugas con la misma regla; las que la superan no se preguntan: se resuelven con la elección propuesta y van a la sección `## Inferencias` de la spec, marcadas `\[ASSUMED NN %\]`\. Con `100` se preguntan todas y con `0` ninguna\./],
			["Fase 3: la fuga se trata por confianza", /Una fuga \(una decisión de producto que llegó a la spec sin cerrar, ej\. "¿esto es solo UI o también API\?"\) entra a la tabla marcada `fuga` y se trata por confianza como cualquier otra: con confianza `≤ confianza spec` se pregunta y, si la supera, queda `\[ASSUMED NN %\]`; nunca frena la spec\./],
			["Fase 3: riesgos de menor a mayor", /Las `\[ASSUMED NN %\]` se listan además en `## Riesgos y gaps` de menor a mayor confianza, con las fugas marcadas `fuga`, y el reporte nombra las fugas, para que el usuario las mire primero\./],
			["Estado del template", /^Estado: siempre `draft` al publicar; `aprobada` solo por una de las tres transiciones de "Flujo sin fricción": elegir un run en el menú final, responder al menos una pregunta por debajo de 100, o `--until pr`\.$/m],
			["MUST DO: listar todas", /^- Listar TODAS las inferencias nuevas en la spec, también las que superan la confianza de la etapa, marcadas `\[ASSUMED NN %\]`/m],
			["MUST DO: preguntar antes de publicar", /^- Preguntar antes de publicar las inferencias técnicas y las fugas con confianza `≤ confianza spec`, en rondas de hasta cuatro\.$/m],
			["MUST DO: contrato", /^- Leer `\.chiche\/project\.md` antes que nada; si no existe, exigir `[^`\s]*chiche-init` primero \(ofrecerlo con confianza `100`; orquestarlo con `--defaults` por debajo de 100\)\.$/m],
			["MUST DO: menú", /^- Terminar con el menú final \(solo con confianza `100` y sin `--until pr`\): publicar primero, ofrecer el menú después\.$/m],
			["MUST NOT: no frenar de más", /^- No frenar a preguntar el mecanismo ni el destino, ni una inferencia con confianza `> confianza spec`, antes de publicar: van escritos en la spec y se corrigen sobre la spec publicada\.$/m],
		] as const) {
			if (!pattern.test(markdown)) problems.push(`${file}: falta ${label} ${pattern}`);
		}
		for (const stale of [/\| media \|$/m, /\| alta \|$/m, /también las de confianza alta/, /inferencias de confianza baja que definen alcance/, /elegida por usuario: <x>/, /La tabla NO se pregunta/, /No frenar a preguntar inferencias, mecanismo ni destino antes de publicar/, /volvé al grill/]) {
			if (stale.test(markdown)) problems.push(`${file}: sobra ${stale}`);
		}
	}
	assert.deepEqual(problems, []);
});

test("#130 CA-18: el menú final de chiche-spec (solo con 100) ofrece Llevar a issue, chiche-run, chiche-run --mode pr-reviewed y Solicitar cambios, sugiere pr-reviewed sin fugas ni asumidas del grill, el reporte dice confianza spec · preguntadas · fugas, y docs/harness-interaction-differences.md lo lleva a los menús en texto plano", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		const markdown = await readRepoFile(file);
		const flow = delimitedDoctrine(markdown, "chiche-spec-flow");
		for (const [label, pattern] of [
			["menú solo con 100", /\*\*Menú final \(solo con confianza `100`\)\.\*\*/],
			["opciones de la spec en .md", /^- Spec en `\.md`: `Llevar a issue` \/ `chiche-run` \/ `chiche-run --mode pr-reviewed` \/ `Solicitar cambios`\.$/m],
			["opciones de la spec en issue", /^- Spec en issue: `chiche-run` \/ `chiche-run --mode pr-reviewed` \/ `Solicitar cambios`\.$/m],
			["opción sugerida", SPEC_MENU_SUGGESTION],
			["k no entra en la regla", /`k`, las preguntadas del reporte, no entra en la regla: con `100` se preguntaron todas/],
			["chiche-run sin flags", /`chiche-run` lanza el run sin flags: el run lee su posición del contrato\. `chiche-run --mode pr-reviewed` lo lanza con ese flag/],
		] as const) {
			if (!pattern.test(flow)) problems.push(`${harness}/chiche-spec: chiche-spec-flow no fija ${label}`);
		}
		for (const [label, pattern] of [
			["línea de confianza del reporte", SPEC_REPORT_CONFIDENCE],
			["revisar primero", SPEC_REPORT_REVIEW_FIRST],
			["menú después del reporte", /el menú final de "Flujo sin fricción"[^\n]*\(solo con confianza `100` y sin `--until pr`\)/],
		] as const) {
			if (!pattern.test(markdown)) problems.push(`${file}: falta ${label} ${pattern}`);
		}
	}
	const docs = await readRepoFile("docs/harness-interaction-differences.md");
	if (!/menú final de `chiche-spec`[^\n]*texto plano[^\n]*primera opción numerada lleva `\(Recomendado\)`[^\n]*`chiche-run --mode pr-reviewed`[^\n]*`fugas: 0`[^\n]*`chiche-run` en cualquier otro caso/.test(docs)) problems.push("docs/harness-interaction-differences.md: no refleja la opción sugerida para los menús en texto plano");
	assert.deepEqual(problems, []);
});

test("#130 CA-14 (chiche-spec): fuera de los bloques compartidos del dial, ningún chiche-spec/SKILL.md nombra niveles, --autonomy, umbrales ni [NEEDS-INPUT]", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		problems.push(...retiredDialProblems(file, await readRepoFile(file)));
	}
	assert.deepEqual(problems, []);
});

test("autotest: retiredDialProblems marca el vocabulario de niveles fuera de los bloques compartidos, no lo marca adentro y acepta el vocabulario nuevo", () => {
	const level = ["un", "attended"].join("");
	const flag = ["--auto", "nomy"].join("");
	const inside = ["<!-- autonomy-resolve:start -->", `\`${level}\` o \`A3\` → \`usá --confidence 0\``, "<!-- autonomy-resolve:end -->"].join("\n");
	assert.deepEqual(retiredDialProblems("x", inside), []);
	assert.equal(retiredDialProblems("x", `${inside}\nCon A2 o A3: no hay menú, y ${flag} A3 lanza el run.`).length, 2);
	for (const phrase of ["debajo del umbral", "umbral spec: <n>", "**Nivel sugerido.**", "fugas [NEEDS-INPUT]", "en cualquier nivel de autonomía"]) {
		assert.equal(retiredDialProblems("x", phrase).length, 1, `marca: ${phrase}`);
	}
	for (const phrase of ["confianza spec: <n> · preguntadas: <k> · fugas: <f>", "`chiche-run --mode pr-reviewed`", "**Opción sugerida.**", "`## Autonomy` del contrato", "por debajo de 100 no hay menú"]) {
		assert.deepEqual(retiredDialProblems("x", phrase), [], `acepta: ${phrase}`);
	}
});

test("#130 CA-27 (filas grill y chiche-spec): los dos README nombran la confianza numérica y el flag --confidence, sin niveles ni umbral, y no hablan de impacto alto", async () => {
	const problems: string[] = [];
	for (const [path, grill, spec] of [
		["README.md", [/confianza numérica `NN %`/, /`--confidence`/, /`\[ASSUMED NN %\]`/, /\*\*Para la spec\.\*\*/, /por debajo de 100[^|]*congela el handoff sin pedir confirmación/], [/`NN %`/, /`--confidence`/, /`\[ASSUMED NN %\]`/, /por debajo de 100 no muestra el menú final/]],
		["README.en.md", [/numeric confidence `NN %`/, /`--confidence`/, /`\[ASSUMED NN %\]`/, /\*\*Para la spec\.\*\*/, /below 100[^|]*freezes the handoff without asking for confirmation/], [/`NN %`/, /`--confidence`/, /`\[ASSUMED NN %\]`/, /below 100 it skips the final menu/]],
	] as const) {
		const markdown = await readRepoFile(path);
		const grillRow = markdown.split("\n").find((line) => line.startsWith("| **`grill`** |")) ?? "";
		const specRow = markdown.split("\n").find((line) => line.startsWith("| **`chiche-spec`** |")) ?? "";
		for (const pattern of grill) if (!pattern.test(grillRow)) problems.push(`${path} fila grill: falta ${pattern}`);
		for (const pattern of spec) if (!pattern.test(specRow)) problems.push(`${path} fila chiche-spec: falta ${pattern}`);
		if (/impacto alto|high-impact/.test(`${grillRow}\n${specRow}`)) problems.push(`${path}: las filas siguen hablando de impacto alto`);
		for (const pattern of [...RETIRED_DIAL_WORDS, /\bthresholds?\b/i]) if (pattern.test(`${grillRow}\n${specRow}`)) problems.push(`${path}: las filas grill y chiche-spec siguen con ${pattern}`);
	}
	assert.deepEqual(problems, []);
});

// Review de #123 (ronda 1) → issue #130: la spec trata solo decisiones técnicas, consume `**Para la spec.**`,
// pregunta por confianza antes de publicar y aprueba al responder; los README y el contrato lo dicen igual.
test("review #123 → #130: la Fase 3 de chiche-spec es técnica (lo de producto es fuga), `**Para la spec.**` entra a la tabla con su confianza y cuenta para k si se pregunta, una respuesta es `confirmada`, y los README nombran las fugas", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-spec/SKILL.md`;
		const markdown = await readRepoFile(file);
		for (const [label, pattern] of [
			["idea fuerza por confianza", /queda escrita en la spec con su confianza: `\[ASSUMED NN %\]` si supera la confianza de la etapa, o `confirmada` si se preguntó antes de publicar \(ver «Tipo y confianza»\)/],
			["Fase 2 paso 2 no confirma Para la spec", /como fuente confirmada \(las decisiones técnicas anotadas en `\*\*Para la spec\.\*\*` no: van a la tabla de la Fase 3, ver sus Reglas\)/],
			["categorías técnicas", /Toda decisión técnica que el pedido no fija explícitamente se lista como inferencia[^\n]*Categorías típicas: datos \(¿migración\? ¿backfill\?\), estructura y seams, compatibilidad hacia atrás, plataformas y herramientas, mecanismo de verificación\. Lo de producto \(alcance, comportamiento visible, UX\/copys\) no es inferencia: una decisión de producto que llega sin cerrar es una fuga, punto \(7\) de «Tipo y confianza»/],
			["Para la spec en Reglas", /Las decisiones técnicas anotadas en `\*\*Para la spec\.\*\*` del handoff NO están fijadas: cada una entra a la tabla como inferencia técnica con su propia confianza `NN %` contra `confianza spec`[^\n]*y, si se pregunta, cuenta para `k`\. Una respuesta del usuario \(a una pregunta de esta fase, o por `Solicitar cambios`\) pasa la fila a `confirmada`/],
		] as const) {
			if (!pattern.test(markdown)) problems.push(`${file}: falta ${label}`);
		}
		for (const stale of [/Categorías típicas: alcance/, /marcadas `\[ASSUMED\]` sin preguntar/, /¿Aplica a paginas de admin\?/]) {
			if (stale.test(markdown)) problems.push(`${file}: sobra ${stale}`);
		}
	}
	for (const [path, pattern] of [
		["README.md", /pregunta antes de publicar las inferencias técnicas con confianza en o debajo de la confianza de la spec y las fugas de producto/],
		["README.en.md", /asks before publishing the technical inferences at or below the spec confidence and the product leaks/],
	] as const) {
		const row = (await readRepoFile(path)).split("\n").find((line) => line.startsWith("| **`chiche-spec`** |")) ?? "";
		if (!pattern.test(row)) problems.push(`${path}: la fila chiche-spec no nombra las fugas`);
	}
	// Review #123-10: la fila del contrato describe la regla del menú como la fija la doctrina.
	const contractRow = (await readRepoFile(".chiche/project.md")).split("\n").find((line) => line.startsWith("| gate anti-drift SDD |")) ?? "";
	if (!/la primera opcion, marcada `\(Recomendado\)`, es `chiche-run --mode pr-reviewed` solo sin fugas ni asumidas del grill en o debajo de su confianza, y `chiche-run` en otro caso/.test(contractRow)) problems.push("contrato: la fila de harness-gate describe la regla del menú distinto que la doctrina");
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Issue #130, capa 2 (CA-19 y CA-20): la posición del run. `chiche-run` deja `--autonomy` y los niveles con nombre y
// pasa a `--mode <ask|pr|pr-reviewed>`; la conducta de `ask`, `pr` y `pr-reviewed` es, regla por regla, la de A1, A2 y
// A3. Reemplazan a los tests del run que vivían en autonomy-gate (CA-8 y CA-11 del issue #102, review #114-5/6 y
// CA-13 del issue #119), con el vocabulario nuevo.

const RUN_SUBAGENT_HARNESSES: readonly Harness[] = ["claude", "antigravity", "pi"];
const RUN_SUBAGENT_TITLE = "Run con subagente (solo con pr-reviewed y sin --inline)";
// Lo que cada harness suma después de `[--inline]`, donde ya existía: Claude Code fija modelo y effort; Antigravity
// fija el modelo y acepta `--effort` solo para descartarlo (por eso está en la firma y no en el atajo de la Fase 0); y
// Codex, opencode y Pi nada (los dos primeros corren inline; en Pi el hijo hereda la sesión).
const RUN_SIGNATURE_TAIL: Record<Harness, string> = { claude: " [--model M] [--effort E]", codex: "", opencode: "", pi: "", antigravity: " [--model M] [--effort E]" };
const RUN_SHORTCUT_TAIL: Record<Harness, string> = { ...RUN_SIGNATURE_TAIL, antigravity: " [--model M]" };
const RUN_INLINE_HARNESS_NAME: Partial<Record<Harness, string>> = { codex: "Codex", opencode: "opencode" };

// Sección por título (niveles 2 a 4), hasta el próximo heading del mismo nivel o superior; los headings dentro de un
// fence no cuentan.
function runSection(markdown: string, heading: RegExp): string {
	const lines = markdown.split("\n");
	let fence = false;
	let start = -1;
	let level = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		const match = /^(#{2,4}) (.*)$/.exec(line);
		if (!match) continue;
		const depth = match[1]?.length ?? 0;
		if (start === -1) {
			if (heading.test(match[2] ?? "")) {
				start = index;
				level = depth;
			}
			continue;
		}
		if (depth <= level) return lines.slice(start, index).join("\n");
	}
	return start === -1 ? "" : lines.slice(start).join("\n");
}

function missingIn(text: string, patterns: RegExp[]): string[] {
	return patterns.filter((pattern) => !pattern.test(text)).map((pattern) => `falta ${pattern}`);
}

// Los bloques `autonomy-controls` y `autonomy-resolve` son compartidos (los gatea autonomy-gate) y nombran los niveles
// viejos a propósito, en el mapa de equivalentes de `--autonomy`.
function withoutAutonomyBlocks(markdown: string): string {
	return markdown.replace(/<!-- (autonomy-[a-z]+):start -->\n[\s\S]*?\n<!-- \1:end -->/g, (block) => block.replace(/[^\n]/g, ""));
}

test("#130 CA-19: la firma de chiche-run lleva [--mode <ask|pr|pr-reviewed>] [--inline], --inline/--model/--effort exigen pr-reviewed con su diagnóstico literal, «Run con subagente» se titula por la posición en Claude Code, Antigravity y Pi, y Codex y opencode corren pr-reviewed inline", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		const markdown = await readRepoFile(file);
		const prefix = escapeRegExp(prefixes[harness]);
		const args = runSection(markdown, /^Argumentos$/);
		const signature = fencedBlocks(args)[0]?.content ?? "";
		if (!signature.endsWith(` [--no-pr] [--base <branch>] [--mode <ask|pr|pr-reviewed>] [--inline]${RUN_SIGNATURE_TAIL[harness]}`)) problems.push(`${file}: la firma no termina en [--no-pr] [--base <branch>] [--mode <ask|pr|pr-reviewed>] [--inline]${RUN_SIGNATURE_TAIL[harness]}: ${signature}`);
		const shortcut = `Atajo: ${prefixes[harness]}chiche-run <spec|#NN> [--no-pr] [--mode <ask|pr|pr-reviewed>] [--inline]${RUN_SHORTCUT_TAIL[harness]} saltea este menu.`;
		if (!runSection(markdown, /^Fase 0 — /).includes(shortcut)) problems.push(`${file}: la Fase 0 no trae '${shortcut}'`);
		problems.push(...missingIn(args, [
			new RegExp(`^- \`--mode <ask\\|pr\\|pr-reviewed>\` — posición del run en esta corrida; manda sobre la fila \`run\` de \`## Autonomy\` del contrato\\. \`ask\` pregunta ante choques del plan y desviaciones de alcance y ofrece el menú post-PR; \`pr\` corre hasta el PR sin preguntar \\(encadena \`${prefix}chiche-spec <target>\` sin flags y \`${prefix}chiche-init --defaults\` si faltan precondiciones, no frena ante choques del plan con políticas y resuelve desviaciones con sesgo mínimo seguro\\), lanza el \`Code review\` y termina; \`pr-reviewed\` [^\\n]*hasta 2 rondas \\(Fase 6\\)\\. Ver «Controles de autonomía» y «Controles efectivos»\\.$`, "m"),
			/^- `--inline` — solo con `pr-reviewed` \(por flag o por contrato\): [^\n]*Con otra posición aborta con `--inline exige --mode pr-reviewed`\.$/m,
		]).map((problem) => `${file} ## Argumentos: ${problem}`));
		const inlineName = RUN_INLINE_HARNESS_NAME[harness];
		if (inlineName) {
			problems.push(...missingIn(args, [
				new RegExp(`En ${inlineName} no hay subagentes: con \`pr-reviewed\` el run corre inline en esta sesión con la conducta de \`pr\` más la corrección automática del feedback de la Fase 6, hasta 2 rondas`),
				new RegExp(`\`run: pr-reviewed · corre inline en ${inlineName}\``),
				/`--model` y `--effort` abortan con `--model\/--effort: este harness corre pr-reviewed inline`/,
				/^- `--mode <ask\|pr\|pr-reviewed>` — [^\n]*`pr-reviewed` corre inline con la conducta de `pr` más la corrección automática del feedback del review, hasta 2 rondas \(Fase 6\)\./m,
			]).map((problem) => `${file} ## Argumentos: ${problem}`));
			if (/^## Run con subagente/m.test(markdown)) problems.push(`${file}: no tiene subagentes y no debe ganar «Run con subagente»`);
			if (/exigen --mode pr-reviewed/.test(markdown)) problems.push(`${file}: --model/--effort no existen acá: el único diagnóstico es el de pr-reviewed inline`);
			continue;
		}
		const headings = markdown.split("\n").filter((line) => line.startsWith("## Run con subagente"));
		if (headings.length !== 1 || headings[0] !== `## ${RUN_SUBAGENT_TITLE}`) problems.push(`${file}: el heading no es literalmente '## ${RUN_SUBAGENT_TITLE}': ${headings.join(" / ")}`);
		const subagent = runSection(markdown, /^Run con subagente /);
		problems.push(...missingIn(subagent, [
			/^Con posición `pr-reviewed` y sin `--inline`, la sesión es \*\*lanzadora, no corredora\*\*/m,
			/corre la Fase 6 de `pr-reviewed` él mismo/,
			/Con `--inline` nada de esta sección aplica: el run corre en esta sesión con la conducta de `pr-reviewed`/,
			/con la doctrina de `pr-reviewed`: sin preguntar/,
			new RegExp(`encadenaría en background \`${prefix}chiche-init --defaults\` o \`${prefix}chiche-spec <target>\` sobre algo que nadie revisó`),
			new RegExp(`^1\\. \\*\\*Contrato\\*\\* \\(Fase 1, paso 1\\): [^\\n]*Si no existe: correr \`${prefix}chiche-init --defaults\` y seguir\\.$`, "m"),
			new RegExp(`^2\\. \\*\\*Spec\\*\\* \\(Fase 1, pasos 2 y 3\\): [^\\n]*Si no: encadenar \`${prefix}chiche-spec <target>\` en esta sesión, sin flags, y lanzar sobre la spec resultante`, "m"),
			new RegExp(`\`${prefix}chiche-run <target> --mode pr-reviewed --inline\` \\(más \`--no-pr\`/\`--base\` si vinieron\\)`),
			/^- Con `ask` o `pr`, o con `--inline`, nada de lo anterior aparece y el run corre en esta sesión\.$/m,
		]).map((problem) => `${file} «Run con subagente»: ${problem}`));
		if (harness === "pi") {
			problems.push(...missingIn(subagent, [/tool `subagent`/, /agent: "implementer"/, /background: true/, /PI_SUBAGENT_DEPTH=1/, /En Pi no existen `--model` ni `--effort`/]).map((problem) => `${file}: ${problem}`));
			// CA-25 (el código lo cambia otra unidad): la tool de Pi lleva `mode`, no `autonomy`.
			if (!/invocá inmediatamente `launch_sdd_run` con ese target exacto, más `mode: <posición>` si vino `--mode <posición>`, y terminá el turno/.test(args)) problems.push(`${file}: launch_sdd_run no lleva mode: <posición>`);
			if (/exigen --mode pr-reviewed/.test(markdown)) problems.push(`${file}: en Pi no existen --model ni --effort y no hay diagnóstico que dar`);
			continue;
		}
		// Pi no nombra al subagente en «Ownership y tareas»: su lanzador delega con la tool `subagent` y el hijo no anida.
		problems.push(...missingIn(runSection(markdown, /^Ownership y tareas$/), [
			/lanzado por «Run con subagente» en `pr-reviewed`\) conserva ownership/,
			/^- La sesión que lanza en `pr-reviewed` sin `--inline` no es el agente que corre/m,
		]).map((problem) => `${file} Ownership y tareas: ${problem}`));
		problems.push(...missingIn(args, [/[Ss]olo (?:son válidos|es válido) con `pr-reviewed` \(por flag o por contrato\); con otra posición abort(?:an|a) con `--model\/--effort exigen --mode pr-reviewed`/]).map((problem) => `${file} ## Argumentos: ${problem}`));
		problems.push(...missingIn(subagent, [
			/^- `pr-reviewed` no pregunta: `model` es `--model` si vino y, si no, el escalón derivado/m,
			/solo (?:son válidos|es válido) con `pr-reviewed`: con otra posición el run aborta con `--model\/--effort exigen --mode pr-reviewed` antes de cualquier mutación/,
		]).map((problem) => `${file} «Run con subagente»: ${problem}`));
	}
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("#130 CA-19: la conducta de ask, pr y pr-reviewed es la de A1, A2 y A3 en los cinco harnesses: precondiciones y encadenamiento, choques del plan con políticas, desviaciones de alcance, preflight de stack, snapshot de la Fase 5 y MUST DO", async () => {
	const { prefixes } = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		const markdown = await readRepoFile(file);
		const prefix = escapeRegExp(prefixes[harness]);
		problems.push(...missingIn(runSection(markdown, /^Fase 1 — /), [
			new RegExp(`^1\\. \\*\\*Contrato\\*\\*: [^\\n]*Si no existe en ninguno de los dos: con \`ask\` → ofrecer \`${prefix}chiche-init\` ahí mismo; con \`pr\` o \`pr-reviewed\` → correr \`${prefix}chiche-init --defaults\` y seguir\\.`, "m"),
			new RegExp(`^2\\. \\*\\*Spec\\*\\*: [^\\n]*Pedido libre sin spec → frenar: ofrecer \`${prefix}chiche-spec <pedido>\` \\(\`ask\`\\) o encadenar \`${prefix}chiche-spec <pedido>\` sin flags \\(\`pr\` o \`pr-reviewed\`\\)\\. La spec encadenada pregunta lo que pida su propia confianza: la posición del run no la cambia\\. NO improvisar una spec`, "m"),
		]).map((problem) => `${file} Fase 1: ${problem}`));
		problems.push(...missingIn(runSection(markdown, /^Fase 2 — /), [
			/si la spec entera no cabe, frenar y preguntar: [^\n]*; con `pr` o `pr-reviewed` → seguir y que el gate del cierre juzgue\./,
			/`preguntar` → frenar y preguntar antes de implementar; con `pr` o `pr-reviewed`, no agregar la dep: replantear sin ella o dejarla como FALLA honesta\./,
		]).map((problem) => `${file} Fase 2: ${problem}`));
		problems.push(...missingIn(runSection(markdown, /^Fase 3 — /), [
			/^4\. \*\*Desviaciones\*\*: [^\n]*si cambia el alcance, con `ask` → preguntar con [^\n]* y editar la spec según la respuesta; con `pr` o `pr-reviewed` → abortar honesto con el estado committeado en el branch\./m,
		]).map((problem) => `${file} Fase 3: ${problem}`));
		problems.push(...missingIn(delimitedDoctrine(markdown, "chiche-run-flow"), [
			/si cambia el alcance, preguntar \(con `pr` o `pr-reviewed`, abortar honesto con el estado committeado en el branch\)\./,
			/La oferta existe solo en `ask`: con `pr` se lanza `Code review` y la corrida termina; con `pr-reviewed` corren `Code review` y `Resolver feedback automáticamente` sin preguntar \(ver «Por posición» en la Fase 6\)\./,
		]).map((problem) => `${file} chiche-run-flow: ${problem}`));
		problems.push(...missingIn(delimitedDoctrine(markdown, "chiche-run-stack"), [
			/Si falta la extensión: con `ask`, ofrecer `gh extension install github\/gh-stack` ahí mismo y seguir si se instala; con `pr` o `pr-reviewed` frena antes de ramificar e imprime el comando exacto\. Una versión vieja de `gh` o de `git` frena en las tres posiciones, con el diagnóstico\./,
		]).map((problem) => `${file} chiche-run-stack: ${problem}`));
		problems.push(...missingIn(runSection(markdown, /^Fase 5 — /), [
			/si la posición es `ask` o `pr-reviewed` y la corrida creó un PR \(con `pr` se lanza el review y la corrida termina\)/,
		]).map((problem) => `${file} Fase 5: ${problem}`));
		problems.push(...missingIn(runSection(markdown, /^MUST DO$/), [
			new RegExp(`^- Exigir spec y contrato antes de tocar código; con \`pr\` o \`pr-reviewed\` encadenarlos \\(\`${prefix}chiche-spec <target>\` sin flags y \`${prefix}chiche-init --defaults\`\\), con \`ask\` ofrecerlos\\.$`, "m"),
			/^- Después de un `Run completo` con PR en `ask`, ofrecer la remediación opt-in/m,
		]).map((problem) => `${file} MUST DO: ${problem}`));
		if (harness === "codex" && !/^En Codex, [^\n]*Con `pr` o `pr-reviewed`, saltear únicamente los gates que este skill declara salteables; nunca saltear permisos para efectos externos\.$/m.test(markdown)) problems.push(`${file}: la capa de Codex no acota qué gates se saltean con pr o pr-reviewed`);
	}
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("#130 CA-19 (#119 CA-13): lanzado desde chiche-spec --until pr, chiche-run arranca en la posición del contrato, no vuelve a encadenar la spec, su traza repite until: pr y sigue sin aceptar --until, en los cinco harnesses", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		const markdown = await readRepoFile(file);
		problems.push(...missingIn(runSection(markdown, /^Fase 1 — /), [
			/^2\. \*\*Spec\*\*: [^\n]*Cuando esta sesión viene de `[^`]*chiche-spec --until pr` \(la señal es el contexto de la sesión, o la línea del prompt que el lanzador le pasa al subagente[^\n]*el target ya es una spec `approved` y no se encadena `[^`]*chiche-spec` otra vez; la traza del run repite `until: pr` después de `leído de <fuente>`\./m,
			/^2\. \*\*Spec\*\*: [^\n]*Este skill no acepta `--until`: `chiche-spec` lo consume y lanza el run sin flags, así que el run arranca en la posición del contrato\.$/m,
		]).map((problem) => `${file} Fase 1: ${problem}`));
		const signature = fencedBlocks(runSection(markdown, /^Argumentos$/))[0]?.content ?? "";
		if (/--until/.test(signature)) problems.push(`${file}: la firma no debe ganar --until`);
		if (!RUN_SUBAGENT_HARNESSES.includes(harness)) continue;
		if (!/Cuando esta sesión viene de `[^`]*chiche-spec --until pr`, el target ya es una spec `approved`: no se encadena `[^`]*chiche-spec` otra vez/.test(runSection(markdown, /^Precondiciones del lanzador$/))) problems.push(`${file}: las precondiciones del lanzador no cierran el doble encadenado`);
		if (!/^- Cuando esta sesión viene de `[^`]*chiche-spec --until pr`, la traza suma `until: pr` después de `leído de <fuente>`, y el prompt del subagente lleva una línea que lo dice para que su traza lo repita/m.test(runSection(markdown, /^Traza$/))) problems.push(`${file}: la traza del lanzador no suma until: pr después de leído de <fuente>`);
	}
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("#130 CA-20: la Fase 6 de chiche-run fija la conducta por posición en los cinco harnesses: ask ofrece el menú, pr lanza el review y termina, y pr-reviewed corrige solo, hasta 2 rondas, con el tope de 30 minutos y los reportes Feedback resuelto y SEGUIMIENTO DE FEEDBACK DETENIDO", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		const phase6 = runSection(await readRepoFile(file), /^Fase 6 — /);
		problems.push(...missingIn(phase6, [
			/^1\. \*\*Baseline sin carrera\*\*: con posición `ask` o `pr-reviewed`, inmediatamente después de crear el PR/m,
			/Con `pr` o `pr-reviewed` no se pregunta: ver «Por posición»\. Tampoco ofrecerla con `--no-pr`/,
			/^\*\*Por posición\.\*\* Con `ask` rige el menú del paso 2\. Con `pr` no se pregunta: se lanza `Code review` \(con la rama de este harness\) y la corrida termina sin esperar; los findings los lee el humano\. Con `pr-reviewed` no se pregunta: se ejecutan `Code review` y `Resolver feedback automáticamente` y el run corrige el feedback del review solo, hasta 2 rondas; al tercer lote de feedback se dejan los threads abiertos y se reporta\./m,
			/Corre en el mismo agente que corrió el run \(el `implementer` delegado, o la sesión con `--inline`\); el lanzador solo releva/,
			/Sin `\.github\/workflows\/claude-review\.yml`, el review corre en ese mismo agente con el code review nativo \(`[^`]*code-review[^`]*` sobre el PR\), sin lanzar otro subagente/,
			/[Ss]i el code review nativo no está disponible[^\n]*avisar y seguir, sin bloquear el run/,
			/El snapshot del paso 1 y la conservación del worktree aplican también en `pr-reviewed`\./,
			/La espera tiene tope: 30 minutos sin feedback nuevo terminan el seguimiento: `Feedback resuelto` si todo finding válido quedó atendido y `SEGUIMIENTO DE FEEDBACK DETENIDO` solo con trabajo pendiente; al cortar por el tope de 2 rondas se emite `SEGUIMIENTO DE FEEDBACK DETENIDO` con los threads abiertos listados\. En los dos casos se limpia el worktree si está limpio\.$/m,
			/^Al salir, emitir `Feedback resuelto` solo si todo finding válido detectado quedó atendido y no hay bloqueos; [^\n]*usar `SEGUIMIENTO DE FEEDBACK DETENIDO`\./m,
		]).map((problem) => `${file} Fase 6: ${problem}`));
		if (/ciclos de corrección|tope de 2 ciclos|Por nivel/.test(phase6)) problems.push(`${file} Fase 6: sigue contando ciclos o hablando de niveles`);
		// Review #114-5/6: sin GHA, `pr` corre el review nativo inline donde no hay subagente que lo corra.
		if ((harness === "codex" || harness === "opencode") && !/Con `pr` y sin GHA, el review nativo corre inline \(`[^`]*code-review <PR>`\) y la corrida termina\./.test(phase6)) problems.push(`${file}: pr sin GHA no corre el review nativo inline`);
		if (harness === "pi" && !/Con `pr` y sin GHA ni la tool `subagent`, el review nativo corre inline \(`\/skill:code-review <PR>`\) y la corrida termina\./.test(phase6)) problems.push(`${file}: pr sin GHA ni subagent no corre el review nativo inline`);
	}
	assert.deepEqual(problems, [], problems.join("\n"));
});

// Los nombres de nivel, `--autonomy` y el vocabulario del resolver viejo no pueden quedar fuera de los bloques
// compartidos. El aborto por fuga de `chiche-spec` tampoco: desde 6.0.0 una fuga se trata por confianza y nunca aborta.
const RUN_RETIRED_WORDS = /supervised|plan-approved|unattended|\bA[0-5]\b|--autonomy|Rehearsed|unrehearsed|umbral grill|umbral spec|nivel efectivo|Niveles de autonomía|Nivel efectivo|Nivel sugerido|Por nivel|nivel de autonomía|ciclos de corrección|decisión de producto sin cerrar/g;

export function retiredRunWordProblems(file: string, markdown: string): string[] {
	const problems: string[] = [];
	withoutAutonomyBlocks(markdown).split("\n").forEach((line, index) => {
		const hits = [...new Set(line.match(RUN_RETIRED_WORDS) ?? [])];
		if (hits.length > 0) problems.push(`${file}:${index + 1}: ${hits.join(", ")}`);
	});
	return problems;
}

test("#130 CA-19: fuera de los bloques autonomy-*, ningún chiche-run nombra un nivel, --autonomy, el nivel efectivo ni el aborto por fuga; el autotest prueba que el chequeo ve una línea vieja y saltea los bloques", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const file = `${harness}/chiche-run/SKILL.md`;
		problems.push(...retiredRunWordProblems(file, await readRepoFile(file)));
	}
	assert.deepEqual(problems, [], problems.join("\n"));
	const synthetic = ["uno", "<!-- autonomy-resolve:start -->", "`unattended` o `A3` → `usá --mode pr-reviewed`", "<!-- autonomy-resolve:end -->", "con A2 o A3 frena", "ALTA 4 / MEDIA 1", "`--autonomy A3`"].join("\n");
	assert.deepEqual(retiredRunWordProblems("x.md", synthetic), ["x.md:5: A2, A3", "x.md:7: --autonomy, A3"]);
});

// ---------------------------------------------------------------------------
// Issue #136 (CA-4): ningún fence bash ni sh de ningún SKILL.md usa parámetros posicionales ni $ARGUMENTS. El harness
// los sustituye en el texto del skill al cargarlo con argumentos (en Claude Code `$1` pasa a ser uno de ellos), así que
// un comando copiado del texto cargado deja de ser el que está en el archivo. `${#var}` (largo de una variable) no es
// un parámetro y no cuenta.

// Una línea por hallazgo, `<archivo>:<línea>: <lo que encontró>`, solo dentro de fences ```bash o ```sh. Los fences de
// otro lenguaje y la prosa no cuentan; un fence dentro de otro de más backticks es texto del exterior.
export function positionalParameterProblems(file: string, markdown: string): string[] {
	const problems: string[] = [];
	const everyHit = new RegExp(POSITIONAL_PARAMETER, "g");
	let open: { char: string; length: number; shell: boolean } | null = null;
	markdown.split("\n").forEach((line, index) => {
		if (open === null) {
			const opening = line.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
			if (opening) open = { char: opening[1]?.[0] ?? "`", length: opening[1]?.length ?? 3, shell: opening[2] === "bash" || opening[2] === "sh" };
			return;
		}
		const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
		if (closing && closing[1]?.[0] === open.char && (closing[1]?.length ?? 0) >= open.length) {
			open = null;
			return;
		}
		if (!open.shell) return;
		const hits = [...new Set(line.match(everyHit) ?? [])];
		if (hits.length > 0) problems.push(`${file}:${index + 1}: ${hits.join(", ")}`);
	});
	return problems;
}

test("#136 CA-4: ningún fence bash ni sh de ningún SKILL.md trackeado de los cinco harnesses usa $0 a $9, $@, $*, $# ni $ARGUMENTS, ni sus formas con llave, con o sin operador (${1}, ${1:-x}, ${@:2}, ${#})", async () => {
	const listing = spawnSync("git", ["ls-files", "--", ...HARNESSES], { cwd: fileURLToPath(repoFile("")), encoding: "utf8" });
	assert.equal(listing.status, 0, listing.stderr);
	const files = listing.stdout.split("\n").filter((path) => /(^|\/)SKILL\.md$/.test(path));
	for (const harness of HARNESSES) assert.ok(files.some((path) => path.startsWith(`${harness}/`)), `git ls-files lista skills de ${harness}/`);
	const problems: string[] = [];
	for (const file of files) problems.push(...positionalParameterProblems(file, await readRepoFile(file)));
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("autotest (#136 CA-4): el chequeo de posicionales marca cada forma prohibida con archivo y línea, deja pasar ${#var}, la prosa y los fences de otro lenguaje, y no cierra un fence con uno interior más corto", () => {
	const violating = [
		"# Skill",
		"Prosa con $1 y $ARGUMENTS no cuenta.",
		"```bash",
		'enc() { [ "$1" = none ] && s=$1; }',
		"echo ${0} $9 \"$@\" $* $#",
		"echo $ARGUMENTS",
		"s=${1:-x}; set -- ${@:2} ${*} ${#} ${10} ${#1}",
		"```",
		"```text",
		"echo $1",
		"```",
		"  ```sh",
		"  echo $2",
		"  ```",
		"````markdown",
		"```bash",
		"echo $3",
		"```",
		"````",
	].join("\n");
	assert.deepEqual(positionalParameterProblems("claude/x/SKILL.md", violating), [
		"claude/x/SKILL.md:4: $1",
		"claude/x/SKILL.md:5: ${0}, $9, $@, $*, $#",
		"claude/x/SKILL.md:6: $ARGUMENTS",
		"claude/x/SKILL.md:7: ${1:-x}, ${@:2}, ${*}, ${#}, ${10}, ${#1}",
		"claude/x/SKILL.md:13: $2",
	]);
	const compliant = ["```bash", '[ ${#line} -lt 1024 ] && v=$spec; echo "${#v} ${v:-none} ${HOME} $(v=$spec; enc)"', "```"].join("\n");
	assert.deepEqual(positionalParameterProblems("claude/x/SKILL.md", compliant), []);
});

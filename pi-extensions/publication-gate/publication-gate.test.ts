// Gate de la sección `## Publicacion` del contrato (issue #134).
//
// Desde 6.1.0 `chiche-init` pregunta dónde publican los skills y lo guarda en
// `## Publicacion`: adónde van las specs (`specs`), en qué carpeta van los `.md`
// de specs y grills (`carpeta`) y dónde y con qué comando se crean los issues
// (`repo` y `crear issue`). Este gate lee los cinco `chiche-init/SKILL.md`
// reales y fija: el template de la Fase 4 (CA-1), las tres preguntas de la Fase
// 3 (CA-2), el bloque canónico `publication-resolve`, idéntico byte a byte y
// ejecutado con bash, sh y zsh en repos git temporales (CA-3 y CA-4), la
// verificación sin ejecutar la plantilla (CA-5), `--defaults` y «Upgrade de
// contrato» (CA-6) y el reporte con las filas de los README (CA-7). Es
// solo-tests (sin index.ts), como autonomy-gate: el gate del package censa
// exactamente 11 factories. Que un agente haga las preguntas en una sesión
// real es prueba humana (CA-21).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Harness } from "../harness-gate/interaction.ts";
import { HARNESSES, escapeRegExp, fencedBlocks, firstDifference, normalizeInvocations, parseInteractionTable } from "../harness-gate/interaction.ts";

// Skills que llevan el bloque `publication-resolve`: chiche-init lo escribe (capa 1) y, desde la capa 2,
// lo leen los que escriben o inventarían borradores. chiche-land y code-review solo nombran la sección.
const PUBLICATION_SKILLS = ["chiche-init", "chiche-spec", "grill", "chiche-run", "issue-triage"] as const;
const BLOCK = "publication-resolve";
const KEYS = ["specs", "carpeta", "repo", "crear issue"] as const;
const DEFAULT_TEMPLATE = "gh issue create --repo {repo} --title {title} --body-file {body}";
const REPO_PATTERN = "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$";

function repoPath(path: string): string {
	return new URL(`../../${path}`, import.meta.url).pathname;
}

async function readRepoFile(path: string): Promise<string> {
	return readFile(repoPath(path), "utf8");
}

async function skillFile(harness: Harness, skill: string): Promise<string> {
	return readRepoFile(`${harness}/${skill}/SKILL.md`);
}

function delimitedBlock(markdown: string, name: string): string | null {
	const block = markdown.match(new RegExp(`<!-- ${escapeRegExp(name)}:start -->\\n([\\s\\S]*?)\\n<!-- ${escapeRegExp(name)}:end -->`));
	return block ? (block[1] ?? "") : null;
}

// Sección que abre el primer heading `##`..`####` que cumple `heading` y termina en el siguiente
// heading del mismo nivel o superior. Ignora los headings dentro de fences, que son templates.
function section(markdown: string, heading: RegExp): string {
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

function missing(text: string, patterns: RegExp[]): string[] {
	return patterns.filter((pattern) => !pattern.test(text)).map((pattern) => `falta ${pattern}`);
}

let tableCache: ReturnType<typeof parseInteractionTable> | null = null;
async function interactionTable(): Promise<ReturnType<typeof parseInteractionTable>> {
	if (!tableCache) tableCache = parseInteractionTable(await readRepoFile("docs/harness-interaction-differences.md"));
	return tableCache;
}

// La única normalización permitida (docs/harness-interaction-differences.md): invocaciones con el
// prefijo del harness y la tool de preguntas. En Pi la respuesta libre pide `allowOther: true`, que
// es un parámetro de su tool y la única diferencia tolerada dentro de la Fase 3.
async function normalize(text: string, harness: Harness): Promise<string> {
	const table = await interactionTable();
	let out = normalizeInvocations(text, table.prefixes[harness]);
	const tool = table.questionTools[harness];
	if (tool) out = out.replaceAll(`\`${tool}\``, "`«tool-preguntas»`");
	return out.replaceAll("(Other, con `allowOther: true`)", "(Other)");
}

async function questionTool(harness: Harness): Promise<string> {
	const tool = (await interactionTable()).questionTools[harness];
	assert.ok(tool, `${harness}: la tabla de interacción declara su tool de preguntas`);
	return tool;
}

async function referenceBlock(): Promise<string> {
	const block = delimitedBlock(await skillFile("claude", "chiche-init"), BLOCK);
	assert.ok(block, `claude/chiche-init trae el bloque ${BLOCK}`);
	return block;
}

async function canonicalCommand(): Promise<string> {
	const fences = fencedBlocks(await referenceBlock());
	assert.equal(fences.length, 1, `${BLOCK} trae exactamente un fence: el comando canónico`);
	return fences[0]?.content ?? "";
}

// ---------------------------------------------------------------------------
// CA-1: el template de la Fase 4 lleva ## Publicacion entre ## Ambientes y ## Verificacion autonoma

test("#134 CA-1: el template de la Fase 4 de los cinco chiche-init lleva ## Publicacion entre ## Ambientes y ## Verificacion autonoma, con la tabla Clave/Valor de exactamente cuatro filas en orden y una línea por clave", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const at = (problem: string) => `${harness}/chiche-init: ${problem}`;
		const markdown = await skillFile(harness, "chiche-init");
		const template = fencedBlocks(section(markdown, /^Fase 4 — /)).find((fence) => /^# Contrato de autonomia/m.test(fence.content))?.content ?? "";
		if (!template) {
			problems.push(at("la Fase 4 no trae el template del contrato"));
			continue;
		}
		const ambientes = template.indexOf("\n## Ambientes\n");
		const publicacion = template.indexOf("\n## Publicacion\n");
		const verificacion = template.indexOf("\n## Verificacion autonoma\n");
		if (publicacion === -1) {
			problems.push(at("el template no tiene ## Publicacion"));
			continue;
		}
		if (!(ambientes !== -1 && ambientes < publicacion && publicacion < verificacion)) problems.push(at("## Publicacion no está entre ## Ambientes y ## Verificacion autonoma"));
		const chunk = template.slice(publicacion, verificacion === -1 ? undefined : verificacion);
		if (!/^\| Clave \| Valor \|\n\|---\|---\|$/m.test(chunk)) problems.push(at("falta la tabla | Clave | Valor |"));
		const rows = chunk.split("\n").filter((line) => /^\| [^|]+ \| [^|]+ \|>?$/.test(line) && !/^\| Clave \|/.test(line) && !/^\|---/.test(line)).map((line) => line.replace(/>$/, "").split("|").slice(1, -1).map((cell) => cell.trim()));
		if (rows.map((row) => row[0]).join(" · ") !== KEYS.join(" · ")) problems.push(at(`filas de la tabla: ${rows.map((row) => row[0]).join(" · ")}`));
		const values = new Map(rows.map((row) => [row[0] ?? "", row[1] ?? ""]));
		if (values.get("specs") !== "auto") problems.push(at(`specs del template: ${values.get("specs")}`));
		if (values.get("carpeta") !== "<git-common-dir>/chiche/") problems.push(at(`carpeta del template: ${values.get("carpeta")}`));
		// Review #138-1: el placeholder no puede pasar la validación como un repo real; `<…>` cae al default con aviso.
		if (values.get("repo") !== "<owner/repo o none>") problems.push(at(`repo del template: ${values.get("repo")}`));
		if (values.get("crear issue") !== DEFAULT_TEMPLATE) problems.push(at(`crear issue del template: ${values.get("crear issue")}`));
		for (const key of KEYS) if (!new RegExp(`^${escapeRegExp(key)}: .+$`, "m").test(chunk)) problems.push(at(`falta la línea que explica \`${key}\``));
		problems.push(...missing(chunk, [/auto/, /issue/, /local/, /<git-common-dir>\/chiche\//, /relativa a la raiz/, /origin/, /o none sin repo de issues/, /\{title\}/, /\{body\}/, /\{repo\}/, /sin `\|`/]).map((problem) => at(`template: ${problem}`)));
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// CA-2: las tres preguntas de la Fase 3, después de la posición del run

const PUBLICATION_QUESTIONS = [
	"**Publicación.** Después de la posición del run, preguntar dónde publican los skills con `«tool-preguntas»`, tres preguntas en este orden, cada una con la recomendada primera; las dos últimas aceptan respuesta libre (Other) y la primera no: una respuesta fuera de `auto`, `issue` o `local` se repregunta:",
	"",
	"«¿Adónde van las specs?»",
	"",
	"1. `auto (Recomendado)` — issue si el repo ya usa issues como specs; si no, un `.md` local.",
	"2. `issue` — siempre un issue.",
	"3. `local` — siempre un `.md` local.",
	"",
	"«¿En qué carpeta van los .md de specs y grills?» — la respuesta libre es una ruta relativa a la raíz del repo (ej. `docs/sdd/`, que da `docs/sdd/specs/` y `docs/sdd/grills/`):",
	"",
	"1. `<git-common-dir>/chiche/ (Recomendado)` — fuera del árbol: no aparece en `git status` ni viaja con un clone.",
	"2. `.chiche/` — en el árbol: los borradores quedan visibles en `git status`.",
	"",
	"«¿Dónde y con qué comando se crean los issues?» — la respuesta libre se toma como plantilla, con `{title}` y `{body}` obligatorios y `{repo}` opcional; su repo se pide si no se deduce de `--repo`:",
	"",
	"1. `En <origin> con gh issue create (Recomendado)` — la plantilla default, `gh issue create --repo {repo} --title {title} --body-file {body}`, sobre el repo de `origin`.",
	"2. `En otro repo` — pide `owner/repo` y usa la plantilla default con ese repo.",
	"",
	"Sin un `origin` de GitHub la tercera pregunta se saltea: `repo` queda `none` y la plantilla, la default (`specs` sigue valiendo: con `auto` la spec cae a local y con `issue` cae a local con aviso).",
	"",
	"Las respuestas van a la tabla `| Clave | Valor |` de `## Publicacion`: `specs`, `carpeta`, `repo` y `crear issue`. Con `--defaults` no se pregunta: un contrato nuevo lleva los cuatro defaults. En `--update` con la sección ya presente, preguntar `Mantener (Recomendado)` / `Revisar`: `Mantener` la preserva verbatim y `Revisar` repite las tres preguntas con los valores actuales como default; con `--defaults` no se pregunta y se preserva verbatim.",
].join("\n");

test("#134 CA-2: la Fase 3 de los cinco chiche-init hace las tres preguntas de publicación, en orden, después de la posición del run y antes de la stop list, con la recomendada primera, respuesta libre y la tool del harness", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const at = (problem: string) => `${harness}/chiche-init: ${problem}`;
		const raw = await skillFile(harness, "chiche-init");
		const phase3 = await normalize(section(raw, /^Fase 3 — /), harness);
		if (!phase3.includes(`\n\n${PUBLICATION_QUESTIONS}\n\n`)) problems.push(at("la Fase 3 no trae el párrafo «Publicación» con sus tres preguntas literales"));
		const titled = [...phase3.matchAll(/^\*\*([^*\n]+)\.\*\*/gm)].map((match) => match[1]);
		if (titled.join(" | ") !== "Confianza por etapa | Posición del run | Publicación | Stop list") problems.push(at(`párrafos titulados de la Fase 3: ${titled.join(" | ")}`));
		const tool = await questionTool(harness);
		const rawPhase3 = section(raw, /^Fase 3 — /);
		if (!rawPhase3.includes(`preguntar dónde publican los skills con \`${tool}\``)) problems.push(at(`«preguntar dónde publican los skills» no nombra \`${tool}\``));
		if (harness === "pi" && !rawPhase3.includes("las dos últimas aceptan respuesta libre (Other, con `allowOther: true`) y la primera no")) problems.push(at("en Pi la respuesta libre pide `allowOther: true` solo en las dos últimas"));
	}
	assert.deepEqual(problems, []);
});

test("#134 CA-2: la Fase 3 es idéntica entre harnesses tras normalizar invocaciones y tool de preguntas", async () => {
	const reference = await normalize(section(await skillFile("claude", "chiche-init"), /^Fase 3 — /), "claude");
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const actual = await normalize(section(await skillFile(harness, "chiche-init"), /^Fase 3 — /), harness);
		if (actual !== reference) problems.push(`claude vs ${harness}: ${firstDifference(reference, actual)}`);
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// CA-3 y CA-4: el bloque publication-resolve y su comando canónico

test("#134 CA-3: el bloque publication-resolve es idéntico byte a byte en los chiche-init de los cinco harnesses, trae un solo fence sin parámetros posicionales ni variables del harness, y fija las cuatro líneas, los defaults, la fuente y los inválidos", async () => {
	const problems: string[] = [];
	const blocks = new Map<string, string>();
	for (const skill of PUBLICATION_SKILLS) {
		for (const harness of HARNESSES) {
			const path = `${harness}/${skill}/SKILL.md`;
			const block = delimitedBlock(await skillFile(harness, skill), BLOCK);
			if (block === null) {
				problems.push(`${path}: falta el bloque <!-- ${BLOCK}:start/end -->`);
				continue;
			}
			blocks.set(path, block);
			const hit = block.match(/\$(?:[0-9]|ARGUMENTS|@|\*)/);
			if (hit) problems.push(`${path}: el bloque contiene ${hit[0]}`);
			const subscript = block.match(/\$[A-Za-z_][A-Za-z0-9_]*\[/);
			if (subscript) problems.push(`${path}: el bloque contiene ${subscript[0]} (zsh lo lee como subíndice)`);
		}
	}
	const [reference] = [...blocks.entries()];
	if (reference) for (const [path, block] of blocks) if (block !== reference[1]) problems.push(`${reference[0]} vs ${path}: ${firstDifference(reference[1], block)}`);
	assert.deepEqual(problems, []);
	assert.equal(blocks.size, PUBLICATION_SKILLS.length * HARNESSES.length);

	const block = await referenceBlock();
	assert.deepEqual(missing(block, [
		/^\*\*`## Publicacion`\.\*\*/m,
		/`specs`[^\n]*`auto`[^\n]*`issue`[^\n]*`local`/,
		/`carpeta`[^\n]*`<git-common-dir>\/chiche\/`[^\n]*relativa a la raíz del repo/,
		/`repo`[^\n]*`owner\/repo`[^\n]*`none`/,
		/`crear issue`[^\n]*sin `\|`/,
		/host `github\.com` o `ssh\.github\.com`/,
		/alias SSH[^\n]*`none`/,
		/Un valor envuelto en backticks se lee sin ellos/,
		/La fila `repo` acepta `none` como valor explícito/,
		/`crear issue`[^\n]*`\{title\}` y `\{body\}` obligatorios y `\{repo\}` opcional/,
		/^\*\*Publicación efectiva\.\*\*/m,
		/raíz operativa \(`\.chiche\/project\.md`, con fallback a `\.sdd\/project\.md`\)/,
		/`specs: <valor>`, `carpeta: <ruta absoluta>`, `repo: <owner\/repo\|none>` y `crear issue: <plantilla>`/,
		/` \(default\)` al final de cada valor que no salió del contrato/,
		new RegExp(escapeRegExp(`\`${DEFAULT_TEMPLATE}\``)),
		/`valor <clave> inválido \(<valor>\): rige <default>` por stderr y exit 0/,
		/`specs` fuera de `auto`, `issue` o `local`/,
		/`carpeta` absoluta distinta del literal, o con un segmento `\.\.`/,
		new RegExp(escapeRegExp(`\`${REPO_PATTERN}\``)),
		/`crear issue` sin `\{title\}` o sin `\{body\}`/,
		/`bash`, `sh` y `zsh`/,
		/sin parámetros posicionales ni variables de argumentos del harness/,
	]), []);
	const command = await canonicalCommand();
	for (const expected of ["printf 'specs: %s\\n'", "printf 'carpeta: %s\\n'", "printf 'repo: %s\\n'", "printf 'crear issue: %s\\n'"]) assert.ok(command.includes(expected), `el comando imprime ${expected}`);
	assert.match(command, /\.chiche\/project\.md[^\n]*\.sdd\/project\.md/, "lee .chiche/project.md con fallback a .sdd/project.md");
	// La plantilla default es un valor (`defcrear=`), no una ejecución: fuera de esa línea nadie corre gh ni toca la red.
	const executed = command.split("\n").filter((line) => !line.includes("defcrear=")).join("\n");
	assert.doesNotMatch(executed, /git fetch|git show|git ls-remote|\bgh /, "no toca la red ni ejecuta gh");
});

// --- ejecución del comando canónico en repos git temporales --------------------

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", ["-c", "user.name=sdd", "-c", "user.email=sdd@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

// Como autonomy-gate (issue #120): bash, dash (o sh) y zsh; sin zsh la iteración se saltea con nota,
// salvo que CI lo exija con AUTONOMY_GATE_REQUIRE_ZSH=1.
const DASH = existsSync("/bin/dash") ? "/bin/dash" : "sh";
const ZSH = existsSync("/bin/zsh") ? "/bin/zsh" : spawnSync("zsh", ["-c", "true"]).status === 0 ? "zsh" : null;
const REQUIRE_ZSH = process.env.AUTONOMY_GATE_REQUIRE_ZSH === "1";
const EMPTY_ZDOTDIR = realpathSync(mkdtempSync(join(tmpdir(), "publication-gate-zdotdir-")));
process.on("exit", () => rmSync(EMPTY_ZDOTDIR, { recursive: true, force: true }));

function shells(t: TestContext): readonly string[] {
	if (ZSH) return ["bash", DASH, ZSH];
	if (REQUIRE_ZSH) throw new Error("zsh no está en PATH y AUTONOMY_GATE_REQUIRE_ZSH=1 lo exige");
	t.diagnostic("zsh no está en PATH: se saltea");
	return ["bash", DASH];
}

function shellEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, ZDOTDIR: EMPTY_ZDOTDIR };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	return env;
}

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runResolve(command: string, cwd: string, shell: string): Run {
	const result = spawnSync(shell, ["-c", command], { cwd, encoding: "utf8", env: shellEnv() });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function publicationContract(rows: Record<string, string> | null): string {
	const table = rows === null ? [] : ["## Publicacion", "| Clave | Valor |", "|---|---|", ...Object.entries(rows).map(([key, value]) => `| ${key} | ${value} |`), ""];
	return [
		"# Contrato de autonomia — demo",
		"<!-- Chiche-Tracking: version=2; type=project; generated-at=2026-11-09 -->",
		"",
		"## Comandos",
		"| Accion | Comando | cwd | Estado | Duracion | Notas |",
		"|---|---|---|---|---|---|",
		"",
		"## Ambientes",
		"Solo local.",
		"",
		...table,
		"## Verificacion autonoma",
		"1. node --test",
		"",
		"## Autonomy",
		"| Stage | Value | Since |",
		"|---|---|---|",
		"| run | ask | 2026-11-09 |",
		"",
		"| Action | Pattern | Reason |",
		"|---|---|---|",
		"| git push origin main | git push .* main | solo via PR |",
		"",
	].join("\n");
}

const ORIGIN_URL = "https://github.com/acme/widgets.git";

// Repo git temporal con un remote `origin` de GitHub (sin fetch: el comando solo lee su URL).
function tempRepo(name: string, contract: string | null, options: { contractPath?: string; origin?: string | null } = {}): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), `publication-gate-${name}-`)));
	git(root, "init", "-q", "-b", "main");
	const origin = options.origin === undefined ? ORIGIN_URL : options.origin;
	if (origin) git(root, "remote", "add", "origin", origin);
	if (contract !== null) {
		const path = options.contractPath ?? ".chiche/project.md";
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), contract);
	}
	git(root, "commit", "-q", "--allow-empty", "-m", "base");
	return root;
}

function expectedLines(root: string, values: { specs: string; carpeta: string; repo: string; crear: string }): string {
	return `specs: ${values.specs}\ncarpeta: ${values.carpeta}\nrepo: ${values.repo}\ncrear issue: ${values.crear}\n`;
}

function sameAcrossShells(t: TestContext, command: string, cwd: string, label: string): Run {
	const runs = shells(t).map((shell) => ({ shell, run: runResolve(command, cwd, shell) }));
	const [first] = runs;
	assert.ok(first, "al menos un shell");
	for (const { shell, run } of runs) {
		assert.equal(run.status, 0, `${label} (${shell}): exit ${run.status}; stderr: ${run.stderr}`);
		assert.equal(run.stdout, first.run.stdout, `${label}: stdout de ${shell} difiere de ${first.shell}`);
		assert.equal(run.stderr, first.run.stderr, `${label}: stderr de ${shell} difiere de ${first.shell}`);
	}
	return first.run;
}

test("#134 CA-3: sin contrato, o con un contrato sin la sección, el comando imprime los cuatro defaults con (default): auto, <git-common-dir>/chiche absoluto, el repo de GitHub de origin y la plantilla default, igual en bash, sh y zsh y sin avisos", async (t) => {
	const command = await canonicalCommand();
	const roots: string[] = [];
	t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
	for (const [name, contract] of [["sin-contrato", null], ["sin-seccion", publicationContract(null)]] as const) {
		const root = tempRepo(name, contract);
		roots.push(root);
		const run = sameAcrossShells(t, command, root, name);
		assert.equal(run.stderr, "", `${name}: sin avisos`);
		assert.equal(run.stdout, expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }));
	}
});

test("#134 CA-3: con la sección completa y válida imprime los valores del contrato sin (default): specs, carpeta relativa resuelta a absoluta, repo y plantilla con flags extra; el literal <git-common-dir>/chiche/ sale sin (default)", async (t) => {
	const command = await canonicalCommand();
	const roots: string[] = [];
	t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
	const template = "gh issue create --repo {repo} --label spec --title {title} --body-file {body}";
	const full = tempRepo("completo", publicationContract({ specs: "issue", carpeta: "docs/sdd/", repo: "pramaestudio/backlog", "crear issue": template }));
	roots.push(full);
	const run = sameAcrossShells(t, command, full, "completo");
	assert.equal(run.stderr, "");
	assert.equal(run.stdout, expectedLines(full, { specs: "issue", carpeta: join(full, "docs", "sdd"), repo: "pramaestudio/backlog", crear: template }));

	const literal = tempRepo("literal", publicationContract({ specs: "local", carpeta: "<git-common-dir>/chiche/", repo: "acme/widgets", "crear issue": DEFAULT_TEMPLATE }));
	roots.push(literal);
	const literalRun = sameAcrossShells(t, command, literal, "literal");
	assert.equal(literalRun.stderr, "");
	assert.equal(literalRun.stdout, expectedLines(literal, { specs: "local", carpeta: join(literal, ".git", "chiche"), repo: "acme/widgets", crear: DEFAULT_TEMPLATE }));

	const tree = tempRepo("arbol", publicationContract({ specs: "auto", carpeta: ".chiche/" }));
	roots.push(tree);
	const treeRun = sameAcrossShells(t, command, tree, "arbol");
	assert.equal(treeRun.stderr, "");
	assert.equal(treeRun.stdout, expectedLines(tree, { specs: "auto", carpeta: join(tree, ".chiche"), repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }));
});

test("#134 CA-3: lee .sdd/project.md cuando no hay .chiche/project.md, corre desde un subdirectorio del repo, y sin origin (o con un remote que no es de GitHub) el repo default es none", async (t) => {
	const command = await canonicalCommand();
	const roots: string[] = [];
	t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
	const legacy = tempRepo("sdd", publicationContract({ specs: "local" }), { contractPath: ".sdd/project.md" });
	roots.push(legacy);
	mkdirSync(join(legacy, "src", "deep"), { recursive: true });
	const run = sameAcrossShells(t, command, join(legacy, "src", "deep"), "sdd");
	assert.equal(run.stderr, "");
	assert.equal(run.stdout, expectedLines(legacy, { specs: "local", carpeta: `${join(legacy, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }));

	const noOrigin = tempRepo("sin-origin", publicationContract({ specs: "issue" }), { origin: null });
	roots.push(noOrigin);
	const noOriginRun = sameAcrossShells(t, command, noOrigin, "sin-origin");
	assert.equal(noOriginRun.stderr, "");
	assert.match(noOriginRun.stdout, /^repo: none \(default\)$/m);

	const gitlab = tempRepo("gitlab", null, { origin: "git@gitlab.com:acme/widgets.git" });
	roots.push(gitlab);
	assert.match(sameAcrossShells(t, command, gitlab, "gitlab").stdout, /^repo: none \(default\)$/m);

	const ssh = tempRepo("ssh", null, { origin: "git@github.com:acme/widgets.git" });
	roots.push(ssh);
	assert.match(sameAcrossShells(t, command, ssh, "ssh").stdout, /^repo: acme\/widgets \(default\)$/m);

	// Review #138-1: `none` es un valor explícito válido, sin aviso y sin (default).
	const explicitNone = tempRepo("none-explicito", publicationContract({ repo: "none" }));
	roots.push(explicitNone);
	const noneRun = sameAcrossShells(t, command, explicitNone, "none-explicito");
	assert.equal(noneRun.stderr, "");
	assert.match(noneRun.stdout, /^repo: none$/m);

	// Review #138-6: el host va anclado: `mygithub.com` no es GitHub, `ssh.github.com:443` sí, y un alias SSH cae a none.
	for (const [name, origin, expected] of [
		["falso-github", "https://mygithub.com/acme/widgets.git", "none (default)"],
		["ssh-443", "ssh://git@ssh.github.com:443/acme/widgets.git", "acme/widgets (default)"],
		["alias-ssh", "git@github.com-work:acme/widgets.git", "none (default)"],
		["https-user", "https://user@github.com/acme/widgets", "acme/widgets (default)"],
	] as const) {
		const root = tempRepo(name, null, { origin });
		roots.push(root);
		assert.match(sameAcrossShells(t, command, root, name).stdout, new RegExp(`^repo: ${escapeRegExp(expected)}$`, "m"), name);
	}
});

test("#134 CA-4: cada valor inválido cae al default de su clave con el aviso literal por stderr y exit 0, sin tocar las otras claves, igual en bash, sh y zsh", async (t) => {
	const command = await canonicalCommand();
	const roots: string[] = [];
	t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
	const cases: { name: string; rows: Record<string, string>; aviso: (root: string) => string; expect: (root: string) => string }[] = [
		{
			name: "specs",
			rows: { specs: "siempre" },
			aviso: () => "aviso: valor specs inválido (siempre): rige auto",
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "carpeta-absoluta",
			rows: { carpeta: "/tmp/specs" },
			aviso: (root) => `aviso: valor carpeta inválido (/tmp/specs): rige ${join(root, ".git", "chiche")}`,
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "carpeta-dotdot",
			rows: { carpeta: "docs/../../x" },
			aviso: (root) => `aviso: valor carpeta inválido (docs/../../x): rige ${join(root, ".git", "chiche")}`,
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "carpeta-otro-literal",
			rows: { carpeta: "<git-common-dir>/sdd/" },
			aviso: (root) => `aviso: valor carpeta inválido (<git-common-dir>/sdd/): rige ${join(root, ".git", "chiche")}`,
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "repo",
			rows: { repo: "acme" },
			aviso: () => "aviso: valor repo inválido (acme): rige acme/widgets",
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "repo-espacio",
			rows: { repo: "acme/wid gets" },
			aviso: () => "aviso: valor repo inválido (acme/wid gets): rige acme/widgets",
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "crear-sin-title",
			rows: { "crear issue": "gh issue create --repo {repo} --body-file {body}" },
			aviso: () => `aviso: valor crear issue inválido (gh issue create --repo {repo} --body-file {body}): rige ${DEFAULT_TEMPLATE}`,
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
		{
			name: "crear-sin-body",
			rows: { "crear issue": "gh issue create --title {title}" },
			aviso: () => `aviso: valor crear issue inválido (gh issue create --title {title}): rige ${DEFAULT_TEMPLATE}`,
			expect: (root) => expectedLines(root, { specs: "auto (default)", carpeta: `${join(root, ".git", "chiche")} (default)`, repo: "acme/widgets (default)", crear: `${DEFAULT_TEMPLATE} (default)` }),
		},
	];
	for (const item of cases) {
		const root = tempRepo(item.name, publicationContract(item.rows));
		roots.push(root);
		const run = sameAcrossShells(t, command, root, item.name);
		assert.equal(run.stderr, `${item.aviso(root)}\n`, item.name);
		assert.equal(run.stdout, item.expect(root), item.name);
	}
	// Review #138-4: un valor envuelto en backticks (el estilo de este repo en ## Comandos) se lee sin ellos.
	const ticked = tempRepo("backticks", publicationContract({ specs: "`local`", carpeta: "`docs/sdd/`", repo: "`acme/widgets`", "crear issue": `\`${DEFAULT_TEMPLATE}\`` }));
	roots.push(ticked);
	const tickedRun = sameAcrossShells(t, command, ticked, "backticks");
	assert.equal(tickedRun.stderr, "");
	assert.equal(tickedRun.stdout, expectedLines(ticked, { specs: "local", carpeta: join(ticked, "docs", "sdd"), repo: "acme/widgets", crear: DEFAULT_TEMPLATE }));
	const tickedDefault = tempRepo("backticks-default", publicationContract({ carpeta: "`<git-common-dir>/chiche/`" }));
	roots.push(tickedDefault);
	assert.match(sameAcrossShells(t, command, tickedDefault, "backticks-default").stdout, new RegExp(`^carpeta: ${escapeRegExp(join(tickedDefault, ".git", "chiche"))}$`, "m"), "el literal default entre backticks es el default, sin (default) porque salió del contrato");
	// Dos inválidos a la vez: un aviso por clave, en el orden de las claves, y los demás valores intactos.
	const both = tempRepo("dos", publicationContract({ specs: "x", carpeta: "docs/sdd", repo: "nope", "crear issue": DEFAULT_TEMPLATE }));
	roots.push(both);
	const run = sameAcrossShells(t, command, both, "dos");
	assert.equal(run.stderr, "aviso: valor specs inválido (x): rige auto; aviso: valor repo inválido (nope): rige acme/widgets\n");
	assert.equal(run.stdout, expectedLines(both, { specs: "auto (default)", carpeta: join(both, "docs", "sdd"), repo: "acme/widgets (default)", crear: DEFAULT_TEMPLATE }));
});

// ---------------------------------------------------------------------------
// CA-5: chiche-init verifica sin ejecutar la plantilla

test("#134 CA-5: los cinco chiche-init verifican ## Publicacion sin ejecutar la plantilla: corren el comando canónico sobre el borrador, gh repo view <repo> --json nameWithOwner y la stop list contra la plantilla; una falla va a ## Gaps y se repregunta la clave", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const phase4 = section(await skillFile(harness, "chiche-init"), /^Fase 4 — /);
		const paragraph = phase4.split("\n").find((line) => line.startsWith("**Verificación de `## Publicacion`.**")) ?? "";
		if (!paragraph) {
			problems.push(`${harness}/chiche-init: la Fase 4 no trae el párrafo «Verificación de ## Publicacion»`);
			continue;
		}
		problems.push(...missing(paragraph, [
			/no ejecuta la plantilla de `crear issue`: crearía un issue/,
			// Review #138-3: el comando lee el archivo del disco, así que corre sobre el contrato ya escrito, como el ensayo de la stop list.
			/Con el archivo escrito, correr el comando canónico de «Publicación efectiva» sobre el contrato ya escrito \(el comando lee el archivo, no recibe el borrador\)/,
			/sin ningún aviso de valor inválido/,
			/`gh repo view <repo> --json nameWithOwner` \(salvo con `repo` en `none`, que no se consulta\)/,
			/stop list de `## Autonomy` contra la plantilla/,
			/se anota en `## Gaps`/,
			/en una corrida interactiva, se repregunta la clave que falló y se reescribe su fila/,
			/con `--defaults` queda solo en `## Gaps`/,
		]).map((problem) => `${harness}/chiche-init: ${problem}`));
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// CA-6: --defaults, Upgrade de contrato y Mantener/Revisar

const PUBLICATION_UPGRADE_ROW =
	"| Publicacion | no existe la sección `## Publicacion` — al elegirse, la Fase 3 hace sus tres preguntas («Publicación») y la Fase 4 escribe la sección entre `## Ambientes` y `## Verificacion autonoma`; con `--defaults` no se escribe y queda `mejora disponible` |";

test("#134 CA-6: --defaults escribe ## Publicacion con los cuatro defaults en un contrato nuevo y la deja como mejora disponible en uno existente; «Upgrade de contrato» gana la fila Publicacion; --update preserva la sección verbatim con Mantener", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const at = (problem: string) => `${harness}/chiche-init: ${problem}`;
		const markdown = await skillFile(harness, "chiche-init");
		const args = section(markdown, /^Argumentos$/);
		const defaults = args.split("\n").find((line) => line.startsWith("- `--defaults` — ")) ?? "";
		problems.push(...missing(defaults, [
			/`## Publicacion` con sus cuatro defaults/,
			// Review #138-2: con --defaults una sección presente se preserva verbatim; sin la sección queda mejora disponible.
			/sobre un contrato existente sin `## Publicacion`, la sección queda como `mejora disponible` \(con la sección presente se preserva verbatim\)/,
		]).map((problem) => at(`--defaults: ${problem}`)));
		const upgrade = section(markdown, /^Upgrade de contrato\b/);
		if (!upgrade.split("\n").includes(PUBLICATION_UPGRADE_ROW)) problems.push(at("«Upgrade de contrato» no trae la fila Publicacion"));
		const phase4 = section(markdown, /^Fase 4 — /);
		if (!/En `--update`: regenerar todo salvo[^\n]*; `## Publicacion` solo cambia si se eligió `Revisar` en la Fase 3 \(con `--defaults` se preserva verbatim\); y los `\[NEEDS-INPUT\]`/.test(phase4)) problems.push(at("la regla de --update de la Fase 4 no preserva ## Publicacion salvo Revisar"));
		const mustDo = section(markdown, /^MUST DO$/);
		if (!mustDo.split("\n").includes("- Preservar `## Publicacion` verbatim en `--update` cuando el usuario elige `Mantener` o corre con `--defaults`; con `Revisar`, repetir las tres preguntas de «Publicación» con los valores actuales como default.")) problems.push(at("MUST DO no preserva ## Publicacion"));
		const mustNot = section(markdown, /^MUST NOT DO$/);
		if (!mustNot.split("\n").includes("- No ejecutar la plantilla de `crear issue` para verificarla: crearía un issue real. La verificación es `gh repo view` más el comando canónico y la stop list.")) problems.push(at("MUST NOT DO no prohíbe ejecutar la plantilla"));
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// CA-7: reporte y README

test("#134 CA-7: el reporte de los cinco chiche-init suma la línea publicacion, y las filas chiche-init de los dos README nombran las tres elecciones", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const report = section(await skillFile(harness, "chiche-init"), /^Reporte$/);
		if (!report.split("\n").includes("- publicacion: specs <v> · carpeta <v> · issues en <repo>")) problems.push(`${harness}/chiche-init: el reporte no trae la línea «- publicacion: …»`);
	}
	for (const path of ["README.md", "README.en.md"]) {
		const row = (await readRepoFile(path)).match(/^\| \*\*`chiche-init`\*\* \|[^\n]*\|$/m)?.[0] ?? "";
		if (!row) {
			problems.push(`${path}: falta la fila de chiche-init`);
			continue;
		}
		problems.push(...missing(row, [/`## Publicacion`/, /`auto`, `issue` o `local`|`auto`, `issue` or `local`/, /\.md/, /`\{title\}`/, /`\{body\}`/, /`owner\/repo`/]).map((problem) => `${path}: ${problem}`));
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Capa 2 (CA-8 a CA-14): destino y carpeta

const DECLARED_SPEC_DRAFTS = "Si `## Publicacion` del contrato declara una `carpeta` distinta del default (ver «Publicación efectiva»), `<carpeta>/specs/` y `<carpeta>/grills/` se leen primero, antes de los cuatro lugares y en el mismo orden, y lo nuevo se escribe en `<carpeta>/specs/`; con la carpeta default la lista y la conducta son las de arriba.";
const DECLARED_GRILL_DRAFTS = "Si `## Publicacion` del contrato declara una `carpeta` distinta del default (ver «Publicación efectiva»), el handoff, el cuestionario y la carpeta de capturas se escriben en `<carpeta>/grills/` y ese lugar se lee primero, antes de los cuatro de arriba; con la carpeta default la lista y la conducta son las de arriba.";
const DECLARED_TRIAGE_DRAFTS = "Si `## Publicacion` del contrato declara una `carpeta` distinta del default (ver «Publicación efectiva»), `<carpeta>/grills/` y `<carpeta>/specs/` se inventarían primero, antes de los cuatro lugares; con la carpeta default la lista es la de arriba.";
const DECLARED_RUN_BULLET = "   - **Carpeta declarada**: si `## Publicacion` del contrato declara una `carpeta` dentro del repo (ver «Publicación efectiva»), la spec target, el handoff canónico, su carpeta de capturas y las specs predecesoras se buscan también en `<carpeta>/specs/` y `<carpeta>/grills/`, antes que en los cuatro lugares, con la misma identidad por markers y referencias. Un artefacto de entrada sin trackear que vive ahí entra al PRIMER commit en su misma ruta relativa (ej. `docs/sdd/specs/x.md`); los del common-dir siguen yendo a `.chiche/specs/` y `.chiche/grills/`.";
const DECLARED_LAND = "Una copia sin trackear en la `carpeta` que `## Publicacion` del contrato declare dentro del repo (`<carpeta>/<kind>/<nombre>`) no vive en los common-dirs: la cubre la clasificación de paths sucios de abajo, que la resuelve como `ya aterrizado` cuando su `git hash-object` es igual a `git rev-parse origin/<default>:<carpeta>/<kind>/<nombre>`.";
const CODE_REVIEW_PLACES = "4. `<carpeta>/specs/` si `## Publicacion` del contrato declara una `carpeta`, y después `.chiche/specs/`, `.sdd/specs/`, `<git-common-dir>/chiche/specs/`, `<git-common-dir>/sdd/specs/` (en ese orden de precedencia)";
const EVENTS_IDENTITY = "La identidad events-v1 de una spec local es `.sdd/specs/<slug>.md` sea cual sea la marca del lugar donde vive: `.chiche/` o `.sdd/`, del árbol o del common-dir, o la carpeta declarada en `## Publicacion` del contrato.";
const SPEC_REPORT_LINE = "- publicacion: specs <valor> · destino <issue #NN | ruta absoluta> [· no se pudo crear el issue: quedó en <ruta absoluta>]";
const CODE_REVIEW_HARNESSES = ["codex", "opencode", "pi", "antigravity"] as const;

test("#134 CA-8 y CA-9: el Destino de chiche-spec corre el comando canónico y aplica specs (auto, issue sin consultar, local con issue=#NN sin editar el issue), --out manda, y una creación fallida cae a <carpeta>/specs/ con el aviso literal del reporte", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const at = (problem: string) => `${harness}/chiche-spec: ${problem}`;
		const markdown = await skillFile(harness, "chiche-spec");
		const flow = delimitedBlock(markdown, "chiche-spec-flow") ?? "";
		problems.push(...missing(flow, [
			/^\*\*Destino\.\*\* `--out` fuerza el destino y manda sobre la fila `specs`\. Sin `--out`, correr el comando canónico de «Publicación efectiva» y aplicar `specs` sin preguntar\. Con `auto`, la regla de siempre:$/m,
			/^3\. Si no, o si `gh` no está disponible o falla → `<carpeta>\/specs\/<slug>\.md` \(o `<carpeta>\/specs\/issue-NN-<slug>\.md` si hay issue de origen\), con su ruta absoluta en el reporte; con la carpeta default es `<git-common-dir>\/chiche\/specs\/<slug>\.md`\.$/m,
			/^Con `issue`, actualizar el issue de origen si lo hay o, si no, crear uno nuevo con el mismo staging no-SDD, sin consultar si el repo ya usa issues como specs\. Con `local`, escribir siempre `<carpeta>\/specs\/<slug>\.md` \(o `<carpeta>\/specs\/issue-NN-<slug>\.md`\), con `issue=#NN` en el marker cuando el pedido vino de un issue y sin editar ese issue\. Si crear o editar el issue falla \(con `issue`, o con `auto` cuando eligió issue\), la spec se escribe en `<carpeta>\/specs\/` y el reporte dice `no se pudo crear el issue: quedó en <ruta absoluta>`; con al menos un éxito parcial, el reporte lo nombra como exige el gate de publicación\.$/m,
		]).map((problem) => at(`Destino: ${problem}`)));
		if (!/`local` = `<git-common-dir>\/chiche\/specs\/` \(o `<carpeta>\/specs\/` si `## Publicacion` del contrato declara una carpeta\)/.test(markdown)) problems.push(at("--out local no nombra la carpeta declarada"));
		if (!/También `## Publicacion`, que fija el destino de la spec y la carpeta de los borradores \(ver «Publicación efectiva»\)\./.test(markdown)) problems.push(at("la Fase 1 no lee ## Publicacion"));
		const report = section(markdown, /^Reporte$/);
		if (!report.split("\n").includes(SPEC_REPORT_LINE)) problems.push(at("el reporte no trae la línea «- publicacion: …»"));
	}
	assert.deepEqual(problems, []);
});

test("#134 CA-10: los bloques de borradores de chiche-spec y grill leen primero <carpeta>/specs/ o <carpeta>/grills/ y escriben lo nuevo en <carpeta>/, con la conducta de hoy para la carpeta default", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const spec = delimitedBlock(await skillFile(harness, "chiche-spec"), "chiche-spec-drafts") ?? "";
		if (!spec.includes(DECLARED_SPEC_DRAFTS)) problems.push(`${harness}/chiche-spec: chiche-spec-drafts no lee ni escribe la carpeta declarada`);
		const grill = delimitedBlock(await skillFile(harness, "grill"), "grill-drafts") ?? "";
		if (!grill.includes(DECLARED_GRILL_DRAFTS)) problems.push(`${harness}/grill: grill-drafts no escribe el handoff, el cuestionario y las capturas en <carpeta>/grills/`);
	}
	assert.deepEqual(problems, []);
});

test("#134 CA-11: chiche-run busca la spec y el handoff también en la carpeta declarada, commitea un artefacto de entrada de ahí en su misma ruta relativa y deja los del common-dir bajo .chiche/", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const at = (problem: string) => `${harness}/chiche-run: ${problem}`;
		const markdown = await skillFile(harness, "chiche-run");
		const dirty = delimitedBlock(markdown, "chiche-run-dirty-checkout") ?? "";
		if (!dirty.split("\n").includes(DECLARED_RUN_BULLET)) problems.push(at("chiche-run-dirty-checkout no trae el bullet «Carpeta declarada»"));
		if (!/Listar las specs de `\.chiche\/specs\/`, `\.sdd\/specs\/`, `<git-common-dir>\/chiche\/specs\/` y `<git-common-dir>\/sdd\/specs\/`, y de `<carpeta>\/specs\/` primero si `## Publicacion` del contrato declara una `carpeta`,/.test(markdown)) problems.push(at("la Fase 0 no lista la carpeta declarada"));
		if (!/Solo una ruta que no es ninguna de esas dos formas se lee tal cual\. Con una `carpeta` declarada en `## Publicacion` del contrato, `<carpeta>\/specs\/<x>\.md` se busca antes que los cuatro lugares y el run la commitea en esa misma ruta relativa\./.test(markdown)) problems.push(at("la Fase 1 no resuelve la spec en la carpeta declarada"));
	}
	assert.deepEqual(problems, []);
});

test("#134 CA-12: issue-triage inventaría la carpeta declarada, code-review la busca primero donde existe como skill, y el barrido de chiche-land resuelve una copia sin trackear ahí como ya aterrizado", async () => {
	const problems: string[] = [];
	for (const harness of HARNESSES) {
		const triage = delimitedBlock(await skillFile(harness, "issue-triage"), "issue-triage-drafts") ?? "";
		if (!triage.includes(DECLARED_TRIAGE_DRAFTS)) problems.push(`${harness}/issue-triage: issue-triage-drafts no inventaría la carpeta declarada`);
		const land = delimitedBlock(await skillFile(harness, "chiche-land"), "chiche-land-common-dir") ?? "";
		if (!land.includes(DECLARED_LAND)) problems.push(`${harness}/chiche-land: chiche-land-common-dir no nombra la copia sin trackear de la carpeta declarada`);
	}
	for (const harness of CODE_REVIEW_HARNESSES) {
		const review = await skillFile(harness, "code-review");
		if (!review.includes(CODE_REVIEW_PLACES)) problems.push(`${harness}/code-review: no busca la spec en la carpeta declarada primero`);
	}
	assert.deepEqual(problems, []);
});

test("#134 CA-14: el bloque chiche-events de grill, chiche-spec, chiche-run y chiche-land dice en los cinco harnesses que la identidad events-v1 no cambia en la carpeta declarada", async () => {
	const problems: string[] = [];
	for (const skill of ["grill", "chiche-spec", "chiche-run", "chiche-land"] as const) {
		for (const harness of HARNESSES) {
			const events = delimitedBlock(await skillFile(harness, skill), "chiche-events") ?? "";
			if (!events.includes(EVENTS_IDENTITY)) problems.push(`${harness}/${skill}: chiche-events no fija la identidad en la carpeta declarada`);
		}
	}
	assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// El contrato de este repo

test("#134: el contrato de este repo tiene la fila del gate de publicacion con su conteo y no agrega ## Publicacion (fuera de alcance)", async () => {
	const contract = await readRepoFile(".chiche/project.md");
	const row = contract.split("\n").find((line) => line.startsWith("| gate de publicacion |")) ?? "";
	assert.ok(row, "la fila `gate de publicacion` existe en ## Comandos");
	assert.match(row, /`node --test pi-extensions\/publication-gate\/publication-gate\.test\.ts`/);
	const self = await readRepoFile("pi-extensions/publication-gate/publication-gate.test.ts");
	const count = (self.match(/^test\(/gm) ?? []).length;
	assert.match(row, new RegExp(`\\| ${count} tests`), `la fila declara ${count} tests`);
	assert.doesNotMatch(contract, /^## Publicacion$/m, "este repo no agrega ## Publicacion (fuera de alcance de #134)");
});

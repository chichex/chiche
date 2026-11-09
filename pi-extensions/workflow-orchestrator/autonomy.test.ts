// Issue #130, CA-25: gramática de los controles de autonomía en Pi. El dial por
// niveles (`--autonomy`, A1 a A3) se retiró en 6.0.0: quedan la posición del run
// (`mode`), la confianza (`confidence`) y la cadena (`--until pr`). `/issues` no
// lleva ningún flag y rechaza `--autonomy` con el diagnóstico de retiro.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as grammar from "./autonomy.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const { parseConfidence, parseIssuesCommandArgs, parseRunMode, withFlag } = grammar;

test("#130 CA-25: parseRunMode acepta ask, pr y pr-reviewed tal cual y rechaza cualquier otro token listando los válidos", () => {
	for (const mode of ["ask", "pr", "pr-reviewed"] as const) {
		assert.deepEqual(parseRunMode(mode), { ok: true, mode }, mode);
	}
	// Los niveles retirados y las variantes de mayúsculas no son posiciones: la gramática es la del comando canónico.
	for (const token of ["", "PR", "Ask", "pr-review", "reviewed", "A3", "a2", "unattended", "plan-approved", "supervised", "ask,pr"]) {
		assert.deepEqual(parseRunMode(token), { ok: false, message: `--mode ${token}: valor inválido; válidos: ask, pr, pr-reviewed` }, token);
	}
});

test("#130 CA-25: parseConfidence acepta un entero de 0 a 100 y rechaza lo que no es entero o queda fuera de rango", () => {
	for (const [value, confidence] of [[0, 0], [1, 1], [80, 80], [100, 100], ["0", 0], ["80", 80], ["100", 100]] as const) {
		assert.deepEqual(parseConfidence(value), { ok: true, confidence }, String(value));
	}
	for (const value of [-1, 101, 7.5, Number.NaN, Number.POSITIVE_INFINITY, "", "abc", "080", "7.5", "-1", "101", "80 %", " 80", "A2"]) {
		assert.deepEqual(parseConfidence(value), { ok: false, message: `--confidence ${String(value)}: valor inválido; válidos: un entero de 0 a 100` }, String(value));
	}
	for (const value of [null, true, {}, [80]]) {
		const parsed = parseConfidence(value);
		assert.equal(parsed.ok, false, JSON.stringify(value));
		if (!parsed.ok) assert.match(parsed.message, /^--confidence .*: valor inválido; válidos: un entero de 0 a 100$/);
	}
});

test("#130 CA-25: parseIssuesCommandArgs no acepta flags: sin argumentos pasa, --autonomy se rechaza con el diagnóstico de retiro y cualquier otro token como argumento desconocido", () => {
	assert.deepEqual(parseIssuesCommandArgs(""), { ok: true });
	assert.deepEqual(parseIssuesCommandArgs("   "), { ok: true });
	const retired = { ok: false, message: "--autonomy se retiró en 6.0.0: ya no hace falta" };
	for (const args of [
		"--autonomy A2",
		"  --autonomy   unattended ",
		"--autonomy=plan-approved",
		"--autonomy",
		"--autonomy=",
		"--autonomy --otro",
		"--autonomy A2 --autonomy A3",
		"--autonomy A4",
		"--autonomy extreme",
		"#12 --autonomy A2",
		"--until pr --autonomy A3",
	]) {
		assert.deepEqual(parseIssuesCommandArgs(args), retired, args);
	}
	// `/issues` no gana ningún flag nuevo: los controles viven en grill, chiche-spec y chiche-run.
	assert.deepEqual(parseIssuesCommandArgs("#12"), { ok: false, message: "/issues no acepta argumentos: #12" });
	assert.deepEqual(parseIssuesCommandArgs("--until pr"), { ok: false, message: "/issues no acepta argumentos: --until pr" });
	assert.deepEqual(parseIssuesCommandArgs("--confidence 80"), { ok: false, message: "/issues no acepta argumentos: --confidence 80" });
	assert.deepEqual(parseIssuesCommandArgs("--mode pr-reviewed"), { ok: false, message: "/issues no acepta argumentos: --mode pr-reviewed" });
	// `--autonomyx` no es el flag retirado: es un token desconocido más.
	assert.deepEqual(parseIssuesCommandArgs("--autonomyx A2"), { ok: false, message: "/issues no acepta argumentos: --autonomyx A2" });
});

test("#130 CA-25: withFlag agrega el flag con su valor al final de los args, deja los args intactos sin valor y no pierde el 0", () => {
	assert.equal(withFlag("#14", "--mode", undefined), "#14");
	assert.equal(withFlag("#14", "--mode", "pr"), "#14 --mode pr");
	assert.equal(withFlag("", "--mode", "pr-reviewed"), "--mode pr-reviewed");
	assert.equal(withFlag("--from-grill \"id\"", "--until", "pr"), "--from-grill \"id\" --until pr");
	assert.equal(withFlag("--from-grill \"id\"", "--confidence", 0), "--from-grill \"id\" --confidence 0");
	assert.equal(withFlag(withFlag("--from-grill \"id\"", "--until", "pr"), "--confidence", 100), "--from-grill \"id\" --until pr --confidence 100");
});

// El modelo de niveles no sobrevive en el código de producción de Pi: ni sus tipos, ni sus helpers, ni sus nombres.
// El flag retirado solo se nombra para dar el diagnóstico de retiro.
test("#130 CA-25: el código de producción de pi-extensions no conserva los tipos, los helpers ni los nombres de los niveles retirados", async () => {
	assert.deepEqual(
		Object.keys(grammar).filter((name) => /autonomy(level|code|name)|withAutonomy|VALID_LEVELS/i.test(name)),
		[],
		"autonomy.ts no exporta la gramática de niveles",
	);
	const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", "pi-extensions"], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
	const production = stdout.split("\0").filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
	assert.ok(production.includes("pi-extensions/workflow-orchestrator/autonomy.ts"), "el censo lee archivos trackeados");
	const retired = /\bAutonomy(?:Code|Name)\b|\bparseAutonomyLevel\b|\bwithAutonomy\b|\bsupervised\b|\bplan-approved\b|\bunattended\b|\bA[0-5]\b|--autonomy(?! se retiró en 6\.0\.0)/;
	const problems: string[] = [];
	for (const path of production) {
		const lines = (await readFile(`${REPO_ROOT}${path}`, "utf8")).split("\n");
		lines.forEach((line, index) => {
			// Reconocer el flag retirado para rechazarlo es la única mención permitida.
			const recognizer = path === "pi-extensions/workflow-orchestrator/autonomy.ts" && /RETIRED_AUTONOMY_FLAG/.test(line);
			if (retired.test(line) && !recognizer) problems.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
		});
	}
	assert.deepEqual(problems, []);
});

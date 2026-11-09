// Gramática de los controles de autonomía en Pi (issue #130, CA-25). Es la misma
// que la del bloque `autonomy-controls` de los skills: la posición del run
// (`mode`: ask, pr o pr-reviewed), la confianza (`confidence`: un entero de 0 a
// 100) y la cadena (`--until pr`). El dial por niveles se retiró en 6.0.0: el
// flag viejo solo se reconoce para rechazarlo con el diagnóstico de retiro.

export const RUN_MODES = ["ask", "pr", "pr-reviewed"] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const VALID_RUN_MODES = `válidos: ${RUN_MODES.join(", ")}`;
export const VALID_CONFIDENCE = "válidos: un entero de 0 a 100";

export type ParsedRunMode =
	| { ok: true; mode: RunMode }
	| { ok: false; message: string };

export function parseRunMode(token: string): ParsedRunMode {
	const mode = RUN_MODES.find((candidate) => candidate === token);
	return mode
		? { ok: true, mode }
		: { ok: false, message: `--mode ${token}: valor inválido; ${VALID_RUN_MODES}` };
}

export type ParsedConfidence =
	| { ok: true; confidence: number }
	| { ok: false; message: string };

// Acepta el entero o su forma decimal canónica (`0`, `80`, `100`), la misma que
// valida el comando canónico de los skills: sin signo, sin ceros a la izquierda.
export function parseConfidence(value: unknown): ParsedConfidence {
	const canonical = typeof value === "number" || typeof value === "string" ? String(value) : null;
	if (canonical !== null && /^(?:0|[1-9][0-9]?|100)$/.test(canonical)) return { ok: true, confidence: Number(canonical) };
	return { ok: false, message: `--confidence ${canonical ?? JSON.stringify(value)}: valor inválido; ${VALID_CONFIDENCE}` };
}

const RETIRED_AUTONOMY_FLAG = "--autonomy";
const RETIRED_IN = "6.0.0";

/** Diagnóstico de retiro del dial por niveles; `equivalent` dice qué usar en su lugar. */
export function retiredAutonomyMessage(equivalent: string): string {
	return `${RETIRED_AUTONOMY_FLAG} se retiró en ${RETIRED_IN}: ${equivalent}`;
}

export type IssuesCommandArgs =
	| { ok: true }
	| { ok: false; message: string };

// `/issues` no toma issues por argumento (los elige en la TUI) ni lleva flags:
// cualquier token es un error, no se descarta. El flag retirado se diagnostica
// primero, con el mismo texto que el comando canónico de los skills sin etapa.
export function parseIssuesCommandArgs(args: string): IssuesCommandArgs {
	const tokens = args.trim().split(/\s+/).filter((token) => token !== "");
	if (tokens.some((token) => token === RETIRED_AUTONOMY_FLAG || token.startsWith(`${RETIRED_AUTONOMY_FLAG}=`))) {
		return { ok: false, message: retiredAutonomyMessage("ya no hace falta") };
	}
	if (tokens.length > 0) return { ok: false, message: `/issues no acepta argumentos: ${tokens.join(" ")}` };
	return { ok: true };
}

/** Agrega `<flag> <value>` al final de `args`; sin valor deja `args` intacto. */
export function withFlag(args: string, flag: string, value: string | number | undefined): string {
	if (value === undefined) return args;
	return args === "" ? `${flag} ${value}` : `${args} ${flag} ${value}`;
}

// --- Gramática de niveles retirada (issue #102): se borra cuando su último consumidor migra. ---
export type AutonomyCode = "A1" | "A2" | "A3";
export type AutonomyName = "supervised" | "plan-approved" | "unattended";

export type ParsedAutonomy =
	| { ok: true; code: AutonomyCode; name: AutonomyName }
	| { ok: false; message: string };

const SUPPORTED: Array<{ code: AutonomyCode; name: AutonomyName }> = [
	{ code: "A1", name: "supervised" },
	{ code: "A2", name: "plan-approved" },
	{ code: "A3", name: "unattended" },
];
const UNSUPPORTED = new Set(["a0", "manual", "a4", "auto-land", "a5", "auto-deploy"]);
export const VALID_LEVELS = "válidos: supervised (A1), plan-approved (A2), unattended (A3)";

export function parseAutonomyLevel(token: string): ParsedAutonomy {
	const lower = token.trim().toLowerCase();
	const level = SUPPORTED.find((candidate) => candidate.code.toLowerCase() === lower || candidate.name === lower);
	if (level) return { ok: true, code: level.code, name: level.name };
	if (UNSUPPORTED.has(lower)) return { ok: false, message: `--autonomy ${token}: no soportado todavía (v1 honra A1–A3)` };
	return { ok: false, message: `--autonomy ${token}: valor inválido; ${VALID_LEVELS}` };
}

export function withAutonomy(args: string, level: AutonomyCode | undefined): string {
	if (level === undefined) return args;
	return args === "" ? `--autonomy ${level}` : `${args} --autonomy ${level}`;
}

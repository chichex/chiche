// Rutas de los artefactos de planificación (spec #84, CA-9; issue #103, CA-1).
//
// Los borradores (handoffs de grill y specs locales) se escriben en
// <git-common-dir>/chiche/<kind>: fuera del working tree, compartido por todos
// los worktrees del repo e invisible para `git status`. Se leen de cuatro
// lugares: los trackeados <root>/.chiche/<kind> y <root>/.sdd/<kind>, donde
// quedan los artefactos que un PR ya commiteó, y los locales
// <git-common-dir>/chiche/<kind> y <git-common-dir>/sdd/<kind>. Un artefacto se
// identifica por su nombre: ante el mismo nombre gana el trackeado sobre el
// local y chiche sobre sdd. Los lugares `sdd` son solo de lectura, hasta que
// una spec posterior retire la doble lectura. Fuera de un repo git no hay
// common-dir y el lugar local de cada marca es el trackeado. Desde el issue
// #134 (CA-13), si `## Publicacion` del contrato de la raíz operativa declara
// una `carpeta` distinta del default, `<carpeta>/<kind>` se lee primero y
// recibe lo nuevo; con la carpeta default nada cambia.

import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ArtifactKind = "grills" | "specs";
export type ArtifactBrand = "chiche" | "sdd";
export type ArtifactLocation = "tracked" | "local";

export interface ArtifactDirs {
	/** `<root>/.chiche/<kind>`. */
	tracked: string;
	/** `<git-common-dir>/chiche/<kind>`: el destino de todo artefacto nuevo. */
	local: string;
	/** `<root>/.sdd/<kind>`, solo lectura. */
	legacyTracked: string;
	/** `<git-common-dir>/sdd/<kind>`, solo lectura. */
	legacyLocal: string;
	/**
	 * `<carpeta>/<kind>` cuando `## Publicacion` del contrato declara una carpeta
	 * distinta del default (issue #134, CA-13): se lee primero y recibe lo nuevo
	 * (`artifactWriteDir`); los cuatro lugares de siempre se siguen leyendo.
	 */
	declared?: string;
}

export interface ArtifactReadDir {
	path: string;
	location: ArtifactLocation;
	brand: ArtifactBrand;
}

export interface ArtifactEntry extends Omit<ArtifactReadDir, "path"> {
	name: string;
	path: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string }>;
export type StatPort = (path: string) => Promise<Pick<Stats, "isFile">>;

const COMMON_DIR_ARGS = ["rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
const TRACKED_DIR: Record<ArtifactBrand, string> = { chiche: ".chiche", sdd: ".sdd" };

export const defaultGitRunner: GitRunner = (args, cwd) =>
	new Promise((resolveRun) => {
		execFile("git", [...args], { cwd, encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolveRun({ code, stdout: String(stdout ?? "") });
		});
	});

/** `<git-common-dir>` absoluto de `root`, o `null` fuera de un repo git. */
export async function resolveGitCommonDir(root: string, runGit: GitRunner = defaultGitRunner): Promise<string | null> {
	try {
		const result = await runGit(COMMON_DIR_ARGS, root);
		const commonDir = result.code === 0 ? result.stdout.trim() : "";
		return commonDir && isAbsolute(commonDir) ? resolve(commonDir) : null;
	} catch {
		return null;
	}
}

/** Los cuatro lugares sin consultar git: el local de cada marca es su trackeado. */
export function trackedArtifactDirs(root: string, kind: ArtifactKind): ArtifactDirs {
	const tracked = join(resolve(root), TRACKED_DIR.chiche, kind);
	const legacyTracked = join(resolve(root), TRACKED_DIR.sdd, kind);
	return { tracked, local: tracked, legacyTracked, legacyLocal: legacyTracked };
}

/** `<git-common-dir>/<marca>/<kind>` dado el common-dir ya resuelto; por defecto, chiche. */
export function localArtifactDir(commonDir: string, kind: ArtifactKind, brand: ArtifactBrand = "chiche"): string {
	return join(resolve(commonDir), brand, kind);
}

export type ContractReader = (path: string) => Promise<string>;
const defaultContractReader: ContractReader = (path) => readFile(path, "utf8");
const PUBLICATION_DEFAULT_FOLDER = /^<git-common-dir>\/chiche\/?$/;

/**
 * La `carpeta` declarada en `## Publicacion` del contrato (issue #134, CA-13),
 * con las mismas reglas que el comando canónico `publication-resolve`: una ruta
 * relativa a la raíz, normalizada (sin `./` inicial ni `/` final; `.` es la
 * raíz misma), o `null` con el literal default `<git-common-dir>/chiche/`, sin
 * la sección o la fila, o con un valor inválido (absoluta, otro placeholder o
 * un segmento `..`).
 */
export function publicationFolder(contract: string): string | null {
	const lines = contract.replace(/\r/g, "").split("\n");
	const start = lines.indexOf("## Publicacion");
	if (start === -1) return null;
	let value = "";
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("## ")) break;
		const match = /^\|\s*carpeta\s*\|([^|]*)\|/.exec(line);
		if (match) {
			value = (match[1] ?? "").trim();
			break;
		}
	}
	if (!value || PUBLICATION_DEFAULT_FOLDER.test(value)) return null;
	if (value.startsWith("/") || value.startsWith("<")) return null;
	if (`/${value}/`.includes("/../")) return null;
	const relativePath = value.replace(/^\.\//, "").replace(/\/+$/, "");
	return relativePath === "" ? "." : relativePath;
}

/** `<carpeta>/<kind>` de la carpeta declarada en `contract`, o `undefined` con la default. */
export function declaredArtifactDir(root: string, kind: ArtifactKind, contract: string): string | undefined {
	const folder = publicationFolder(contract);
	return folder === null ? undefined : join(resolve(root), folder, kind);
}

/** El contrato de la raíz operativa: `.chiche/project.md`, con fallback a `.sdd/project.md`; vacío si no hay o no se puede leer. */
async function readContractText(root: string, readContract: ContractReader): Promise<string> {
	for (const directory of [TRACKED_DIR.chiche, TRACKED_DIR.sdd]) {
		try {
			return await readContract(join(resolve(root), directory, "project.md"));
		} catch {
			// el siguiente lugar
		}
	}
	return "";
}

/**
 * Los lugares de `kind` para `root`. `readContract` es el seam que lee el
 * contrato de la raíz operativa (issue #134, CA-13): con una `carpeta`
 * declarada, `declared` es `<carpeta>/<kind>` y `local` sigue siendo el
 * common-dir, que se sigue leyendo.
 */
export async function resolveArtifactDirs(root: string, kind: ArtifactKind, runGit: GitRunner = defaultGitRunner, readContract: ContractReader = defaultContractReader): Promise<ArtifactDirs> {
	const dirs = trackedArtifactDirs(root, kind);
	const commonDir = await resolveGitCommonDir(root, runGit);
	const base = commonDir
		? { ...dirs, local: localArtifactDir(commonDir, kind), legacyLocal: localArtifactDir(commonDir, kind, "sdd") }
		: dirs;
	const declared = declaredArtifactDir(root, kind, await readContractText(root, readContract));
	return declared ? { ...base, declared } : base;
}

/** Donde se escribe un artefacto nuevo: la carpeta declarada si la hay, y si no `<git-common-dir>/chiche/<kind>`. */
export function artifactWriteDir(dirs: ArtifactDirs): string {
	return typeof dirs.declared === "string" ? dirs.declared : dirs.local;
}

/**
 * Los lugares de lectura en orden de precedencia (la carpeta declarada en
 * `## Publicacion` primero, si la hay), sin repetir un mismo directorio. Un objeto con la forma vieja `{ tracked, local }` (el
 * `SddArtifactDirs` de antes del issue #103) se acepta: los lugares que faltan
 * se saltean.
 */
export function artifactReadDirs(dirs: ArtifactDirs): ArtifactReadDir[] {
	const ordered: ArtifactReadDir[] = [
		// Issue #134, CA-13: la carpeta declarada va primera; vive en el árbol, así que es `tracked`.
		...(typeof dirs.declared === "string" ? [{ path: dirs.declared, location: "tracked" as const, brand: "chiche" as const }] : []),
		{ path: dirs.tracked, location: "tracked", brand: "chiche" },
		{ path: dirs.legacyTracked, location: "tracked", brand: "sdd" },
		{ path: dirs.local, location: "local", brand: "chiche" },
		{ path: dirs.legacyLocal, location: "local", brand: "sdd" },
	];
	const seen = new Set<string>();
	return ordered.filter((entry) => {
		if (typeof entry.path !== "string") return false;
		const key = resolve(entry.path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Acepta solo una ruta absoluta directamente bajo alguno de los cuatro lugares. */
export function isArtifactPath(dirs: ArtifactDirs, path: string): boolean {
	if (!isAbsolute(path)) return false;
	const parent = dirname(resolve(path));
	return artifactReadDirs(dirs).some((entry) => parent === resolve(entry.path));
}

async function markdownFiles(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Une los Markdown de los cuatro lugares; ante el mismo nombre gana el primero en precedencia. */
export async function listArtifacts(dirs: ArtifactDirs): Promise<ArtifactEntry[]> {
	const byName = new Map<string, ArtifactEntry>();
	for (const directory of artifactReadDirs(dirs)) {
		for (const name of await markdownFiles(directory.path)) {
			if (!byName.has(name)) byName.set(name, { name, path: join(directory.path, name), location: directory.location, brand: directory.brand });
		}
	}
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Ruta de un artefacto por nombre: el archivo existente con la misma
 * precedencia que `listArtifacts`, o `artifactWriteDir(dirs)/<name>` (la
 * carpeta declarada, o `<git-common-dir>/chiche/<kind>`) si todavía no existe. Ejemplo: `x.md` solo en `.sdd/specs/` resuelve ahí y
 * se actualiza en su lugar; `nueva.md` resuelve al lugar local de chiche.
 * `statPort` es el seam para tests y para quien ya inyecta su propio `stat`.
 */
export async function resolveArtifactName(dirs: ArtifactDirs, name: string, statPort: StatPort = stat): Promise<string> {
	for (const directory of artifactReadDirs(dirs)) {
		const path = join(directory.path, name);
		if (await statPort(path).then((entry) => entry.isFile(), () => false)) return path;
	}
	return join(artifactWriteDir(dirs), name);
}

/** Worktrees del repo de `root` según `git worktree list --porcelain`; el primero es el principal. */
export async function resolveRepoWorktrees(root: string, runGit: GitRunner = defaultGitRunner): Promise<string[]> {
	try {
		const result = await runGit(["worktree", "list", "--porcelain"], root);
		if (result.code !== 0) return [];
		return result.stdout
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => resolve(line.slice("worktree ".length)));
	} catch {
		return [];
	}
}

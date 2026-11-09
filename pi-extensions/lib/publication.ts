// Lectura de `## Publicacion` del contrato en Pi (issue #134, capa 3: CA-15,
// CA-16, CA-20). Aplica las mismas reglas que el comando canónico
// `publication-resolve` de los skills: un valor inválido o ausente cae al
// default de su clave. `issueCommandArgv` arma el argv de la plantilla
// `crear issue` sin pasar por un shell (los valores viajan como un argumento
// cada uno, el equivalente de las comillas simples con escape de la doctrina)
// e `issueUrlFromOutput` toma la URL del issue creado, cuyo repo tiene que
// ser el esperado.

import { publicationFolder, readProjectContract, type ContractReader } from "./chiche-paths.ts";

export const DEFAULT_ISSUE_TEMPLATE = "gh issue create --repo {repo} --title {title} --body-file {body}";
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ISSUE_URL = /https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/issues\/([1-9][0-9]*)(?![0-9])/;

export interface PublicationSettings {
	/** Destino de una spec nueva: `auto` (la regla de siempre), `issue` o `local`. */
	specs: "auto" | "issue" | "local";
	/** Carpeta de los `.md` de specs y grills, relativa a la raíz; `null` con la default `<git-common-dir>/chiche/`. */
	folder: string | null;
	/** `owner/repo` donde se crean y leen los issues; `null` sin la fila (rige el de `origin`). */
	repo: string | null;
	/** Plantilla del comando que crea un issue, con `{title}` y `{body}` obligatorios y `{repo}` opcional. */
	template: string;
}

export interface CreatedIssueUrl {
	repository: string;
	number: number;
	url: string;
}

function publicationRow(contract: string, key: string): string {
	const lines = contract.replace(/\r/g, "").split("\n");
	const start = lines.indexOf("## Publicacion");
	if (start === -1) return "";
	const pattern = new RegExp(`^\\|\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|([^|]*)\\|`);
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("## ")) break;
		const match = pattern.exec(line);
		if (match) return (match[1] ?? "").trim();
	}
	return "";
}

export function publicationSettings(contract: string): PublicationSettings {
	const specsRaw = publicationRow(contract, "specs");
	const repoRaw = publicationRow(contract, "repo");
	const templateRaw = publicationRow(contract, "crear issue");
	return {
		specs: specsRaw === "issue" || specsRaw === "local" ? specsRaw : "auto",
		folder: publicationFolder(contract),
		repo: REPOSITORY.test(repoRaw) ? repoRaw : null,
		template: templateRaw.includes("{title}") && templateRaw.includes("{body}") ? templateRaw : DEFAULT_ISSUE_TEMPLATE,
	};
}

/** La sección del contrato de la raíz operativa (`.chiche/project.md`, con fallback a `.sdd/project.md`). */
export async function readPublicationSettings(root: string, readContract?: ContractReader): Promise<PublicationSettings> {
	return publicationSettings(await readProjectContract(root, readContract));
}

// Tokenizador mínimo al estilo shell: espacios separan, las comillas simples y
// dobles agrupan y la barra invertida escapa fuera de comillas simples.
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let hasToken = false;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index] ?? "";
		if (quote !== null) {
			if (character === quote) {
				quote = null;
			} else if (character === "\\" && quote === '"' && index + 1 < input.length) {
				index += 1;
				current += input[index];
			} else {
				current += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			hasToken = true;
			continue;
		}
		if (character === "\\" && index + 1 < input.length) {
			index += 1;
			current += input[index];
			hasToken = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
			continue;
		}
		current += character;
		hasToken = true;
	}
	if (quote !== null) throw new Error("La plantilla de `crear issue` tiene una comilla sin cerrar");
	if (hasToken) tokens.push(current);
	return tokens;
}

/** El argv de la plantilla con `{repo}`, `{title}` y `{body}` reemplazados, cada valor como un solo argumento. */
export function issueCommandArgv(template: string, values: { repo: string; title: string; body: string }): string[] {
	const tokens = tokenize(template);
	if (tokens.length === 0) throw new Error("La plantilla de `crear issue` está vacía");
	return tokens.map((token) => token.replaceAll("{repo}", values.repo).replaceAll("{title}", values.title).replaceAll("{body}", values.body));
}

/** La primera URL `https://github.com/<owner>/<repo>/issues/<N>` de la salida, o `null`. */
export function issueUrlFromOutput(output: string): CreatedIssueUrl | null {
	const match = ISSUE_URL.exec(output);
	if (!match?.[1] || !match[2]) return null;
	const number = Number(match[2]);
	return Number.isSafeInteger(number) ? { repository: match[1], number, url: match[0] } : null;
}

/** El número de la URL impresa, solo si su repo es `repository` (sin distinguir mayúsculas). */
export function issueNumberFromUrl(output: string, repository: string): number | null {
	const created = issueUrlFromOutput(output);
	return created && created.repository.toLowerCase() === repository.toLowerCase() ? created.number : null;
}

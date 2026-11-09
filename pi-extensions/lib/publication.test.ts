// Issue #134, capa 3 (CA-15, CA-16, CA-20): la lectura de `## Publicacion` en Pi.
// `publicationSettings` aplica las mismas reglas que el comando canónico
// `publication-resolve` de los skills; `issueCommandArgv` arma el argv de la
// plantilla `crear issue` sin pasar por un shell; `issueNumberFromUrl` toma el
// número de la URL impresa y exige que su repo sea el esperado.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_ISSUE_TEMPLATE, issueCommandArgv, issueNumberFromUrl, publicationSettings } from "./publication.ts";

function contract(rows: Record<string, string> | null): string {
	const table = rows === null ? [] : ["## Publicacion", "| Clave | Valor |", "|---|---|", ...Object.entries(rows).map(([key, value]) => `| ${key} | ${value} |`), ""];
	return ["# Contrato de autonomia — demo", "", "## Comandos", "", ...table, "## Verificacion autonoma", "1. node --test", ""].join("\n");
}

test("#134 CA-15/CA-16: publicationSettings lee specs, carpeta, repo y plantilla con las reglas del comando canónico: válidos tal cual, inválidos o ausentes al default", () => {
	const template = "gh issue create --repo {repo} --label spec --title {title} --body-file {body}";
	assert.deepEqual(publicationSettings(contract({ specs: "issue", carpeta: "docs/sdd/", repo: "pramaestudio/backlog", "crear issue": template })), {
		specs: "issue",
		folder: "docs/sdd",
		repo: "pramaestudio/backlog",
		template,
	});
	assert.deepEqual(publicationSettings(contract(null)), { specs: "auto", folder: null, repo: null, template: DEFAULT_ISSUE_TEMPLATE }, "sin la sección rigen los defaults");
	assert.deepEqual(publicationSettings(""), { specs: "auto", folder: null, repo: null, template: DEFAULT_ISSUE_TEMPLATE });
	const invalid = publicationSettings(contract({ specs: "siempre", carpeta: "/tmp/x", repo: "acme", "crear issue": "gh issue create --title {title}" }));
	assert.deepEqual(invalid, { specs: "auto", folder: null, repo: null, template: DEFAULT_ISSUE_TEMPLATE }, "cada inválido cae al default de su clave");
	assert.equal(publicationSettings(contract({ repo: "acme/wid gets" })).repo, null);
	assert.equal(publicationSettings(contract({ "crear issue": "gh issue create --repo {repo} --body-file {body}" })).template, DEFAULT_ISSUE_TEMPLATE, "sin {title} rige la default");
	assert.equal(publicationSettings(contract({ "crear issue": "mi-cli nuevo --titulo {title} --cuerpo {body}" })).template, "mi-cli nuevo --titulo {title} --cuerpo {body}", "{repo} es opcional");
});

test("#134 CA-15: issueCommandArgv tokeniza la plantilla respetando comillas y reemplaza {repo}, {title} y {body} como un solo argumento cada uno", () => {
	assert.deepEqual(issueCommandArgv(DEFAULT_ISSUE_TEMPLATE, { repo: "acme/backlog", title: "Hola mundo: un título", body: "/tmp/body x.md" }), [
		"gh", "issue", "create", "--repo", "acme/backlog", "--title", "Hola mundo: un título", "--body-file", "/tmp/body x.md",
	]);
	assert.deepEqual(issueCommandArgv("gh issue create --repo {repo} --label \"needs triage\" --label 'spec' --title={title} --body-file {body}", { repo: "a/b", title: "T", body: "/b.md" }), [
		"gh", "issue", "create", "--repo", "a/b", "--label", "needs triage", "--label", "spec", "--title=T", "--body-file", "/b.md",
	]);
	assert.deepEqual(issueCommandArgv("tool {title} {body}", { repo: "a/b", title: "x'y", body: "/z" }), ["tool", "x'y", "/z"], "las comillas del valor viajan tal cual, sin shell");
	assert.throws(() => issueCommandArgv("", { repo: "a/b", title: "T", body: "/b" }), /vacía/);
});

test("#134 CA-15: issueNumberFromUrl toma el número de https://github.com/<owner>/<repo>/issues/<N> solo si el repo es el esperado", () => {
	assert.equal(issueNumberFromUrl("Creating issue in acme/backlog\n\nhttps://github.com/acme/backlog/issues/42\n", "acme/backlog"), 42);
	assert.equal(issueNumberFromUrl("https://github.com/ACME/Backlog/issues/7", "acme/backlog"), 7, "el repo se compara sin distinguir mayúsculas");
	assert.equal(issueNumberFromUrl("https://github.com/otro/repo/issues/42\n", "acme/backlog"), null, "una URL de otro repo no cuenta");
	assert.equal(issueNumberFromUrl("ok\n", "acme/backlog"), null, "sin URL no hay número");
	assert.equal(issueNumberFromUrl("https://github.com/acme/backlog/pull/42\n", "acme/backlog"), null, "un PR no es un issue");
	assert.equal(issueNumberFromUrl("https://github.com/acme/backlog/issues/0\n", "acme/backlog"), null);
});

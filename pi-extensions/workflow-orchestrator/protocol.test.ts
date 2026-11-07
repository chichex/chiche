import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createSubmitWorkflowResolutionTool,
	validateWorkflowResolution,
	WorkflowResolutionValidationError,
} from "./protocol.ts";

function issue(number: number) {
	return { repository: "chichex/chiche", number };
}

function startResolution() {
	return {
		version: 1,
		outcome: "start",
		code: "spec",
		recommendedClassification: "spec",
		fallbackClassification: "grill",
		recommendedRoute: "spec",
		selectedRoute: "spec",
		stage: "spec",
		mode: "new",
		repo: "chichex/chiche",
		cwd: "/workspace/skills",
		sources: [issue(13)],
		canonicalIssue: issue(13),
		summary: "Implementar primitivas reutilizables.",
		impactExample: "El stage empieza en una sesión limpia.",
		scope: ["materialización", "sesiones"],
		checklist: ["parentSession", "cwd"],
		evidence: [{ kind: "issue", reference: "#13", detail: "selección confirmada" }],
		risks: ["contexto stale"],
		artifacts: [{
			id: "spec-13",
			location: "issue",
			path: "https://github.com/chichex/chiche/issues/13",
			type: "spec",
			state: "approved",
			format: "canonical",
			provenance: "canonical",
			identityProvenance: "canonical",
			issue: issue(13),
			grill: null,
			project: null,
			supersededBy: null,
			parentId: null,
			revision: null,
			freshness: "fresh",
			primary: true,
			diagnostics: [{ code: "fresh", message: "issue body is current" }],
		}],
		verdict: null,
	};
}

test("validates and canonically clones a complete start resolution without merging recommendation and choice", () => {
	const input = startResolution();
	const result = validateWorkflowResolution(input);

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.value, input);
	assert.notEqual(result.value, input);
	assert.notEqual(result.value.sources, input.sources);
	assert.equal(result.value.recommendedRoute, "spec");
	assert.equal(result.value.selectedRoute, "spec");
	assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value);
});

test("accepts the full v1 discriminated outcomes start, stop, and error", () => {
	const start = startResolution();
	const stop = {
		...start,
		outcome: "stop",
		code: "cancelled",
		selectedRoute: null,
		stage: null,
		mode: null,
	};
	const error = {
		...start,
		outcome: "error",
		code: "canonicalization",
		recommendedRoute: null,
		selectedRoute: null,
		stage: null,
		mode: null,
		artifacts: [],
	};

	for (const value of [start, stop, error]) {
		const result = validateWorkflowResolution(value);
		assert.equal(result.ok, true, `${value.outcome}: ${result.ok ? "" : result.diagnostics.join(", ")}`);
	}
});

test("rejects missing, extra, invalid enum, and malformed nested protocol fields", () => {
	const base = startResolution();
	const { version: _version, ...missingVersion } = base;
	const cases: Array<{ name: string; value: unknown; path: string }> = [
		{ name: "missing", value: missingVersion, path: "$.version" },
		{ name: "root extra", value: { ...base, transcript: "do not scrape" }, path: "$.transcript" },
		{ name: "enum", value: { ...base, outcome: "continue" }, path: "$.outcome" },
		{
			name: "nested extra",
			value: { ...base, canonicalIssue: { ...base.canonicalIssue, title: "extra" } },
			path: "$.canonicalIssue.title",
		},
		{
			name: "nested type",
			value: { ...base, artifacts: [{ ...base.artifacts[0], primary: "yes" }] },
			path: "$.artifacts[0].primary",
		},
	];

	for (const fixture of cases) {
		const result = validateWorkflowResolution(fixture.value);
		assert.equal(result.ok, false, fixture.name);
		if (result.ok) continue;
		assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === fixture.path), fixture.name);
	}
});

test("terminal tool schema offers exactly the supported routes and stages", () => {
	const properties = (createSubmitWorkflowResolutionTool().parameters as {
		properties: Record<string, { anyOf?: Array<{ enum?: string[] }> }>;
	}).properties;
	const enumOf = (field: string) => properties[field]?.anyOf?.[0]?.enum;
	const newWork = [
		"blocked-dependency",
		"split-too-large",
		"grill",
		"spec",
		"incoherent-selection",
		"combined-too-large",
		"join-grill",
		"join-spec",
	];
	const existingWork = [
		"resume-grill",
		"spec-from-grill",
		"update-existing-spec",
		"run-existing-spec",
		"already-implemented",
		"superseded-artifact",
		"audit-existing-spec",
		"artifact-conflict",
	];

	assert.deepEqual(enumOf("stage"), ["grill", "spec", "run-existing-spec"]);
	assert.deepEqual(enumOf("recommendedClassification"), newWork);
	assert.deepEqual(enumOf("fallbackClassification"), newWork);
	assert.deepEqual(enumOf("recommendedRoute"), [...newWork, ...existingWork]);
	assert.deepEqual(enumOf("selectedRoute"), [...newWork, ...existingWork]);
});

test("registerable terminal tool exposes a strict complete schema and returns the validated value", async () => {
	const tool = createSubmitWorkflowResolutionTool();
	const schema = tool.parameters as {
		additionalProperties?: boolean;
		required?: string[];
		properties?: Record<string, unknown>;
	};
	const expectedFields = [
		"version", "outcome", "code", "recommendedClassification", "fallbackClassification",
		"recommendedRoute", "selectedRoute", "stage", "mode", "repo", "cwd", "sources",
		"canonicalIssue", "summary", "impactExample", "scope", "checklist", "evidence", "risks", "artifacts", "verdict",
	];

	assert.equal(tool.name, "submit_workflow_resolution");
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.required, expectedFields);
	assert.deepEqual(Object.keys(schema.properties ?? {}), expectedFields);

	const input = startResolution();
	const result = await tool.execute("tool-1", input);
	assert.deepEqual(result.details, input);
	assert.equal(result.terminate, true);
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0]?.type, "text");
	assert.ok((result.content[0]?.text.length ?? Infinity) <= 160);
});

test("terminal tool throws a typed error for invalid input and performs no callback mutation", async () => {
	const tool = createSubmitWorkflowResolutionTool();
	const invalid = { ...startResolution(), selectedRoute: undefined };

	await assert.rejects(
		() => tool.execute("tool-2", invalid),
		(error: unknown) => {
			assert.ok(error instanceof WorkflowResolutionValidationError);
			assert.equal(error.code, "invalid-workflow-resolution");
			assert.ok(error.diagnostics.some((diagnostic) => diagnostic.path === "$.selectedRoute"));
			return true;
		},
	);
});

// Issue #119, CA-17: el veredicto del triage viaja en `verdict` (null en stop/error y en toda ruta
// artifact-aware; objeto en grill/spec/join-*), con `version: 1` intacto y el campo obligatorio.
function verdict(overrides: Record<string, unknown> = {}) {
	return {
		until: "pr",
		accepted: true,
		thresholds: { grill: 80, spec: 80 },
		questions: [{ text: "¿aplica a juegos 2D, 3D o todos?", confidence: 35 }],
		assumed: [{ text: "parametrizable, con tecla y tamaño", confidence: 95 }],
		forSpec: [{ text: "usa el store existente", confidence: 90 }],
		warnings: ["sin tests en el área"],
		...overrides,
	};
}

test("#119 CA-17: verdict se acepta como null o como objeto en una ruta nueva, se clona en el round-trip, y se rechaza fuera de rango, con until desconocido, ausente, con campos extra o fuera de una ruta nueva", () => {
	const withVerdict = { ...startResolution(), code: "grill", recommendedClassification: "grill", fallbackClassification: "spec", recommendedRoute: "grill", selectedRoute: "grill", stage: "grill", verdict: verdict() };
	const ok = validateWorkflowResolution(withVerdict);
	assert.equal(ok.ok, true, JSON.stringify(ok));
	if (ok.ok) {
		assert.deepEqual(ok.value, withVerdict);
		assert.notEqual(ok.value.verdict, withVerdict.verdict, "el veredicto se clona");
		assert.deepEqual(JSON.parse(JSON.stringify(ok.value)), ok.value);
	}
	for (const route of ["spec", "join-grill", "join-spec"]) {
		const stage = route.endsWith("grill") ? "grill" : "spec";
		const result = validateWorkflowResolution({ ...withVerdict, code: route, recommendedRoute: route, selectedRoute: route, stage, verdict: verdict({ until: "spec", accepted: false }) });
		assert.equal(result.ok, true, `${route}: ${JSON.stringify(result)}`);
	}
	const nullable = validateWorkflowResolution(startResolution());
	assert.equal(nullable.ok, true);
	if (nullable.ok) assert.equal(nullable.value.verdict, null);
	const cases: Array<{ name: string; value: unknown; path: string; code: string }> = [
		{ name: "confidence 120", value: { ...withVerdict, verdict: verdict({ questions: [{ text: "x", confidence: 120 }] }) }, path: "$.verdict.questions[0].confidence", code: "invalid-value" },
		{ name: "confidence -1", value: { ...withVerdict, verdict: verdict({ assumed: [{ text: "x", confidence: -1 }] }) }, path: "$.verdict.assumed[0].confidence", code: "invalid-value" },
		{ name: "confidence 7.5", value: { ...withVerdict, verdict: verdict({ forSpec: [{ text: "x", confidence: 7.5 }] }) }, path: "$.verdict.forSpec[0].confidence", code: "invalid-value" },
		{ name: "threshold 101", value: { ...withVerdict, verdict: verdict({ thresholds: { grill: 101, spec: 80 } }) }, path: "$.verdict.thresholds.grill", code: "invalid-value" },
		{ name: "until x", value: { ...withVerdict, verdict: verdict({ until: "x" }) }, path: "$.verdict.until", code: "invalid-value" },
		{ name: "accepted string", value: { ...withVerdict, verdict: verdict({ accepted: "yes" }) }, path: "$.verdict.accepted", code: "invalid-type" },
		{ name: "extra field", value: { ...withVerdict, verdict: verdict({ level: "A3" }) }, path: "$.verdict.level", code: "extra-field" },
		{ name: "missing warnings", value: { ...withVerdict, verdict: (({ warnings: _w, ...rest }) => rest)(verdict()) }, path: "$.verdict.warnings", code: "missing-field" },
		{ name: "missing verdict", value: (({ verdict: _v, ...rest }) => rest)(startResolution()), path: "$.verdict", code: "missing-field" },
		{ name: "verdict on stop", value: { ...startResolution(), outcome: "stop", code: "cancelled", selectedRoute: null, stage: null, mode: null, verdict: verdict() }, path: "$.verdict", code: "invalid-value" },
		{ name: "verdict on artifact-aware", value: { ...startResolution(), code: "run-existing-spec", recommendedRoute: "run-existing-spec", selectedRoute: "run-existing-spec", stage: "run-existing-spec", mode: null, verdict: verdict() }, path: "$.verdict", code: "invalid-value" },
	];
	for (const fixture of cases) {
		const result = validateWorkflowResolution(fixture.value);
		assert.equal(result.ok, false, fixture.name);
		if (result.ok) continue;
		assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === fixture.path && diagnostic.code === fixture.code), `${fixture.name}: ${JSON.stringify(result.diagnostics)}`);
	}
	const schema = createSubmitWorkflowResolutionTool().parameters as { properties: Record<string, { anyOf?: Array<Record<string, unknown>> }> };
	const verdictSchema = schema.properties.verdict?.anyOf?.[0] as { required?: string[]; additionalProperties?: boolean; properties?: Record<string, { enum?: string[] }> } | undefined;
	assert.ok(verdictSchema, "el schema de la tool declara verdict");
	assert.deepEqual(verdictSchema.required, ["until", "accepted", "thresholds", "questions", "assumed", "forSpec", "warnings"]);
	assert.equal(verdictSchema.additionalProperties, false);
	assert.deepEqual(verdictSchema.properties?.until?.enum, ["pr", "spec"]);
	assert.deepEqual(schema.properties.verdict?.anyOf?.[1], { type: "null" });
});

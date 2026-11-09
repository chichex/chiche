import assert from "node:assert/strict";
import { test } from "node:test";

import * as orchestrator from "./index.ts";
import { ACTIONABLE_ROUTE_CONTRACT } from "./route-contract.ts";

function issue(number: number) {
	return { repository: "chichex/chiche", number };
}

function resolution(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		outcome: "start",
		code: "spec",
		recommendedClassification: "grill",
		fallbackClassification: "spec",
		recommendedRoute: "grill",
		selectedRoute: "spec",
		stage: "spec",
		mode: "new",
		repo: "chichex/chiche",
		cwd: "/workspace/skills",
		sources: [issue(14)],
		canonicalIssue: issue(14),
		summary: "Integrate SDD transitions.",
		impactExample: "A confirmed fallback starts the selected spec stage.",
		scope: ["Pi orchestration"],
		checklist: ["fresh child"],
		evidence: [],
		risks: [],
		artifacts: [],
		verdict: null,
		...overrides,
	};
}

test("dispatch follows selectedRoute rather than the original recommendation", () => {
	assert.equal(typeof (orchestrator as Record<string, unknown>).resolveWorkflowDispatch, "function");
	const result = orchestrator.resolveWorkflowDispatch(resolution());
	assert.deepEqual(result, {
		ok: true,
		request: {
			resolution: resolution(),
			skill: { name: "chiche-spec", args: "#14" },
		},
	});
});

function artifact(type: "grill" | "spec", overrides: Record<string, unknown> = {}) {
	return {
		id: `${type}-primary`,
		location: type === "grill" ? "snapshot" : "local",
		path: type === "grill" ? "/snapshots/grill-14.json" : "/workspace/skills/.sdd/specs/issue-14.md",
		type,
		state: type === "grill" ? "active" : "approved",
		format: type === "grill" ? "snapshot" : "canonical",
		provenance: type === "grill" ? "snapshot" : "canonical",
		identityProvenance: type === "grill" ? "snapshot" : "canonical",
		issue: issue(14),
		grill: type === "grill" ? "grill-leaf-14" : null,
		project: type === "grill" ? "/workspace/skills" : null,
		supersededBy: null,
		parentId: null,
		revision: type === "grill" ? 2 : null,
		freshness: "fresh",
		primary: true,
		diagnostics: [],
		...overrides,
	};
}

test("dispatch maps every actionable route to one canonical downstream skill and target", () => {
	const cases = [
		["grill", "grill", "new", [], "grill", "#14"],
		["join-grill", "grill", "new", [], "grill", "#14"],
		["spec", "spec", "new", [], "chiche-spec", "#14"],
		["join-spec", "spec", "new", [], "chiche-spec", "#14"],
		["resume-grill", "grill", "resume", [artifact("grill")], "grill", "--resume \"grill-leaf-14\""],
		[
			"spec-from-grill",
			"spec",
			"from-grill",
			[
				artifact("grill", {
					location: "handoff",
					path: "/workspace/skills/.sdd/grills/final.md",
					format: "canonical",
					provenance: "canonical",
					identityProvenance: "canonical",
					state: "finalized",
				}),
				artifact("grill", {
					id: "runtime-copy",
					state: "finalized",
					primary: false,
				}),
			],
			"chiche-spec",
			"--from-grill \"grill-leaf-14\"",
		],
		[
			"update-existing-spec",
			"spec",
			"update",
			[artifact("spec", { state: "draft" })],
			"chiche-spec",
			"/workspace/skills/.sdd/specs/issue-14.md",
		],
		[
			"audit-existing-spec",
			"spec",
			"update",
			[artifact("spec", { freshness: "unknown" })],
			"chiche-spec",
			"/workspace/skills/.sdd/specs/issue-14.md",
		],
		[
			"run-existing-spec",
			"run-existing-spec",
			null,
			[artifact("spec")],
			"chiche-run",
			"/workspace/skills/.sdd/specs/issue-14.md",
		],
	] as const;

	assert.deepEqual(
		cases.map(([route]) => route).sort(),
		Object.keys(ACTIONABLE_ROUTE_CONTRACT).sort(),
		"the matrix covers exactly the actionable routes",
	);
	for (const [route, stage, mode, artifacts, skill, expectedArgs] of cases) {
		const handoff = resolution({
			code: route,
			recommendedRoute: route,
			selectedRoute: route,
			stage,
			mode,
			artifacts,
		});
		const result = orchestrator.resolveWorkflowDispatch(handoff);
		assert.equal(result.ok, true, route);
		if (!result.ok) continue;
		assert.equal(result.request.skill.name, skill, route);
		assert.doesNotMatch(result.request.skill.name, /^sdd-/, `${route} nunca despacha un alias sdd-*`);
		assert.equal(result.request.skill.args, expectedArgs, route);
	}
});

test("CA-7/9: dispatch quotes unsafe logical grill ids without changing their identity", () => {
	const grill = "portable/unsafe id";
	const resumeInput = resolution({
		code: "resume-grill",
		recommendedRoute: "resume-grill",
		selectedRoute: "resume-grill",
		stage: "grill",
		mode: "resume",
		artifacts: [artifact("grill", { grill })],
	});
	const resumed = orchestrator.resolveWorkflowDispatch(resumeInput);
	assert.equal(resumed.ok, true);
	if (resumed.ok) assert.equal(resumed.request.skill.args, `--resume ${JSON.stringify(grill)}`);

	const handoff = artifact("grill", {
		location: "handoff",
		path: "/workspace/skills/.sdd/grills/final.md",
		format: "canonical",
		provenance: "canonical",
		identityProvenance: "canonical",
		state: "finalized",
		grill,
	});
	const snapshot = artifact("grill", {
		id: "runtime-copy",
		state: "finalized",
		primary: false,
		grill,
	});
	const specInput = resolution({
		code: "spec-from-grill",
		recommendedRoute: "spec-from-grill",
		selectedRoute: "spec-from-grill",
		stage: "spec",
		mode: "from-grill",
		artifacts: [handoff, snapshot],
	});
	const specified = orchestrator.resolveWorkflowDispatch(specInput);
	assert.equal(specified.ok, true);
	if (specified.ok) assert.equal(specified.request.skill.args, `--from-grill ${JSON.stringify(grill)}`);
});

test("CA-9: spec-from-grill dispatches a handoff-only by its validated absolute path", () => {
	const path = "/workspace/skills/.sdd/grills/final handoff.md";
	const portable = artifact("grill", {
		location: "handoff",
		path,
		state: "finalized",
		format: "canonical",
		provenance: "canonical",
		identityProvenance: "canonical",
		project: "/Users/old/skills",
	});
	const input = resolution({
		code: "spec-from-grill",
		recommendedRoute: "spec-from-grill",
		selectedRoute: "spec-from-grill",
		stage: "spec",
		mode: "from-grill",
		artifacts: [portable],
	});
	const result = orchestrator.resolveWorkflowDispatch(input);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.request.skill.args, `--from-grill ${JSON.stringify(path)}`);
});

test("CA-9: spec-from-grill rejects unsafe, non-finalized, and diagnosed handoff paths", () => {
	for (const overrides of [
		{ path: "/workspace/skills/elsewhere/final.md" },
		{ path: "/workspace/skills/.sdd/grills/nested/final.md" },
		{ path: "relative/.sdd/grills/final.md" },
		{ state: "paused" },
		{ diagnostics: [{ code: "unsafe", message: "bad metadata" }] },
	]) {
		const input = resolution({
			code: "spec-from-grill",
			recommendedRoute: "spec-from-grill",
			selectedRoute: "spec-from-grill",
			stage: "spec",
			mode: "from-grill",
			artifacts: [artifact("grill", {
				location: "handoff",
				path: "/workspace/skills/.sdd/grills/final.md",
				state: "finalized",
				format: "canonical",
				provenance: "canonical",
				identityProvenance: "canonical",
				...overrides,
			})],
		});
		const result = orchestrator.resolveWorkflowDispatch(input);
		assert.equal(result.ok, false, JSON.stringify(overrides));
		if (!result.ok) assert.equal(result.code, "invalid-grill-reference");
	}
});

// Spec #84, CA-12 e issue #103, CA-1: __sdd-dispatch acepta borradores en
// <git-common-dir>/chiche/ y <git-common-dir>/sdd/ cuando recibe los cuatro
// lugares del repo; sin ellos, solo los árboles trackeados .chiche/ y .sdd/.
const DRAFT_DIRS = {
	grills: {
		tracked: "/workspace/skills-wt/.chiche/grills",
		local: "/workspace/skills/.git/chiche/grills",
		legacyTracked: "/workspace/skills-wt/.sdd/grills",
		legacyLocal: "/workspace/skills/.git/sdd/grills",
	},
	specs: {
		tracked: "/workspace/skills-wt/.chiche/specs",
		local: "/workspace/skills/.git/chiche/specs",
		legacyTracked: "/workspace/skills-wt/.sdd/specs",
		legacyLocal: "/workspace/skills/.git/sdd/specs",
	},
};

function draftResolution(route: "spec-from-grill" | "run-existing-spec", path: string) {
	const draft = route === "spec-from-grill"
		? artifact("grill", {
			location: "handoff",
			path,
			state: "finalized",
			format: "canonical",
			provenance: "canonical",
			identityProvenance: "canonical",
			project: "/workspace/skills-wt",
		})
		: artifact("spec", { path });
	return resolution({
		cwd: "/workspace/skills-wt",
		code: route,
		recommendedRoute: route,
		selectedRoute: route,
		stage: route === "spec-from-grill" ? "spec" : "run-existing-spec",
		mode: route === "spec-from-grill" ? "from-grill" : null,
		artifacts: [draft],
	});
}

test("#84 CA-12: run-existing-spec y spec-from-grill aceptan borradores del common-dir con los dirs del repo", () => {
	for (const brand of ["chiche", "sdd"]) {
		const spec = `/workspace/skills/.git/${brand}/specs/issue-14.md`;
		const handoff = `/workspace/skills/.git/${brand}/grills/final.md`;
		const run = orchestrator.resolveWorkflowDispatch(draftResolution("run-existing-spec", spec), DRAFT_DIRS);
		assert.equal(run.ok, true, JSON.stringify(run));
		if (run.ok) assert.deepEqual(run.request.skill, { name: "chiche-run", args: spec });
		const fromGrill = orchestrator.resolveWorkflowDispatch(draftResolution("spec-from-grill", handoff), DRAFT_DIRS);
		assert.equal(fromGrill.ok, true, JSON.stringify(fromGrill));
		if (fromGrill.ok) assert.equal(fromGrill.request.skill.args, `--from-grill ${JSON.stringify(handoff)}`);

		assert.equal(orchestrator.resolveWorkflowDispatch(draftResolution("run-existing-spec", spec)).ok, false, `${brand}: sin dirs, el common-dir queda afuera`);
		assert.equal(orchestrator.resolveWorkflowDispatch(draftResolution("spec-from-grill", handoff)).ok, false, `${brand}: sin dirs, el handoff del common-dir queda afuera`);
		for (const outside of [`/workspace/skills/.git/${brand}/specs/nested/x.md`, `/workspace/otro/.git/${brand}/specs/x.md`]) {
			assert.equal(orchestrator.resolveWorkflowDispatch(draftResolution("run-existing-spec", outside), DRAFT_DIRS).ok, false, outside);
		}
		assert.equal(orchestrator.resolveWorkflowDispatch(draftResolution("spec-from-grill", `/workspace/skills/.git/${brand}/specs/final.md`), DRAFT_DIRS).ok, false);
	}
	const tracked = orchestrator.resolveWorkflowDispatch(draftResolution("spec-from-grill", "/workspace/skills-wt/.chiche/grills/final.md"));
	assert.equal(tracked.ok, true, `sin dirs, un handoff en .chiche/grills del árbol sigue valiendo: ${JSON.stringify(tracked)}`);
});

test("#84 CA-12: resolveWorkflowDispatchForCwd resuelve el common-dir con git desde el principal y desde un worktree linkeado", async () => {
	const { execFileSync } = await import("node:child_process");
	const { mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const git = (cwd: string, ...args: string[]) => execFileSync("git", [
		"-c", "user.name=sdd", "-c", "user.email=sdd@example.invalid", "-c", "commit.gpgsign=false", ...args,
	], { cwd, encoding: "utf8" });
	const base = await realpath(await mkdtemp(join(tmpdir(), "dispatch-draft-")));
	try {
		const main = join(base, "repo");
		execFileSync("mkdir", ["-p", main]);
		git(main, "init", "-q", "-b", "main");
		await writeFile(join(main, "README.md"), "repo\n");
		git(main, "add", "README.md");
		git(main, "commit", "-q", "-m", "init");
		const linked = join(base, "repo-wt");
		git(main, "worktree", "add", "-q", "-b", "feature", linked);
		for (const brand of ["chiche", "sdd"]) {
			const spec = join(main, ".git", brand, "specs", "issue-14.md");
			for (const cwd of [main, linked]) {
				const input = { ...draftResolution("run-existing-spec", spec), cwd };
				const result = await orchestrator.resolveWorkflowDispatchForCwd(input);
				assert.equal(result.ok, true, `${brand} · ${cwd}: ${JSON.stringify(result)}`);
				if (result.ok) assert.equal(result.request.skill.args, spec);
			}
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// Issue #130, CA-25 (antes #102 CA-9): `/issues` ya no lleva `--autonomy` y el despacho no recibe ningún nivel:
// sin veredicto aceptado los argumentos de toda ruta son los de siempre, sin flags de autonomía.
test("#130 CA-25: dispatch no agrega flags de autonomía a ninguna ruta y ya no acepta un nivel por opciones", () => {
	const routes = [
		["grill", "grill", "new", [], "#14"],
		["spec", "spec", "new", [], "#14"],
		["run-existing-spec", "run-existing-spec", null, [artifact("spec")], "/workspace/skills/.sdd/specs/issue-14.md"],
	] as const;
	for (const [route, stage, mode, artifacts, base] of routes) {
		const handoff = resolution({ code: route, recommendedRoute: route, selectedRoute: route, stage, mode, artifacts });
		const plain = orchestrator.resolveWorkflowDispatch(handoff);
		assert.ok(plain.ok, route);
		assert.equal(plain.request.skill.args, base, `${route}: sin flags`);
		// Un caller viejo que todavía pasa el nivel por opciones no consigue que viaje, ni válido ni inválido.
		for (const token of ["A2", "plan-approved", "unattended", "a1", "A4", "extreme"]) {
			const legacy = (orchestrator.resolveWorkflowDispatch as (...args: unknown[]) => ReturnType<typeof orchestrator.resolveWorkflowDispatch>)(handoff, undefined, { autonomy: token });
			assert.ok(legacy.ok, `${route} ${token}`);
			assert.equal(legacy.request.skill.args, base, `${route}: ${token} no viaja`);
			assert.equal(legacy.request.skill.name, plain.request.skill.name);
		}
	}
});

// Issue #130, CA-25 (antes #119 CA-18): con el veredicto aceptado (`Confirmar <ruta> → hasta el PR`) y la ruta
// recomendada confirmada, el despacho agrega `--until pr` a las rutas de grill y de spec, y nada más: ningún flag de
// confianza ni de posición. Sin aceptar (`Confirmar <ruta>`), con fallback o sin veredicto, los argumentos de siempre.
function verdict(accepted: boolean, overrides: Record<string, unknown> = {}) {
	return { until: "pr", accepted, thresholds: { grill: 80, spec: 80 }, questions: [], assumed: [], forSpec: [], warnings: [], ...overrides };
}

test("#130 CA-25: dispatch agrega solo --until pr con el veredicto aceptado en las rutas de grill y de spec, y deja los args de siempre sin aceptar, con fallback o sin veredicto", () => {
	const cases: Array<[string, string]> = [
		["grill", "grill"],
		["join-grill", "grill"],
		["spec", "chiche-spec"],
		["join-spec", "chiche-spec"],
	];
	for (const [route, skill] of cases) {
		const stage = route.endsWith("grill") ? "grill" : "spec";
		const base = { code: route, recommendedClassification: route, recommendedRoute: route, selectedRoute: route, stage };
		const result = orchestrator.resolveWorkflowDispatch(resolution({ ...base, verdict: verdict(true) }));
		assert.ok(result.ok, `${route}: ${JSON.stringify(result)}`);
		assert.equal(result.request.skill.args, "#14 --until pr", `${route} + hasta el PR`);
		assert.equal(result.request.skill.name, skill);
		// La cadena no depende de cuántas técnicas queden para la spec: ya no hay un destino «hasta la spec».
		const withTechnical = orchestrator.resolveWorkflowDispatch(resolution({ ...base, verdict: verdict(true, { forSpec: [{ text: "usa el store existente", confidence: 40 }] }) }));
		assert.ok(withTechnical.ok, `${route} con técnicas: ${JSON.stringify(withTechnical)}`);
		assert.equal(withTechnical.request.skill.args, "#14 --until pr", `${route} con técnicas para la spec`);
		// Sin aceptar: el veredicto se emitió pero el humano eligió `Confirmar <ruta>` → los argumentos de siempre.
		const plainConfirm = orchestrator.resolveWorkflowDispatch(resolution({ ...base, verdict: verdict(false) }));
		assert.ok(plainConfirm.ok, `${route} sin aceptar`);
		assert.equal(plainConfirm.request.skill.args, "#14", `${route} sin aceptar: sin flags`);
	}
	// Fallback: la ruta elegida no es la recomendada → argumentos de siempre aunque el veredicto esté aceptado.
	const fallback = orchestrator.resolveWorkflowDispatch(resolution({ code: "spec", recommendedClassification: "grill", fallbackClassification: "spec", recommendedRoute: "grill", selectedRoute: "spec", stage: "spec", verdict: verdict(true) }));
	assert.ok(fallback.ok);
	assert.equal(fallback.request.skill.args, "#14", "fallback: sin flags del veredicto");
	// Sin veredicto (null) nada cambia.
	const plain = orchestrator.resolveWorkflowDispatch(resolution({ code: "grill", recommendedClassification: "grill", recommendedRoute: "grill", selectedRoute: "grill", stage: "grill", verdict: null }));
	assert.ok(plain.ok);
	assert.equal(plain.request.skill.args, "#14");
	// `until: "spec"` dejó de existir: el protocolo lo rechaza y el despacho no arranca nada.
	const retiredUntil = orchestrator.resolveWorkflowDispatch(resolution({ code: "grill", recommendedClassification: "grill", recommendedRoute: "grill", selectedRoute: "grill", stage: "grill", verdict: verdict(true, { until: "spec", forSpec: [{ text: "usa el store existente", confidence: 40 }] }) }));
	assert.equal(retiredUntil.ok, false);
	if (!retiredUntil.ok) {
		assert.equal(retiredUntil.code, "invalid-resolution");
		assert.match(retiredUntil.message, /^\$\.verdict\.until /);
	}
	// Un veredicto en una ruta artifact-aware es inválido para el protocolo y el despacho lo rechaza.
	const invalid = orchestrator.resolveWorkflowDispatch(resolution({ code: "run-existing-spec", recommendedRoute: "run-existing-spec", selectedRoute: "run-existing-spec", stage: "run-existing-spec", mode: null, artifacts: [artifact("spec")], verdict: verdict(true) }));
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.equal(invalid.code, "invalid-resolution");
});

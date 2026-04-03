import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_PROJECT_ROOTS,
	DEFAULT_SHARED_PROJECT_ROOT,
	describeProjectRoots,
	getProjectRoots,
	getSharedOpenCodeBaseUrl,
	isSharedOpenCodeMode,
} from "../runtime-config.js";

test("getSharedOpenCodeBaseUrl normalizes explicit shared runtime URLs", () => {
	assert.equal(getSharedOpenCodeBaseUrl({ OPENCODE_BASE_URL: "http://opencode:62771///" }), "http://opencode:62771");
	assert.equal(getSharedOpenCodeBaseUrl({ OPENCODE_URL: "http://legacy:62771/" }), "http://legacy:62771");
	assert.equal(getSharedOpenCodeBaseUrl({}), null);
	assert.equal(isSharedOpenCodeMode({ OPENCODE_BASE_URL: "http://opencode:62771" }), true);
	assert.equal(isSharedOpenCodeMode({}), false);
});

test("getProjectRoots falls back to the legacy local defaults", () => {
	assert.deepEqual(getProjectRoots({}), DEFAULT_PROJECT_ROOTS);
});

test("getProjectRoots defaults to the docker workspace in shared mode", () => {
	const roots = getProjectRoots({
		OPENCODE_BASE_URL: "http://opencode:62771",
	});

	assert.deepEqual(roots, [
		{ scope: "workspace", label: "workspace", path: DEFAULT_SHARED_PROJECT_ROOT },
	]);
	assert.equal(describeProjectRoots(roots), "workspace");
});

test("getProjectRoots supports an explicit single project root override", () => {
	const roots = getProjectRoots({
		OPENCODE_PROJECT_ROOT: "/srv/repos",
	});

	assert.deepEqual(roots, [
		{ scope: "workspace", label: "repos", path: "/srv/repos" },
	]);
});

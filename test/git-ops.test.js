import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";

import {
	deriveRepoDirectoryName,
	getCurrentBranch,
	getGitRepoRoot,
	resolveCloneTargetPath,
	runGitOrThrow,
} from "../git-ops.js";

test("deriveRepoDirectoryName handles common git URLs", () => {
	assert.equal(deriveRepoDirectoryName("https://github.com/foo/bar.git"), "bar");
	assert.equal(deriveRepoDirectoryName("git@github.com:foo/bar.git"), "bar");
	assert.equal(deriveRepoDirectoryName("https://github.com/foo/bar"), "bar");
});

test("resolveCloneTargetPath keeps clones inside workspace root", () => {
	assert.equal(resolveCloneTargetPath("/workspace", "https://github.com/foo/bar.git"), path.resolve("/workspace/bar"));
	assert.equal(resolveCloneTargetPath("/workspace", "https://github.com/foo/bar.git", "custom-name"), path.resolve("/workspace/custom-name"));
	assert.throws(() => resolveCloneTargetPath("/workspace", "https://github.com/foo/bar.git", "../escape"), /Invalid repository directory name/);
});

test("git helpers detect repo root and branch", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-git-"));
	try {
		await runGitOrThrow(["init", "-b", "main"], { cwd: tempDir });
		const actualTempDir = await realpath(tempDir);
		const root = await getGitRepoRoot(tempDir);
		const branch = await getCurrentBranch(tempDir);
		assert.equal(root, actualTempDir);
		assert.equal(branch, "main");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

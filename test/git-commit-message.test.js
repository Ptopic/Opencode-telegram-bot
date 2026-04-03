import test from "node:test";
import assert from "node:assert/strict";

import {
	buildGitCommitMessagePrompt,
	extractCommitMessageFromReply,
} from "../git-commit-message.js";

test("buildGitCommitMessagePrompt includes core git context", () => {
	const prompt = buildGitCommitMessagePrompt({
		projectName: "demo-repo",
		branch: "feature/test",
		status: "M bot.js",
		diffStat: " bot.js | 10 ++++++----",
		recentCommits: ["Fix parser bug", "Add docker workflow"],
		diffPatch: "diff --git a/bot.js b/bot.js",
	});

	assert.match(prompt, /demo-repo/);
	assert.match(prompt, /feature\/test/);
	assert.match(prompt, /M bot\.js/);
	assert.match(prompt, /Fix parser bug/);
	assert.match(prompt, /diff --git/);
});

test("extractCommitMessageFromReply cleans common wrapper text", () => {
	assert.equal(extractCommitMessageFromReply("Commit message: Update git command handling"), "Update git command handling");
	assert.equal(extractCommitMessageFromReply("- Fix docker git workflow"), "Fix docker git workflow");
	assert.throws(() => extractCommitMessageFromReply("   \n   "), /valid commit message/);
});

export function buildGitCommitMessagePrompt(context) {
	const projectName = context?.projectName || "project";
	const branch = context?.branch || "unknown";
	const status = String(context?.status ?? "").trim() || "(no status output)";
	const diffStat = String(context?.diffStat ?? "").trim() || "(no diff stat)";
	const recentCommits = Array.isArray(context?.recentCommits) && context.recentCommits.length > 0
		? context.recentCommits.join("\n")
		: "(no recent commits)";
	const diffPatch = String(context?.diffPatch ?? "").trim() || "(no diff patch)";

	return [
		`Generate a git commit message for the repository \"${projectName}\" on branch \"${branch}\".`,
		"Return exactly one plain-text commit subject line.",
		"Requirements:",
		"- imperative mood",
		"- no quotes",
		"- no code fences",
		"- no bullet points",
		"- max 72 characters when possible",
		"- focus on why the change matters",
		"",
		"Git status:",
		status,
		"",
		"Diff stat:",
		diffStat,
		"",
		"Recent commit subjects:",
		recentCommits,
		"",
		"Patch excerpt:",
		diffPatch,
	].join("\n");
}

export function extractCommitMessageFromReply(reply) {
	const lines = String(reply ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const cleaned = line
			.replace(/^commit message\s*:\s*/i, "")
			.replace(/^[-*•]\s*/, "")
			.replace(/^['"`]+|['"`]+$/g, "")
			.replace(/\s+/g, " ")
			.trim();

		if (cleaned) {
			return cleaned.slice(0, 200);
		}
	}

	throw new Error("OpenCode did not return a valid commit message");
}

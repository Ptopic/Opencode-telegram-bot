import path from "node:path";

export const DEFAULT_PROJECT_ROOTS = [
	{ scope: "petar", path: "/Users/petartopic/Desktop/Petar", label: "Petar" },
	{ scope: "profico", path: "/Users/petartopic/Desktop/Profico", label: "Profico" },
];

export const DEFAULT_SHARED_PROJECT_ROOT = "/workspace";

function normalizeBaseUrl(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.replace(/\/+$/, "");
}

export function getSharedOpenCodeBaseUrl(env = process.env) {
	return normalizeBaseUrl(env.OPENCODE_BASE_URL || env.OPENCODE_URL);
}

export function isSharedOpenCodeMode(env = process.env) {
	return Boolean(getSharedOpenCodeBaseUrl(env));
}

export function getProjectRoots(env = process.env) {
	const singleRoot = typeof env.OPENCODE_PROJECT_ROOT === "string" ? env.OPENCODE_PROJECT_ROOT.trim() : "";
	if (singleRoot) {
		return [
			{
				scope: "workspace",
				path: singleRoot.replace(/\/+$/, ""),
				label: path.basename(singleRoot.replace(/\/+$/, "")) || "workspace",
			},
		];
	}

	if (isSharedOpenCodeMode(env)) {
		return [
			{
				scope: "workspace",
				path: DEFAULT_SHARED_PROJECT_ROOT,
				label: path.basename(DEFAULT_SHARED_PROJECT_ROOT),
			},
		];
	}

	return DEFAULT_PROJECT_ROOTS;
}

export function describeProjectRoots(roots) {
	return roots.map((root) => root.label).join(" or ");
}

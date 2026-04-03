const FILE_REF_EXTENSIONS = [
	"c",
	"cc",
	"conf",
	"cpp",
	"css",
	"csv",
	"env",
	"go",
	"h",
	"hpp",
	"html",
	"ini",
	"java",
	"js",
	"json",
	"jsx",
	"lock",
	"log",
	"lua",
	"md",
	"mjs",
	"py",
	"rb",
	"rs",
	"sh",
	"sql",
	"svg",
	"toml",
	"ts",
	"tsx",
	"txt",
	"xml",
	"yaml",
	"yml",
	"zsh",
];

export const FILE_REF_EXTENSIONS_WITH_TLD = new Set(FILE_REF_EXTENSIONS);

function isWordCharacter(char) {
	return /[A-Za-z0-9]/.test(char ?? "");
}

function normalizeFileRefCandidate(text) {
	return String(text ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function looksLikeFileReference(text) {
	const candidate = normalizeFileRefCandidate(text);
	if (!candidate || candidate.startsWith("//")) return false;
	const match = candidate.match(/\.([A-Za-z0-9]+)$/);
	if (!match) return false;
	return FILE_REF_EXTENSIONS_WITH_TLD.has(match[1].toLowerCase());
}

export function isAutoLinkedFileRef(href, label) {
	const normalizedHref = normalizeFileRefCandidate(href);
	const normalizedLabel = normalizeFileRefCandidate(label);
	return normalizedHref === normalizedLabel && looksLikeFileReference(normalizedLabel);
}

function mergeSpanCollections(target, source, offset = 0) {
	for (const item of source) {
		target.push({
			...item,
			start: item.start + offset,
			end: item.end + offset,
		});
	}
	return target;
}

function findClosingMarker(text, marker, startIndex) {
	let searchFrom = startIndex;
	while (searchFrom < text.length) {
		const foundAt = text.indexOf(marker, searchFrom);
		if (foundAt === -1) return -1;
		if (marker === "_" && isWordCharacter(text[foundAt - 1]) && isWordCharacter(text[foundAt + marker.length])) {
			searchFrom = foundAt + marker.length;
			continue;
		}
		return foundAt;
	}
	return -1;
}

function parseInlineMarkdown(text) {
	let plainText = "";
	const styles = [];
	const links = [];
	let index = 0;

	const appendParsed = (parsed, styleType = null) => {
		const start = plainText.length;
		plainText += parsed.text;
		mergeSpanCollections(styles, parsed.styles, start);
		mergeSpanCollections(links, parsed.links, start);
		if (styleType && plainText.length > start) {
			styles.push({ type: styleType, start, end: plainText.length });
		}
	};

	while (index < text.length) {
		if (text.startsWith("```", index)) {
			const closeIndex = text.indexOf("```", index + 3);
			if (closeIndex !== -1) {
				let contentStart = index + 3;
				const firstNewline = text.indexOf("\n", contentStart);
				if (firstNewline !== -1 && firstNewline < closeIndex) {
					contentStart = firstNewline + 1;
				}
				const codeText = text.slice(contentStart, closeIndex);
				appendParsed({ text: codeText, styles: [], links: [] }, "code_block");
				index = closeIndex + 3;
				continue;
			}
		}

		if (text[index] === "[") {
			const closeBracket = text.indexOf("]", index + 1);
			const openParen = closeBracket === -1 ? -1 : text.indexOf("(", closeBracket + 1);
			const closeParen = openParen === -1 ? -1 : text.indexOf(")", openParen + 1);
			if (closeBracket !== -1 && openParen === closeBracket + 1 && closeParen !== -1) {
				const label = text.slice(index + 1, closeBracket);
				const href = text.slice(openParen + 1, closeParen).trim();
				const parsedLabel = parseInlineMarkdown(label);
				const start = plainText.length;
				appendParsed(parsedLabel);
				if (href && plainText.length > start) {
					links.push({ start, end: plainText.length, href });
				}
				index = closeParen + 1;
				continue;
			}
		}

		const markers = [
			["**", "bold"],
			["~~", "strikethrough"],
			["||", "spoiler"],
			["`", "code"],
			["_", "italic"],
		];

		let matchedMarker = false;
		for (const [marker, styleType] of markers) {
			if (!text.startsWith(marker, index)) continue;
			const closeIndex = findClosingMarker(text, marker, index + marker.length);
			if (closeIndex === -1) continue;

			const inner = text.slice(index + marker.length, closeIndex);
			if (styleType === "code") {
				appendParsed({ text: inner, styles: [], links: [] }, styleType);
			} else {
				appendParsed(parseInlineMarkdown(inner), styleType);
			}

			index = closeIndex + marker.length;
			matchedMarker = true;
			break;
		}

		if (matchedMarker) continue;

		plainText += text[index];
		index += 1;
	}

	return { text: plainText, styles, links };
}

export function markdownToIR(markdown) {
	const source = String(markdown ?? "");
	const lines = source.split("\n");
	let text = "";
	const styles = [];
	const links = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const isBlockquote = line.startsWith("> ");
		const content = isBlockquote ? line.slice(2) : line;
		const parsed = parseInlineMarkdown(content);
		const start = text.length;
		text += parsed.text;
		mergeSpanCollections(styles, parsed.styles, start);
		mergeSpanCollections(links, parsed.links, start);
		if (isBlockquote && parsed.text.length > 0) {
			styles.push({ type: "blockquote", start, end: start + parsed.text.length });
		}
		if (index < lines.length - 1) {
			text += "\n";
		}
	}

	return { text, styles, links };
}

function sliceStyles(styles, start, end) {
	return styles.flatMap((span) => {
		if (span.end <= start || span.start >= end) return [];
		const nextStart = Math.max(span.start, start) - start;
		const nextEnd = Math.min(span.end, end) - start;
		if (nextEnd <= nextStart) return [];
		return [{ ...span, start: nextStart, end: nextEnd }];
	});
}

function sliceLinks(links, start, end) {
	return links.flatMap((span) => {
		if (span.end <= start || span.start >= end) return [];
		const nextStart = Math.max(span.start, start) - start;
		const nextEnd = Math.min(span.end, end) - start;
		if (nextEnd <= nextStart) return [];
		return [{ ...span, start: nextStart, end: nextEnd }];
	});
}

export function chunkMarkdownIR(ir, limit) {
	if (!ir?.text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	if (ir.text.length <= normalizedLimit) return [ir];

	const chunks = [];
	let cursor = 0;
	while (cursor < ir.text.length) {
		const maxEnd = Math.min(ir.text.length, cursor + normalizedLimit);
		let splitAt = maxEnd;
		if (maxEnd < ir.text.length) {
			const window = ir.text.slice(cursor, maxEnd);
			const newlineBreak = window.lastIndexOf("\n");
			if (newlineBreak >= 0) splitAt = cursor + newlineBreak + 1;
			else {
				const spaceBreak = window.lastIndexOf(" ");
				if (spaceBreak > 0) splitAt = cursor + spaceBreak + 1;
			}
		}
		if (splitAt <= cursor) splitAt = maxEnd;
		chunks.push({
			text: ir.text.slice(cursor, splitAt),
			styles: sliceStyles(ir.styles ?? [], cursor, splitAt),
			links: sliceLinks(ir.links ?? [], cursor, splitAt),
		});
		cursor = splitAt;
	}

	return chunks;
}

const STYLE_PRIORITY = {
	blockquote: 10,
	spoiler: 20,
	bold: 30,
	italic: 40,
	strikethrough: 50,
	code_block: 60,
	code: 70,
	link: 80,
};

export function renderMarkdownWithMarkers(ir, options) {
	const text = String(ir?.text ?? "");
	const escapeText = typeof options?.escapeText === "function" ? options.escapeText : (value) => value;
	const styleMarkers = options?.styleMarkers ?? {};
	const buildLink = typeof options?.buildLink === "function" ? options.buildLink : null;
	const markers = [];

	for (const span of ir?.styles ?? []) {
		const marker = styleMarkers[span.type];
		if (!marker || span.end <= span.start) continue;
		markers.push({
			kind: span.type,
			start: span.start,
			end: span.end,
			open: marker.open,
			close: marker.close,
			priority: STYLE_PRIORITY[span.type] ?? 100,
		});
	}

	if (buildLink) {
		for (const link of ir?.links ?? []) {
			const marker = buildLink(link, text);
			if (!marker || link.end <= link.start) continue;
			markers.push({
				kind: "link",
				start: link.start,
				end: link.end,
				open: marker.open,
				close: marker.close,
				priority: STYLE_PRIORITY.link,
			});
		}
	}

	let result = "";
	for (let index = 0; index <= text.length; index += 1) {
		const closing = markers
			.filter((marker) => marker.end === index)
			.sort((left, right) => right.start - left.start || right.priority - left.priority);
		for (const marker of closing) {
			result += marker.close;
		}

		const opening = markers
			.filter((marker) => marker.start === index)
			.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.priority - right.priority);
		for (const marker of opening) {
			result += marker.open;
		}

		if (index < text.length) {
			result += escapeText(text[index]);
		}
	}

	return result;
}

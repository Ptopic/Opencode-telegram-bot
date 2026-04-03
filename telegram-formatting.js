import {
    FILE_REF_EXTENSIONS_WITH_TLD,
    chunkMarkdownIR,
    isAutoLinkedFileRef,
    markdownToIR,
    renderMarkdownWithMarkers,
} from "./telegram-text-runtime.js";

const TELEGRAM_SELF_CLOSING_HTML_TAGS = new Set(["br"]);
const AUTO_LINKED_ANCHOR_PATTERN = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;

let fileReferencePattern;
let orphanedTldPattern;

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function escapeHtmlAttr(text) {
    return escapeHtml(text).replaceAll('"', "&quot;");
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTelegramLink(link, text) {
    const href = String(link?.href ?? "").trim();
    if (!href) return null;
    if (link.start === link.end) return null;
    if (isAutoLinkedFileRef(href, text.slice(link.start, link.end))) return null;
    return {
        start: link.start,
        end: link.end,
        open: `<a href="${escapeHtmlAttr(href)}">`,
        close: "</a>",
    };
}

function renderTelegramHtml(ir) {
    return renderMarkdownWithMarkers(ir, {
        styleMarkers: {
            bold: { open: "<b>", close: "</b>" },
            italic: { open: "<i>", close: "</i>" },
            strikethrough: { open: "<s>", close: "</s>" },
            code: { open: "<code>", close: "</code>" },
            code_block: { open: "<pre><code>", close: "</code></pre>" },
            spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
            blockquote: { open: "<blockquote>", close: "</blockquote>" },
        },
        escapeText: escapeHtml,
        buildLink: buildTelegramLink,
    });
}

function getFileReferencePattern() {
    if (fileReferencePattern) return fileReferencePattern;
    const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
    fileReferencePattern = new RegExp(
        `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${fileExtensionsPattern}))(?=$|[^a-zA-Z0-9_\\-/])`,
        "gi",
    );
    return fileReferencePattern;
}

function getOrphanedTldPattern() {
    if (orphanedTldPattern) return orphanedTldPattern;
    const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
    orphanedTldPattern = new RegExp(`([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${fileExtensionsPattern}))(?=[^a-zA-Z0-9/]|$)`, "g");
    return orphanedTldPattern;
}

function wrapStandaloneFileRef(match, prefix, filename) {
    if (filename.startsWith("//")) return match;
    if (/https?:\/\/$/i.test(prefix)) return match;
    return `${prefix}<code>${escapeHtml(filename)}</code>`;
}

function wrapSegmentFileRefs(text, codeDepth, preDepth, anchorDepth) {
    if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) return text;
    return text
        .replace(getFileReferencePattern(), wrapStandaloneFileRef)
        .replace(getOrphanedTldPattern(), (match, prefix, tld) => (prefix === ">" ? match : `${prefix}<code>${escapeHtml(tld)}</code>`));
}

export function wrapFileReferencesInHtml(html) {
    AUTO_LINKED_ANCHOR_PATTERN.lastIndex = 0;
    const deLinkified = String(html ?? "").replace(AUTO_LINKED_ANCHOR_PATTERN, (_match, label) => {
        if (!isAutoLinkedFileRef(`http://${label}`, label)) return _match;
        return `<code>${escapeHtml(label)}</code>`;
    });

    let codeDepth = 0;
    let preDepth = 0;
    let anchorDepth = 0;
    let result = "";
    let lastIndex = 0;

    HTML_TAG_PATTERN.lastIndex = 0;
    let match = HTML_TAG_PATTERN.exec(deLinkified);
    while (match) {
        const tagStart = match.index;
        const tagEnd = HTML_TAG_PATTERN.lastIndex;
        const isClosing = match[1] === "</";
        const tagName = match[2].toLowerCase();

        const textBefore = deLinkified.slice(lastIndex, tagStart);
        result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);

        if (tagName === "code") codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
        else if (tagName === "pre") preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
        else if (tagName === "a") anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;

        result += deLinkified.slice(tagStart, tagEnd);
        lastIndex = tagEnd;
        match = HTML_TAG_PATTERN.exec(deLinkified);
    }

    const remainingText = deLinkified.slice(lastIndex);
    result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);
    return result;
}

export function markdownToTelegramHtml(markdown, options = {}) {
    const html = renderTelegramHtml(markdownToIR(String(markdown ?? ""), {
        linkify: true,
        enableSpoilers: true,
        headingStyle: "none",
        blockquotePrefix: "",
        tableMode: options.tableMode,
    }));

    if (options.wrapFileRefs !== false) return wrapFileReferencesInHtml(html);
    return html;
}

function buildTelegramHtmlOpenPrefix(tags) {
    return tags.map((tag) => tag.openTag).join("");
}

function buildTelegramHtmlCloseSuffix(tags) {
    return tags.toReversed().map((tag) => tag.closeTag).join("");
}

function buildTelegramHtmlCloseSuffixLength(tags) {
    return tags.reduce((total, tag) => total + tag.closeTag.length, 0);
}

function findTelegramHtmlEntityEnd(text, start) {
    if (text[start] !== "&") return -1;
    let index = start + 1;
    if (index >= text.length) return -1;

    if (text[index] === "#") {
        index += 1;
        if (index >= text.length) return -1;
        if (text[index] === "x" || text[index] === "X") {
            index += 1;
            const hexStart = index;
            while (/[0-9A-Fa-f]/.test(text[index] ?? "")) index += 1;
            if (index === hexStart) return -1;
        } else {
            const digitStart = index;
            while (/[0-9]/.test(text[index] ?? "")) index += 1;
            if (index === digitStart) return -1;
        }
    } else {
        const nameStart = index;
        while (/[A-Za-z0-9]/.test(text[index] ?? "")) index += 1;
        if (index === nameStart) return -1;
    }

    return text[index] === ";" ? index : -1;
}

function findTelegramHtmlSafeSplitIndex(text, maxLength) {
    if (text.length <= maxLength) return text.length;
    const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
    const lastAmpersand = text.lastIndexOf("&", normalizedMaxLength - 1);
    if (lastAmpersand === -1) return normalizedMaxLength;
    if (lastAmpersand < text.lastIndexOf(";", normalizedMaxLength - 1)) return normalizedMaxLength;
    const entityEnd = findTelegramHtmlEntityEnd(text, lastAmpersand);
    if (entityEnd === -1 || entityEnd < normalizedMaxLength) return normalizedMaxLength;
    return lastAmpersand;
}

function popTelegramHtmlTag(tags, name) {
    for (let index = tags.length - 1; index >= 0; index -= 1) {
        if (tags[index]?.name === name) {
            tags.splice(index, 1);
            return;
        }
    }
}

export function splitTelegramHtmlChunks(html, limit) {
    if (!html) return [];
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (html.length <= normalizedLimit) return [html];

    const chunks = [];
    const openTags = [];
    let current = "";
    let chunkHasPayload = false;

    const resetCurrent = () => {
        current = buildTelegramHtmlOpenPrefix(openTags);
        chunkHasPayload = false;
    };

    const flushCurrent = () => {
        if (!chunkHasPayload) return;
        chunks.push(`${current}${buildTelegramHtmlCloseSuffix(openTags)}`);
        resetCurrent();
    };

    const appendText = (segment) => {
        let remaining = segment;
        while (remaining.length > 0) {
            const available = normalizedLimit - current.length - buildTelegramHtmlCloseSuffixLength(openTags);
            if (available <= 0) {
                if (!chunkHasPayload) throw new Error(`Telegram HTML chunk limit exceeded by tag overhead (limit=${normalizedLimit})`);
                flushCurrent();
                continue;
            }

            if (remaining.length <= available) {
                current += remaining;
                chunkHasPayload = true;
                break;
            }

            const splitAt = findTelegramHtmlSafeSplitIndex(remaining, available);
            if (splitAt <= 0) {
                if (!chunkHasPayload) throw new Error(`Telegram HTML chunk limit exceeded by leading entity (limit=${normalizedLimit})`);
                flushCurrent();
                continue;
            }

            current += remaining.slice(0, splitAt);
            chunkHasPayload = true;
            remaining = remaining.slice(splitAt);
            flushCurrent();
        }
    };

    resetCurrent();
    HTML_TAG_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match = HTML_TAG_PATTERN.exec(html);

    while (match) {
        const tagStart = match.index;
        const tagEnd = HTML_TAG_PATTERN.lastIndex;
        appendText(html.slice(lastIndex, tagStart));

        const rawTag = match[0];
        const isClosing = match[1] === "</";
        const tagName = match[2].toLowerCase();
        const isSelfClosing = !isClosing && (TELEGRAM_SELF_CLOSING_HTML_TAGS.has(tagName) || rawTag.trimEnd().endsWith("/>"));

        if (!isClosing) {
            const nextCloseLength = isSelfClosing ? 0 : `</${tagName}>`.length;
            if (chunkHasPayload && current.length + rawTag.length + buildTelegramHtmlCloseSuffixLength(openTags) + nextCloseLength > normalizedLimit) {
                flushCurrent();
            }
        }

        current += rawTag;
        if (isSelfClosing) chunkHasPayload = true;

        if (isClosing) popTelegramHtmlTag(openTags, tagName);
        else if (!isSelfClosing) {
            openTags.push({ name: tagName, openTag: rawTag, closeTag: `</${tagName}>` });
        }

        lastIndex = tagEnd;
        match = HTML_TAG_PATTERN.exec(html);
    }

    appendText(html.slice(lastIndex));
    flushCurrent();
    return chunks.length > 0 ? chunks : [html];
}

function sliceStyleSpans(styles, start, end) {
    return styles.flatMap((span) => {
        if (span.end <= start || span.start >= end) return [];
        const nextStart = Math.max(span.start, start) - start;
        const nextEnd = Math.min(span.end, end) - start;
        if (nextEnd <= nextStart) return [];
        return [{ ...span, start: nextStart, end: nextEnd }];
    });
}

function sliceLinkSpans(links, start, end) {
    return links.flatMap((link) => {
        if (link.end <= start || link.start >= end) return [];
        const nextStart = Math.max(link.start, start) - start;
        const nextEnd = Math.min(link.end, end) - start;
        if (nextEnd <= nextStart) return [];
        return [{ ...link, start: nextStart, end: nextEnd }];
    });
}

function splitMarkdownIRPreserveWhitespace(ir, limit) {
    if (!ir.text) return [];
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

        chunks.push({
            text: ir.text.slice(cursor, splitAt),
            styles: sliceStyleSpans(ir.styles, cursor, splitAt),
            links: sliceLinkSpans(ir.links, cursor, splitAt),
        });
        cursor = splitAt;
    }

    return chunks;
}

function renderTelegramChunkHtml(ir) {
    return wrapFileReferencesInHtml(renderTelegramHtml(ir));
}

function splitTelegramChunkByHtmlLimit(chunk, htmlLimit, renderedHtmlLength) {
    const currentTextLength = chunk.text.length;
    if (currentTextLength <= 1) return [chunk];
    const proportionalLimit = Math.floor(currentTextLength * htmlLimit / Math.max(renderedHtmlLength, 1));
    const candidateLimit = Math.min(currentTextLength - 1, proportionalLimit);
    const split = splitMarkdownIRPreserveWhitespace(
        chunk,
        Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : Math.max(1, Math.floor(currentTextLength / 2)),
    );
    if (split.length > 1) return split;
    return splitMarkdownIRPreserveWhitespace(chunk, Math.max(1, Math.floor(currentTextLength / 2)));
}

function renderTelegramChunksWithinHtmlLimit(ir, limit) {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const pending = chunkMarkdownIR(ir, normalizedLimit);
    const finalized = [];

    while (pending.length > 0) {
        const chunk = pending.shift();
        if (!chunk) continue;

        const html = renderTelegramChunkHtml(chunk);
        if (html.length <= normalizedLimit || chunk.text.length <= 1) {
            finalized.push(chunk);
            continue;
        }

        const split = splitTelegramChunkByHtmlLimit(chunk, normalizedLimit, html.length);
        if (split.length <= 1) {
            finalized.push(chunk);
            continue;
        }

        pending.unshift(...split);
    }

    return finalized.map((chunk) => ({
        html: renderTelegramChunkHtml(chunk),
        text: chunk.text,
    }));
}

export function markdownToTelegramChunks(markdown, limit, options = {}) {
    const ir = markdownToIR(String(markdown ?? ""), {
        linkify: true,
        enableSpoilers: true,
        headingStyle: "none",
        blockquotePrefix: "",
        tableMode: options.tableMode,
    });

    return renderTelegramChunksWithinHtmlLimit(ir, limit);
}

export function normalizeTelegramMessageVariants(variants) {
    const plainText = typeof variants?.plainText === "string" ? variants.plainText : "";
    const htmlText = typeof variants?.htmlText === "string" && variants.htmlText.trim() !== ""
        ? variants.htmlText
        : null;
    return { plainText, htmlText };
}

export function buildTelegramMessageVariants(input) {
    if (typeof input === "string") {
        return normalizeTelegramMessageVariants({
            plainText: input,
            htmlText: markdownToTelegramHtml(input),
        });
    }

    if (!input || typeof input !== "object") {
        const text = String(input ?? "");
        return normalizeTelegramMessageVariants({
            plainText: text,
            htmlText: markdownToTelegramHtml(text),
        });
    }

    const plainText = typeof input.plainText === "string" ? input.plainText : "";
    const htmlText = typeof input.htmlText === "string" ? input.htmlText : markdownToTelegramHtml(plainText);
    return normalizeTelegramMessageVariants({ plainText, htmlText });
}

export function splitTelegramMessageContent(message, maxLength) {
    const variants = buildTelegramMessageVariants(message);
    const normalizedLimit = Math.max(1, Math.floor(maxLength));
    if (!variants.plainText.trim()) return [];

    const chunks = markdownToTelegramChunks(variants.plainText, normalizedLimit);
    return chunks.map((chunk) => normalizeTelegramMessageVariants({
        plainText: chunk.text,
        htmlText: chunk.html,
    }));
}

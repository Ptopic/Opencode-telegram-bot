import test from "node:test";
import assert from "node:assert/strict";

import {
    buildTelegramMessageVariants,
    splitTelegramMessageContent,
} from "../telegram-formatting.js";
import {
    TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE,
    appendTelegramUpstreamFormattingGuide,
} from "../telegram-upstream-prompt.js";

test("buildTelegramMessageVariants renders markdown-like styles and wraps file refs", () => {
    const variants = buildTelegramMessageVariants(
        "**Bold** _italic_ ~~strike~~ `inline` [site](https://example.com) and README.md",
    );

    assert.equal(variants.plainText.includes("README.md"), true);
    assert.equal(typeof variants.htmlText, "string");
    assert.match(variants.htmlText, /<b>Bold<\/b>/);
    assert.match(variants.htmlText, /<i>italic<\/i>/);
    assert.match(variants.htmlText, /<s>strike<\/s>/);
    assert.match(variants.htmlText, /<code>inline<\/code>/);
    assert.match(variants.htmlText, /<a href="https:\/\/example\.com">site<\/a>/);
    assert.match(variants.htmlText, /<code>README\.md<\/code>/);
});

test("splitTelegramMessageContent returns html/plain chunk pairs within limit", () => {
    const longText = "Paragraph one with **formatting** and file src/index.ts.\n\n".repeat(120);
    const chunks = splitTelegramMessageContent(longText, 900);

    assert.equal(chunks.length > 1, true);
    for (const chunk of chunks) {
        assert.equal(typeof chunk.plainText, "string");
        assert.equal(typeof chunk.htmlText, "string");
        assert.equal(chunk.plainText.length <= 900, true);
        assert.equal(chunk.htmlText.length <= 900, true);
    }
});

test("appendTelegramUpstreamFormattingGuide appends once and preserves exact line", () => {
    const shaped = appendTelegramUpstreamFormattingGuide("Please summarize this.");
    assert.equal(shaped.includes(TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE), true);

    const shapedTwice = appendTelegramUpstreamFormattingGuide(shaped);
    const occurrences = shapedTwice.split(TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE).length - 1;
    assert.equal(occurrences, 1);
});

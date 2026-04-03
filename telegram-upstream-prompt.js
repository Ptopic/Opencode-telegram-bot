export const TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE = "Avoid Markdown tables. Don't type literal \\n sequences; use real line breaks sparingly.";

export function appendTelegramUpstreamFormattingGuide(text) {
    const baseText = typeof text === "string" ? text.trim() : "";
    if (!baseText) return TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE;
    if (baseText.includes(TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE)) return baseText;
    return `${baseText}\n\nFormatting guidance: ${TELEGRAM_UPSTREAM_FORMATTING_GUIDE_LINE}`;
}

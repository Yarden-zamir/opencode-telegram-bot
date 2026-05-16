import { describe, expect, it } from "vitest";
import { formatTopicTitle } from "../../src/topic/title-format.js";

describe("topic/title-format", () => {
  it("trims titles and falls back when the title is empty", () => {
    expect(formatTopicTitle("  Build scoped topics  ")).toBe("Build scoped topics");
    expect(formatTopicTitle("   ", "Fallback title")).toBe("Fallback title");
    expect(formatTopicTitle("   ")).toBe("Session");
  });

  it("truncates topic titles to Telegram's 128 character limit", () => {
    const title = `${"a".repeat(130)}   `;

    expect(formatTopicTitle(title)).toBe(`${"a".repeat(125)}...`);
    expect(formatTopicTitle(title)).toHaveLength(128);
  });
});

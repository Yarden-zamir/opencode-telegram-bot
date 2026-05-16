import { describe, expect, it } from "vitest";
import { classifyPromptSubmitError } from "../../src/opencode/prompt-submit-error.js";

describe("opencode/prompt-submit-error", () => {
  it("classifies 409 responses as busy", () => {
    expect(
      classifyPromptSubmitError({
        data: {
          statusCode: 409,
          message: "Session is busy",
        },
      }),
    ).toBe("busy");
  });

  it("classifies not-found style messages as missing session", () => {
    expect(
      classifyPromptSubmitError({
        data: {
          message: "Session not found",
        },
      }),
    ).toBe("session_not_found");
  });

  it("classifies unknown errors as other", () => {
    expect(classifyPromptSubmitError(new Error("socket hang up"))).toBe("other");
  });
});

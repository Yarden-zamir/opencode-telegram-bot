import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSettingsForTests } from "../../src/settings/manager.js";
import { getCurrentSession, setCurrentSession } from "../../src/session/manager.js";

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("session/manager", () => {
  beforeEach(() => {
    __resetSettingsForTests();
  });

  it("prevents rebinding an existing topic scope to a different session", () => {
    setCurrentSession({ id: "session-1", title: "One", directory: "/repo" }, "-100123:42");

    setCurrentSession({ id: "session-2", title: "Two", directory: "/repo" }, "-100123:42");

    expect(getCurrentSession("-100123:42")).toEqual({
      id: "session-1",
      title: "One",
      directory: "/repo",
    });
  });
});

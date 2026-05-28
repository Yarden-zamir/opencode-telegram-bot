import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  resolveLocalOpencodeTargetMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
    },
  },
}));

vi.mock("../../src/config.js", () => ({
  config: mocked.config,
}));

vi.mock("../../src/opencode/process.js", () => ({
  resolveLocalOpencodeTarget: mocked.resolveLocalOpencodeTargetMock,
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    warn: mocked.loggerWarnMock,
  },
}));

import { checkLocalOpencodeServerBindAddress } from "../../src/opencode/binding-check.js";

describe("opencode/binding-check", () => {
  beforeEach(() => {
    mocked.resolveLocalOpencodeTargetMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerWarnMock.mockReset();

    mocked.config.opencode.apiUrl = "http://localhost:4096";
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue({ host: "localhost", port: 4096 });
  });

  it("skips remote OpenCode URLs", async () => {
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue(null);

    await expect(checkLocalOpencodeServerBindAddress("startup")).resolves.toBeNull();
  });

  it("passes when the local server is configured for all interfaces", async () => {
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue({ host: "0.0.0.0", port: 4096 });

    await expect(checkLocalOpencodeServerBindAddress("startup")).resolves.toBe(true);

    expect(mocked.loggerDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("OpenCode server is configured for all interfaces"),
    );
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("warns when the local server is configured for loopback", async () => {
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue({ host: "127.0.0.1", port: 4096 });

    await expect(checkLocalOpencodeServerBindAddress("startup")).resolves.toBe(false);

    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("not 0.0.0.0"),
    );
  });
});

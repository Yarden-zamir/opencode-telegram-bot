import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handlePhotoMessage, type PhotoHandlerDeps } from "../../../src/bot/handlers/photo.js";
import { t } from "../../../src/i18n/index.js";

function createPhotoContext(overrides: Partial<Context["message"]> = {}): {
  ctx: Context;
  replyMock: ReturnType<typeof vi.fn>;
} {
  const replyMock = vi.fn().mockResolvedValue({ message_id: 101 });

  const ctx = {
    chat: { id: 777 },
    message: {
      photo: [
        {
          file_id: "small-photo-id",
          file_unique_id: "small-unique-id",
          width: 320,
          height: 240,
          file_size: 1024,
        },
        {
          file_id: "large-photo-id",
          file_unique_id: "large-unique-id",
          width: 1280,
          height: 960,
          file_size: 4096,
        },
      ],
      caption: "Describe and save this image",
      ...overrides,
    },
    reply: replyMock,
    api: {
      getFile: vi.fn().mockResolvedValue({
        file_path: "photos/file.jpg",
        file_size: 4096,
      }),
    },
  } as unknown as Context;

  return { ctx, replyMock };
}

function createPhotoDeps(overrides: Partial<PhotoHandlerDeps> = {}): {
  deps: PhotoHandlerDeps;
  processPromptMock: ReturnType<typeof vi.fn>;
  downloadMock: ReturnType<typeof vi.fn>;
  saveAttachmentMock: ReturnType<typeof vi.fn>;
  getCapabilitiesMock: ReturnType<typeof vi.fn>;
} {
  const processPromptMock = vi.fn().mockResolvedValue(true);
  const downloadMock = vi.fn().mockResolvedValue({
    buffer: Buffer.from("image bytes"),
    filePath: "photos/file.jpg",
  });
  const saveAttachmentMock = vi.fn().mockResolvedValue({
    filePath: "/tmp/opencode-telegram-bot/attachments/777/photo.jpg",
  });
  const getCapabilitiesMock = vi.fn().mockResolvedValue({
    input: { image: true },
  });

  const deps: PhotoHandlerDeps = {
    bot: {} as PhotoHandlerDeps["bot"],
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
    downloadFile: downloadMock,
    getModelCapabilities: getCapabilitiesMock,
    getStoredModel: vi.fn().mockReturnValue({
      providerID: "test-provider",
      modelID: "test-model",
    }),
    processPrompt: processPromptMock,
    saveAttachment: saveAttachmentMock,
    ...overrides,
  };

  return { deps, processPromptMock, downloadMock, saveAttachmentMock, getCapabilitiesMock };
}

describe("bot/handlers/photo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("saves the largest photo and forwards its local path with the image part", async () => {
    const { ctx, replyMock } = createPhotoContext();
    const { deps, processPromptMock, downloadMock, saveAttachmentMock } = createPhotoDeps();

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_downloading"));
    expect(downloadMock).toHaveBeenCalledWith(ctx.api, "large-photo-id");
    expect(saveAttachmentMock).toHaveBeenCalledWith(Buffer.from("image bytes"), {
      chatId: 777,
      fileUniqueId: "large-unique-id",
    });
    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("/tmp/opencode-telegram-bot/attachments/777/photo.jpg"),
      deps,
      [
        expect.objectContaining({
          type: "file",
          mime: "image/jpeg",
          filename: "photo.jpg",
          url: "data:image/jpeg;base64,aW1hZ2UgYnl0ZXM=",
        }),
      ],
    );
    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("Describe and save this image"),
      deps,
      expect.any(Array),
    );
  });

  it("adds a default prompt when the photo has no caption", async () => {
    const { ctx } = createPhotoContext({ caption: "" });
    const { deps, processPromptMock } = createPhotoDeps();

    await handlePhotoMessage(ctx, deps);

    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("See attached image."),
      deps,
      expect.any(Array),
    );
  });

  it("forwards the saved path without an image part when the model does not support image input", async () => {
    const { ctx, replyMock } = createPhotoContext();
    const { deps, processPromptMock, downloadMock, saveAttachmentMock } = createPhotoDeps({
      getModelCapabilities: vi.fn().mockResolvedValue({
        input: { image: false },
      }),
    });

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_model_no_image"));
    expect(downloadMock).toHaveBeenCalledWith(ctx.api, "large-photo-id");
    expect(saveAttachmentMock).toHaveBeenCalled();
    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("/tmp/opencode-telegram-bot/attachments/777/photo.jpg"),
      deps,
      [],
    );
  });

  it("forwards the saved path without a caption when the model does not support image input", async () => {
    const { ctx, replyMock } = createPhotoContext({ caption: "" });
    const { deps, processPromptMock } = createPhotoDeps({
      getModelCapabilities: vi.fn().mockResolvedValue({
        input: { image: false },
      }),
    });

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_model_no_image"));
    expect(processPromptMock).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("See attached image."),
      deps,
      [],
    );
  });

  it("shows a photo error when saving fails", async () => {
    const { ctx, replyMock } = createPhotoContext();
    const { deps, processPromptMock } = createPhotoDeps({
      saveAttachment: vi.fn().mockRejectedValue(new Error("write failed")),
    });

    await handlePhotoMessage(ctx, deps);

    expect(replyMock).toHaveBeenCalledWith(t("bot.photo_download_error"));
    expect(processPromptMock).not.toHaveBeenCalled();
  });
});

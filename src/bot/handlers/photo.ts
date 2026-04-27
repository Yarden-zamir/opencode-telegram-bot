import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Context } from "grammy";
import type { FilePartInput, Model } from "@opencode-ai/sdk/v2";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { downloadTelegramFile, toDataUri } from "../utils/file-download.js";
import { getModelCapabilities, supportsInput } from "../../model/capabilities.js";
import { getStoredModel } from "../../model/manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

const PHOTO_ATTACHMENT_DIR = path.join(os.tmpdir(), "opencode-telegram-bot", "attachments");
const PHOTO_MIME_TYPE = "image/jpeg";

export interface SavedAttachment {
  filePath: string;
}

export interface PhotoHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (
    api: Context["api"],
    fileId: string,
  ) => Promise<{ buffer: Buffer; filePath: string }>;
  getModelCapabilities?: (
    providerId: string,
    modelId: string,
  ) => Promise<Model["capabilities"] | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (
    ctx: Context,
    text: string,
    deps: ProcessPromptDeps,
    fileParts?: FilePartInput[],
  ) => Promise<boolean>;
  saveAttachment?: (
    buffer: Buffer,
    options: { chatId: number; fileUniqueId?: string },
  ) => Promise<SavedAttachment>;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function savePhotoAttachment(
  buffer: Buffer,
  options: { chatId: number; fileUniqueId?: string },
): Promise<SavedAttachment> {
  const chatDir = path.join(PHOTO_ATTACHMENT_DIR, sanitizePathSegment(String(options.chatId)));
  const uniqueSuffix = options.fileUniqueId
    ? `-${sanitizePathSegment(options.fileUniqueId)}`
    : "";
  const filename = `photo-${Date.now()}${uniqueSuffix}.jpg`;
  const filePath = path.join(chatDir, filename);

  await fs.mkdir(chatDir, { recursive: true });
  await fs.writeFile(filePath, buffer);

  return { filePath };
}

function buildPromptWithAttachmentPath(caption: string, attachmentPath: string): string {
  const trimmedCaption = caption.trim();
  const userPrompt = trimmedCaption.length > 0 ? trimmedCaption : "See attached image.";

  return `Attached image was saved locally at:\n${attachmentPath}\n\n${userPrompt}`;
}

export async function handlePhotoMessage(ctx: Context, deps: PhotoHandlerDeps): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    return;
  }

  const downloadFile = deps.downloadFile ?? downloadTelegramFile;
  const getCapabilities = deps.getModelCapabilities ?? getModelCapabilities;
  const getStored = deps.getStoredModel ?? getStoredModel;
  const processPrompt = deps.processPrompt ?? processUserPrompt;
  const saveAttachment = deps.saveAttachment ?? savePhotoAttachment;
  const caption = ctx.message.caption || "";

  try {
    const largestPhoto = photos[photos.length - 1];
    const storedModel = getStored();
    const capabilities = await getCapabilities(storedModel.providerID, storedModel.modelID);
    const modelSupportsImage = supportsInput(capabilities, "image");

    if (!modelSupportsImage) {
      logger.warn(
        `[Bot] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`,
      );
      await ctx.reply(t("bot.photo_model_no_image"));
    }

    await ctx.reply(t("bot.photo_downloading"));
    const downloadedFile = await downloadFile(ctx.api, largestPhoto.file_id);
    const savedAttachment = await saveAttachment(downloadedFile.buffer, {
      chatId: ctx.chat!.id,
      fileUniqueId: largestPhoto.file_unique_id,
    });
    const promptText = buildPromptWithAttachmentPath(caption, savedAttachment.filePath);
    const fileParts: FilePartInput[] = [];

    if (modelSupportsImage) {
      const dataUri = toDataUri(downloadedFile.buffer, PHOTO_MIME_TYPE);

      fileParts.push({
        type: "file",
        mime: PHOTO_MIME_TYPE,
        filename: path.basename(savedAttachment.filePath),
        url: dataUri,
      });
    }

    logger.info(
      `[Bot] Sending photo (${downloadedFile.buffer.length} bytes) with prompt; savedPath=${savedAttachment.filePath}`,
    );

    await processPrompt(ctx, promptText, deps, fileParts);
  } catch (err) {
    logger.error("[Bot] Error handling photo message:", err);
    await ctx.reply(t("bot.photo_download_error"));
  }
}

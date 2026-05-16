export const CHAT_TYPE = {
  PRIVATE: "private",
  GROUP: "group",
  SUPERGROUP: "supergroup",
  CHANNEL: "channel",
} as const;

export const TELEGRAM_CHAT_FIELD = {
  IS_FORUM: "is_forum",
  USERNAME: "username",
} as const;

export const GENERAL_TOPIC = {
  NAME: "🎛️ Session Control",
} as const;

export const TELEGRAM_ERROR_MARKER = {
  NOT_ENOUGH_RIGHTS_CREATE_TOPIC: "not enough rights to create a topic",
} as const;

export const TELEGRAM_URL = {
  BASE: "https://t.me",
  PRIVATE_SUPERGROUP_PATH: "/c",
} as const;

export const TELEGRAM_CHAT_ID_PREFIX = {
  PRIVATE_SUPERGROUP: "100",
} as const;

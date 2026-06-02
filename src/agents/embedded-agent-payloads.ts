export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  spokenText?: string;
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  isReasoning?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};

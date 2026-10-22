/**
 * The window event that hands a pre-composed message to the chat (a node's
 * Enhance, the command palette's agent query). The chat panel is a deferred
 * chunk; its wrapper in components/DeferredPanels.tsx holds a send that comes
 * before it (lib/heldIntents.ts).
 */
export const CHAT_SEND_EVENT = 'nebula:chat-send';

export interface ChatSendDetail {
  message?: string;
  /** The node whose Enhance sent it, for the reply's Apply button. */
  sourceNodeId?: string;
}

// Trimmed chat feed item (server shape: drone-coordinator/src/chat-feed.ts).
export interface ChatFeedItem {
  id: string;
  type: string;
  name?: string;
  correlationId: string | null;
  createdAt: number;
  preview: string;
  hasFull: boolean;
}

export interface ChatFeedResponse {
  items: ChatFeedItem[];
  hasMore: boolean;
  oldestCursor: string | null;
}

export interface EventContent {
  id: string;
  type: string;
  payload: string;
}

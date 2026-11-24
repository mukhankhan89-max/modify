export type MessageRole = 'user' | 'assistant';

export type GeminiModelId = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  updatedAt?: number;
  isError?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  isAutoTitled?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export type ThemeMode = 'light' | 'dark';

export interface ChatError {
  message: string;
  code?: string;
  retryable?: boolean;
}

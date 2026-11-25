export type MessageRole = 'user' | 'assistant';

export type GeminiModelId = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';

export type SpeechLanguage = 'en-US' | 'ur-PK';

export type SpeechRate = 0.75 | 1 | 1.25 | 1.5;

export type ImageStylePreset =
  | 'auto'
  | 'photorealistic'
  | 'cinematic'
  | 'anime'
  | 'cartoon'
  | '3d-render'
  | 'product'
  | 'fashion'
  | 'digital-art'
  | 'logo'
  | 'wallpaper';

export type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3';

export interface GeneratedImageData {
  id: string;
  prompt: string;
  style: ImageStylePreset;
  aspectRatio: ImageAspectRatio;
  width: number;
  height: number;
  provider?: string;
  model?: string;
  status: 'generating' | 'ready' | 'error';
  imageId?: string;
  remoteUrl?: string;
  error?: string;
  durationMs?: number;
  createdAt: number;
}

export interface ImageAttachmentRef {
  id: string;
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  size: number;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}

export interface PreparedImageAttachment extends ImageAttachmentRef {
  base64: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: ImageAttachmentRef[];
  generatedImage?: GeneratedImageData;
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

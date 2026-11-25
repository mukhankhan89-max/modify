import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  ChatError,
  ChatMessage,
  Conversation,
  GeminiModelId,
  ImageAspectRatio,
  ImageStylePreset,
  PreparedImageAttachment,
} from '../types/chat';
import {createId, deriveFallbackTitle} from '../utils/formatters';
import {
  cleanImagePrompt,
  composeStyledImagePrompt,
  detectImageGenerationIntent,
  getDimensionsForAspectRatio,
  inferAspectRatioFromPrompt,
  inferStyleFromPrompt,
} from '../utils/imageIntent';
import {
  clearAllImageRecords,
  deleteImageRecords,
  getImageRecord,
  saveGeneratedImageRecord,
  saveImageRecord,
  stripPreparedToRef,
} from '../utils/imageStore';
import {
  loadActiveChatId,
  loadConversations,
  loadModel,
  saveActiveChatId,
  saveConversations,
  saveModel,
} from '../utils/storage';

// Send only recent relevant turns to minimize payload size and TTFT on Vercel
const MAX_HISTORY_MESSAGES = 6;
const MAX_RECENT_IMAGE_TURNS = 1;
const WARMUP_INTERVAL_MS = 150_000;

interface ApiImagePart {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
}

interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ApiImagePart[];
}

interface StreamParams {
  conversationId: string;
  historyForApi: ApiMessage[];
  assistantMessageId: string;
  modelToUse: GeminiModelId;
  controller: AbortController;
}

async function buildCompactHistory(
  messages: ChatMessage[],
  extraTurn?: {
    content: string;
    preparedImages?: PreparedImageAttachment[];
  }
): Promise<ApiMessage[]> {
  const validMessages = messages.filter(
    (m) =>
      !m.isError &&
      (m.content.trim().length > 0 || (m.attachments && m.attachments.length > 0))
  );

  const recentSlice = validMessages.slice(-MAX_HISTORY_MESSAGES);
  const preparedById = new Map<string, PreparedImageAttachment>();
  if (extraTurn?.preparedImages) {
    for (const img of extraTurn.preparedImages) {
      preparedById.set(img.id, img);
    }
  }

  const combined: Array<{
    role: 'user' | 'assistant';
    content: string;
    attachmentIds: string[];
  }> = recentSlice.map((m) => ({
    role: m.role,
    content: m.content,
    attachmentIds: (m.attachments ?? []).map((a) => a.id),
  }));

  if (
    extraTurn &&
    (extraTurn.content.trim().length > 0 ||
      (extraTurn.preparedImages && extraTurn.preparedImages.length > 0))
  ) {
    combined.push({
      role: 'user',
      content: extraTurn.content,
      attachmentIds: (extraTurn.preparedImages ?? []).map((a) => a.id),
    });
  }

  const finalSlice = combined.slice(-MAX_HISTORY_MESSAGES);

  // Only forward images from the latest image turn (within the last 2 turns) to avoid re-uploading large payloads
  const imageTurnIndices = new Set<number>();
  const minImageTurnIndex = Math.max(0, finalSlice.length - 2);
  for (let i = finalSlice.length - 1; i >= minImageTurnIndex; i--) {
    if (finalSlice[i].attachmentIds.length > 0) {
      imageTurnIndices.add(i);
      if (imageTurnIndices.size >= MAX_RECENT_IMAGE_TURNS) break;
    }
  }

  // Fast synchronous path when no IndexedDB lookup is needed
  const result: ApiMessage[] = [];
  for (let i = 0; i < finalSlice.length; i++) {
    const turn = finalSlice[i];
    let images: ApiImagePart[] | undefined;

    if (imageTurnIndices.has(i)) {
      const loaded: ApiImagePart[] = [];
      for (const attId of turn.attachmentIds) {
        const direct = preparedById.get(attId);
        if (direct) {
          loaded.push({mimeType: direct.mimeType, data: direct.base64});
          continue;
        }
        const stored = await getImageRecord(attId);
        if (stored) {
          loaded.push({mimeType: stored.mimeType, data: stored.base64});
        }
      }
      if (loaded.length > 0) {
        images = loaded;
      }
    }

    if (turn.content.trim().length > 0 || (images && images.length > 0)) {
      result.push({
        role: turn.role,
        content: turn.content,
        ...(images ? {images} : {}),
      });
    }
  }

  return result;
}

function collectMediaIds(messages: ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.attachments) {
      for (const att of m.attachments) {
        ids.push(att.id);
      }
    }
    if (m.generatedImage?.imageId) {
      ids.push(m.generatedImage.imageId);
    }
  }
  return ids;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read generated image data.'));
    reader.readAsDataURL(blob);
  });
}

export function useConversations() {
  const initialConversationsRef = useRef<Conversation[] | null>(null);
  if (initialConversationsRef.current === null) {
    initialConversationsRef.current = loadConversations();
  }

  const [conversations, setConversations] = useState<Conversation[]>(
    () => initialConversationsRef.current ?? []
  );
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    const saved = loadActiveChatId();
    const list = initialConversationsRef.current ?? [];
    if (saved && list.some((c) => c.id === saved)) {
      return saved;
    }
    return list[0]?.id ?? null;
  });
  const [model, setModel] = useState<GeminiModelId>(() => loadModel());
  const [streamingChatId, setStreamingChatId] = useState<string | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  const [error, setError] = useState<ChatError | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const imageAbortControllersRef = useRef<
    Map<string, {chatId: string; controller: AbortController}>
  >(new Map());
  const isStreamingRef = useRef(false);
  const lastWarmupAtRef = useRef<number>(0);
  const conversationsRef = useRef<Conversation[]>(conversations);
  conversationsRef.current = conversations;
  const activeStreamRef = useRef<{
    chatId: string;
    messageId: string;
    text: string;
  } | null>(null);

  const warmChatApi = useCallback(() => {
    const now = Date.now();
    if (now - lastWarmupAtRef.current < WARMUP_INTERVAL_MS) return;
    lastWarmupAtRef.current = now;
    fetch('/api/chat', {method: 'GET', keepalive: true}).catch(() => {});
  }, []);

  // Pre-warm /api/chat serverless function on mount so cold start completes before first prompt
  useEffect(() => {
    warmChatApi();
  }, [warmChatApi]);

  useEffect(() => {
    saveActiveChatId(activeChatId);
  }, [activeChatId]);

  useEffect(() => {
    saveModel(model);
  }, [model]);

  // Persist asynchronously when idle so JSON serialization never blocks UI painting
  useEffect(() => {
    if (streamingChatId) return;
    const timerId = window.setTimeout(() => {
      saveConversations(conversations);
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [conversations, streamingChatId]);

  // Flush any in-flight streamed text if the user closes the tab mid-stream
  useEffect(() => {
    const handleBeforeUnload = () => {
      const currentStream = activeStreamRef.current;
      if (currentStream && currentStream.text.trim()) {
        const snapshot = conversationsRef.current.map((c) =>
          c.id === currentStream.chatId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map((m) =>
                  m.id === currentStream.messageId
                    ? {...m, content: currentStream.text}
                    : m
                ),
              }
            : c
        );
        saveConversations(snapshot);
      } else {
        saveConversations(conversationsRef.current);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeChatId) ?? null,
    [conversations, activeChatId]
  );

  const isStreaming = streamingChatId !== null;

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const stopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const createChat = useCallback(() => {
    stopGeneration();
    setError(null);
    const now = Date.now();
    const newChat: Conversation = {
      id: createId(),
      title: 'New chat',
      isAutoTitled: true,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setConversations((prev) => [newChat, ...prev]);
    setActiveChatId(newChat.id);
    return newChat.id;
  }, [stopGeneration]);

  const selectChat = useCallback(
    (id: string) => {
      if (id === activeChatId) return;
      stopGeneration();
      setError(null);
      setActiveChatId(id);
    },
    [activeChatId, stopGeneration]
  );

  const renameChat = useCallback((id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              title: trimmed.slice(0, 80),
              isAutoTitled: false,
            }
          : c
      )
    );
  }, []);

  const deleteChat = useCallback(
    (id: string) => {
      if (streamingChatId === id) {
        stopGeneration();
      }
      setError(null);
      const target = conversationsRef.current.find((c) => c.id === id);
      for (const [msgId, entry] of imageAbortControllersRef.current.entries()) {
        if (entry.chatId === id) {
          entry.controller.abort();
          imageAbortControllersRef.current.delete(msgId);
        }
      }
      if (target) {
        const mediaIds = collectMediaIds(target.messages);
        if (mediaIds.length > 0) {
          void deleteImageRecords(mediaIds);
        }
      }
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (activeChatId === id) {
          setActiveChatId(next[0]?.id ?? null);
        }
        return next;
      });
    },
    [activeChatId, streamingChatId, stopGeneration]
  );

  const clearAllChats = useCallback(() => {
    stopGeneration();
    for (const entry of imageAbortControllersRef.current.values()) {
      entry.controller.abort();
    }
    imageAbortControllersRef.current.clear();
    setError(null);
    setConversations([]);
    setActiveChatId(null);
    saveConversations([]);
    void clearAllImageRecords();
  }, [stopGeneration]);

  const beginOptimisticStream = useCallback(
    (conversationId: string, assistantMessageId: string): AbortController => {
      stopGeneration();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      isStreamingRef.current = true;
      activeStreamRef.current = {
        chatId: conversationId,
        messageId: assistantMessageId,
        text: '',
      };
      setStreamingChatId(conversationId);
      setStreamingMessageId(assistantMessageId);
      setStreamingText('');
      setError(null);
      return controller;
    },
    [stopGeneration]
  );

  const streamAssistantReply = useCallback(
    async ({
      conversationId,
      historyForApi,
      assistantMessageId,
      modelToUse,
      controller,
    }: StreamParams): Promise<string | null> => {
      let accumulatedText = '';
      let firstTokenRendered = false;
      let rafId: number | null = null;

      const commitFinalText = (finalText: string) => {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === assistantMessageId ? {...m, content: finalText} : m
                  ),
                }
              : c
          )
        );
      };

      const removePlaceholder = () => {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.filter((m) => m.id !== assistantMessageId),
                }
              : c
          )
        );
      };

      const flushStreamingText = () => {
        rafId = null;
        setStreamingText(accumulatedText);
      };

      const scheduleRender = () => {
        // Render first token synchronously with zero delay, then batch rapid bursts per animation frame
        if (!firstTokenRendered) {
          firstTokenRendered = true;
          flushStreamingText();
          return;
        }
        if (rafId === null) {
          rafId = window.requestAnimationFrame(flushStreamingText);
        }
      };

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) return;

        let eventData: {text?: string; done?: boolean; error?: string; code?: string};
        try {
          eventData = JSON.parse(jsonStr);
        } catch {
          return;
        }

        if (eventData.error) {
          throw Object.assign(new Error(eventData.error), {
            code: eventData.code ?? 'STREAM_ERROR',
          });
        }

        if (typeof eventData.text === 'string' && eventData.text.length > 0) {
          accumulatedText += eventData.text;
          if (activeStreamRef.current) {
            activeStreamRef.current.text = accumulatedText;
          }
          scheduleRender();
        }
      };

      try {
        lastWarmupAtRef.current = Date.now();
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            messages: historyForApi,
            model: modelToUse,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errMsg =
            response.status === 404
              ? 'Chat API endpoint not found (404). Make sure /api/chat is deployed on your host.'
              : `Request failed (${response.status}).`;
          let errCode = 'HTTP_ERROR';
          try {
            const errJson = (await response.json()) as {error?: string; code?: string};
            if (errJson.error) errMsg = errJson.error;
            if (errJson.code) errCode = errJson.code;
          } catch {
            // Non-JSON error body
          }
          throw Object.assign(new Error(errMsg), {code: errCode});
        }

        if (!response.body) {
          throw new Error('Streaming response body was unavailable.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const {done, value} = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, {stream: true});
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            processLine(rawLine);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          for (const remainingLine of buffer.split('\n')) {
            processLine(remainingLine);
          }
        }

        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }

        if (!accumulatedText.trim()) {
          throw Object.assign(
            new Error('Gemini returned an empty response. Please try again.'),
            {code: 'EMPTY_RESPONSE'}
          );
        }

        commitFinalText(accumulatedText);
        return accumulatedText;
      } catch (err) {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }

        if (controller.signal.aborted) {
          if (accumulatedText.trim()) {
            commitFinalText(accumulatedText);
            return accumulatedText;
          } else {
            removePlaceholder();
          }
          return null;
        }

        const errMessage =
          err instanceof Error
            ? err.message
            : 'Something went wrong while generating a reply.';
        const errCode =
          err && typeof err === 'object' && 'code' in err
            ? String((err as {code?: string}).code)
            : undefined;

        setError({
          message: errMessage,
          code: errCode,
          retryable: true,
        });

        if (accumulatedText.trim()) {
          commitFinalText(accumulatedText);
        } else {
          removePlaceholder();
        }
        return null;
      } finally {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
        }
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        activeStreamRef.current = null;
        isStreamingRef.current = false;
        setStreamingChatId(null);
        setStreamingMessageId(null);
        setStreamingText('');
      }
    },
    []
  );

  const runImageGenerationTask = useCallback(
    async (params: {
      conversationId: string;
      assistantMessageId: string;
      prompt: string;
      style: ImageStylePreset;
      width: number;
      height: number;
    }): Promise<void> => {
      const existingEntry = imageAbortControllersRef.current.get(
        params.assistantMessageId
      );
      if (existingEntry) {
        existingEntry.controller.abort();
        imageAbortControllersRef.current.delete(params.assistantMessageId);
      }

      const controller = new AbortController();
      imageAbortControllersRef.current.set(params.assistantMessageId, {
        chatId: params.conversationId,
        controller,
      });

      const patchGeneratedImage = (
        updater: (
          current: NonNullable<ChatMessage['generatedImage']>
        ) => NonNullable<ChatMessage['generatedImage']>
      ) => {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === params.conversationId
              ? {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === params.assistantMessageId && m.generatedImage
                      ? {...m, generatedImage: updater(m.generatedImage)}
                      : m
                  ),
                }
              : c
          )
        );
      };

      const composedPrompt = composeStyledImagePrompt(params.prompt, params.style);
      const startedAt = Date.now();

      try {
        const response = await fetch('/api/image', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            prompt: composedPrompt,
            width: params.width,
            height: params.height,
          }),
          signal: controller.signal,
        });

        let resultPayload: {
          imageBase64: string;
          mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
          provider: string;
          model: string;
          width: number;
          height: number;
          remoteUrl?: string;
          durationMs: number;
        } | null = null;

        if (response.ok) {
          resultPayload = (await response.json()) as typeof resultPayload;
        } else {
          let errMsg =
            response.status === 404
              ? 'Image API endpoint not found (404). Make sure /api/image is deployed on your host.'
              : `Image generation failed (${response.status}).`;
          let fallbackClientUrl: string | undefined;
          try {
            const errJson = (await response.json()) as {
              error?: string;
              fallbackClientUrl?: string;
            };
            if (errJson.error) errMsg = errJson.error;
            if (errJson.fallbackClientUrl) {
              fallbackClientUrl = errJson.fallbackClientUrl;
            }
          } catch {
            // Non-JSON error body
          }

          // Single direct browser-IP fallback if server shared IP hit free quota
          if (response.status === 429 && fallbackClientUrl) {
            const directRes = await fetch(fallbackClientUrl, {
              signal: controller.signal,
            });
            const directCt = (directRes.headers.get('content-type') || '').toLowerCase();
            if (directRes.ok && directCt.startsWith('image/')) {
              const blob = await directRes.blob();
              if (blob.size >= 1500) {
                const base64 = await blobToBase64(blob);
                resultPayload = {
                  imageBase64: base64,
                  mimeType: directCt.includes('png')
                    ? 'image/png'
                    : directCt.includes('webp')
                      ? 'image/webp'
                      : 'image/jpeg',
                  provider: 'Pollinations AI',
                  model: 'FLUX',
                  width: params.width,
                  height: params.height,
                  remoteUrl: fallbackClientUrl,
                  durationMs: Date.now() - startedAt,
                };
              }
            }
          }

          if (!resultPayload) {
            throw new Error(errMsg);
          }
        }

        if (!resultPayload?.imageBase64) {
          throw new Error('Image provider returned an empty image.');
        }

        const recordId = createId();
        await saveGeneratedImageRecord({
          id: recordId,
          mimeType: resultPayload.mimeType,
          base64: resultPayload.imageBase64,
          width: resultPayload.width,
          height: resultPayload.height,
        });

        patchGeneratedImage((current) => ({
          ...current,
          status: 'ready',
          imageId: recordId,
          provider: resultPayload!.provider,
          model: resultPayload!.model,
          width: resultPayload!.width,
          height: resultPayload!.height,
          remoteUrl: resultPayload!.remoteUrl,
          durationMs: resultPayload!.durationMs,
          error: undefined,
        }));
      } catch (err) {
        if (controller.signal.aborted) {
          patchGeneratedImage((current) => ({
            ...current,
            status: 'error',
            error: 'Image generation canceled.',
          }));
          return;
        }
        const message =
          err instanceof Error
            ? err.message
            : 'Unable to generate image right now. Please try again.';
        patchGeneratedImage((current) => ({
          ...current,
          status: 'error',
          error: message,
        }));
      } finally {
        const tracked = imageAbortControllersRef.current.get(params.assistantMessageId);
        if (tracked?.controller === controller) {
          imageAbortControllersRef.current.delete(params.assistantMessageId);
        }
      }
    },
    []
  );

  const generateImage = useCallback(
    async (
      rawPrompt: string,
      options?: {
        style?: ImageStylePreset;
        aspectRatio?: ImageAspectRatio;
        skipIntentClean?: boolean;
        displayContent?: string;
      }
    ): Promise<void> => {
      const trimmedInput = rawPrompt.trim();
      if (!trimmedInput) return;

      const cleanPrompt = options?.skipIntentClean
        ? trimmedInput
        : cleanImagePrompt(trimmedInput) || trimmedInput;

      const resolvedStyle =
        options?.style !== undefined
          ? options.style
          : inferStyleFromPrompt(trimmedInput);
      const resolvedRatio =
        options?.aspectRatio !== undefined
          ? options.aspectRatio
          : inferAspectRatioFromPrompt(trimmedInput);
      const {width, height} = getDimensionsForAspectRatio(resolvedRatio);

      const now = Date.now();
      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        content: options?.displayContent ?? trimmedInput,
        createdAt: now,
      };
      const assistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
        generatedImage: {
          id: createId(),
          prompt: cleanPrompt,
          style: resolvedStyle,
          aspectRatio: resolvedRatio,
          width,
          height,
          status: 'generating',
          createdAt: now + 1,
        },
      };

      const titleSeed = deriveFallbackTitle(cleanPrompt);
      let targetChatId = activeChatId;
      const existing = conversationsRef.current.find((c) => c.id === targetChatId);

      if (!existing) {
        targetChatId = createId();
        const newChat: Conversation = {
          id: targetChatId,
          title: titleSeed,
          isAutoTitled: true,
          createdAt: now,
          updatedAt: now,
          messages: [userMsg, assistantMsg],
        };
        setConversations((prev) => [newChat, ...prev]);
        setActiveChatId(targetChatId);
      } else {
        const isFirstMessage = existing.messages.length === 0;
        const shouldAutoTitle = isFirstMessage && existing.isAutoTitled !== false;
        const updatedTitle = shouldAutoTitle ? titleSeed : existing.title;

        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === targetChatId
              ? {
                  ...c,
                  title: updatedTitle,
                  updatedAt: now,
                  messages: [...c.messages, userMsg, assistantMsg],
                }
              : c
          );
          return updated.sort((a, b) => b.updatedAt - a.updatedAt);
        });
      }

      setError(null);

      // Launch non-blocking concurrent image generation without locking chat input
      void runImageGenerationTask({
        conversationId: targetChatId!,
        assistantMessageId: assistantMsg.id,
        prompt: cleanPrompt,
        style: resolvedStyle,
        width,
        height,
      });
    },
    [activeChatId, runImageGenerationTask]
  );

  const cancelImageGeneration = useCallback((assistantMessageId: string) => {
    const entry = imageAbortControllersRef.current.get(assistantMessageId);
    if (entry) {
      entry.controller.abort();
      imageAbortControllersRef.current.delete(assistantMessageId);
    }
    setConversations((prev) =>
      prev.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === assistantMessageId && m.generatedImage
            ? {
                ...m,
                generatedImage: {
                  ...m.generatedImage,
                  status: 'error',
                  error: 'Image generation canceled.',
                },
              }
            : m
        ),
      }))
    );
  }, []);

  const regenerateImage = useCallback(
    async (assistantMessageId: string) => {
      let targetConv: Conversation | undefined;
      let targetMsg: ChatMessage | undefined;

      for (const conv of conversationsRef.current) {
        const found = conv.messages.find((m) => m.id === assistantMessageId);
        if (found?.generatedImage) {
          targetConv = conv;
          targetMsg = found;
          break;
        }
      }

      if (!targetConv || !targetMsg?.generatedImage) return;

      const oldImg = targetMsg.generatedImage;
      if (oldImg.imageId) {
        void deleteImageRecords([oldImg.imageId]);
      }

      const now = Date.now();
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetConv!.id
            ? {
                ...c,
                updatedAt: now,
                messages: c.messages.map((m) =>
                  m.id === assistantMessageId && m.generatedImage
                    ? {
                        ...m,
                        generatedImage: {
                          ...m.generatedImage,
                          status: 'generating',
                          imageId: undefined,
                          remoteUrl: undefined,
                          provider: undefined,
                          model: undefined,
                          durationMs: undefined,
                          error: undefined,
                          createdAt: now,
                        },
                      }
                    : m
                ),
              }
            : c
        )
      );

      await runImageGenerationTask({
        conversationId: targetConv.id,
        assistantMessageId,
        prompt: oldImg.prompt,
        style: oldImg.style,
        width: oldImg.width,
        height: oldImg.height,
      });
    },
    [runImageGenerationTask]
  );

  const sendMessage = useCallback(
    async (
      rawContent: string,
      preparedImages?: PreparedImageAttachment[]
    ): Promise<string | null> => {
      const content = rawContent.trim();
      const hasImages = Boolean(preparedImages && preparedImages.length > 0);
      if (!content && !hasImages) {
        return null;
      }

      // Automatic free AI image generation intent detection (non-blocking)
      if (!hasImages) {
        const intent = detectImageGenerationIntent(content);
        if (intent.isImageIntent) {
          await generateImage(intent.prompt, {
            style: intent.inferredStyle,
            aspectRatio: intent.inferredRatio,
            skipIntentClean: true,
            displayContent: content,
          });
          return null;
        }
      }

      if (isStreaming || isStreamingRef.current) {
        return null;
      }

      const attachmentRefs =
        preparedImages && preparedImages.length > 0
          ? preparedImages.map(stripPreparedToRef)
          : undefined;

      const now = Date.now();
      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        content,
        ...(attachmentRefs ? {attachments: attachmentRefs} : {}),
        createdAt: now,
      };
      const assistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      };

      const titleSeed = content
        ? deriveFallbackTitle(content)
        : preparedImages && preparedImages.length > 1
          ? `Image analysis (${preparedImages.length})`
          : 'Image analysis';

      let targetChatId = activeChatId;
      const existing = conversationsRef.current.find((c) => c.id === targetChatId);
      const precedingMessages = existing ? existing.messages : [];

      if (!existing) {
        targetChatId = createId();
        const newChat: Conversation = {
          id: targetChatId,
          title: titleSeed,
          isAutoTitled: true,
          createdAt: now,
          updatedAt: now,
          messages: [userMsg, assistantMsg],
        };
        setConversations((prev) => [newChat, ...prev]);
        setActiveChatId(targetChatId);
      } else {
        const isFirstMessage = existing.messages.length === 0;
        const shouldAutoTitle = isFirstMessage && existing.isAutoTitled !== false;
        const updatedTitle = shouldAutoTitle ? titleSeed : existing.title;

        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === targetChatId
              ? {
                  ...c,
                  title: updatedTitle,
                  updatedAt: now,
                  messages: [...c.messages, userMsg, assistantMsg],
                }
              : c
          );
          return updated.sort((a, b) => b.updatedAt - a.updatedAt);
        });
      }

      // Immediately enter streaming UI state synchronously (0ms optimistic feedback)
      const controller = beginOptimisticStream(targetChatId!, assistantMsg.id);

      // Persist images to IndexedDB in background without blocking API launch
      if (preparedImages && preparedImages.length > 0) {
        void Promise.all(preparedImages.map((img) => saveImageRecord(img)));
      }

      const historyForApi = await buildCompactHistory(precedingMessages, {
        content,
        preparedImages,
      });

      return await streamAssistantReply({
        conversationId: targetChatId!,
        historyForApi,
        assistantMessageId: assistantMsg.id,
        modelToUse: model,
        controller,
      });
    },
    [
      activeChatId,
      beginOptimisticStream,
      generateImage,
      isStreaming,
      model,
      streamAssistantReply,
    ]
  );

  const regenerateResponse = useCallback(
    async (targetMessageId?: string) => {
      if (!activeChatId || isStreaming || isStreamingRef.current) return;
      const chat = conversationsRef.current.find((c) => c.id === activeChatId);
      if (!chat || chat.messages.length === 0) return;

      let cutIndex = -1;
      if (targetMessageId) {
        cutIndex = chat.messages.findIndex((m) => m.id === targetMessageId);
      } else {
        const lastMsg = chat.messages[chat.messages.length - 1];
        if (lastMsg.role === 'assistant') {
          cutIndex = chat.messages.length - 1;
        }
      }

      const now = Date.now();

      if (cutIndex >= 0 && chat.messages[cutIndex]?.role === 'assistant') {
        const targetAssistant = chat.messages[cutIndex];
        if (targetAssistant.generatedImage) {
          await regenerateImage(targetAssistant.id);
          return;
        }
        const assistantId = targetAssistant.id;
        const precedingMessages = chat.messages.slice(0, cutIndex);

        const controller = beginOptimisticStream(activeChatId, assistantId);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeChatId
              ? {
                  ...c,
                  updatedAt: now,
                  messages: [
                    ...precedingMessages,
                    {
                      id: assistantId,
                      role: 'assistant',
                      content: '',
                      createdAt: now,
                    },
                  ],
                }
              : c
          )
        );

        const historyForApi = await buildCompactHistory(precedingMessages);
        if (historyForApi.length === 0) return;

        await streamAssistantReply({
          conversationId: activeChatId,
          historyForApi,
          assistantMessageId: assistantId,
          modelToUse: model,
          controller,
        });
        return;
      }

      const lastUserIndex = [...chat.messages]
        .reverse()
        .findIndex((m) => m.role === 'user');
      if (lastUserIndex === -1) return;
      const actualUserIndex = chat.messages.length - 1 - lastUserIndex;
      const baseMessages = chat.messages.slice(0, actualUserIndex + 1);
      const newAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now,
      };

      const controller = beginOptimisticStream(activeChatId, newAssistantMsg.id);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeChatId
            ? {
                ...c,
                updatedAt: now,
                messages: [...baseMessages, newAssistantMsg],
              }
            : c
        )
      );

      const historyForApi = await buildCompactHistory(baseMessages);
      await streamAssistantReply({
        conversationId: activeChatId,
        historyForApi,
        assistantMessageId: newAssistantMsg.id,
        modelToUse: model,
        controller,
      });
    },
    [
      activeChatId,
      beginOptimisticStream,
      isStreaming,
      model,
      regenerateImage,
      streamAssistantReply,
    ]
  );

  const editMessage = useCallback(
    async (messageId: string, newContent: string) => {
      const trimmed = newContent.trim();
      if (!activeChatId || isStreaming || isStreamingRef.current) return;

      const chat = conversationsRef.current.find((c) => c.id === activeChatId);
      if (!chat) return;

      const msgIndex = chat.messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1 || chat.messages[msgIndex].role !== 'user') return;

      const targetMsg = chat.messages[msgIndex];
      const hasAttachments = Boolean(
        targetMsg.attachments && targetMsg.attachments.length > 0
      );
      if (!trimmed && !hasAttachments) return;

      const discardedMsgs = chat.messages.slice(msgIndex + 1);
      for (const m of discardedMsgs) {
        const entry = imageAbortControllersRef.current.get(m.id);
        if (entry) {
          entry.controller.abort();
          imageAbortControllersRef.current.delete(m.id);
        }
      }

      const discardedIds = collectMediaIds(discardedMsgs);
      if (discardedIds.length > 0) {
        void deleteImageRecords(discardedIds);
      }

      const previousGenerated = chat.messages[msgIndex + 1]?.generatedImage;
      const detectedIntent = !hasAttachments
        ? detectImageGenerationIntent(trimmed)
        : null;
      const shouldGenerateImage =
        Boolean(detectedIntent?.isImageIntent) ||
        (Boolean(previousGenerated) && !hasAttachments);

      const now = Date.now();
      const updatedUserMsg: ChatMessage = {
        ...targetMsg,
        content: trimmed,
        updatedAt: now,
      };
      const prefixMessages = [...chat.messages.slice(0, msgIndex), updatedUserMsg];
      const shouldUpdateTitle = msgIndex === 0 && chat.isAutoTitled !== false;

      if (shouldGenerateImage) {
        const cleanPrompt = detectedIntent?.isImageIntent
          ? detectedIntent.prompt
          : cleanImagePrompt(trimmed) || trimmed;
        const resolvedStyle =
          detectedIntent?.isImageIntent && detectedIntent.inferredStyle !== 'auto'
            ? detectedIntent.inferredStyle
            : previousGenerated?.style ?? inferStyleFromPrompt(trimmed);
        const resolvedRatio =
          detectedIntent?.isImageIntent && detectedIntent.inferredRatio !== '1:1'
            ? detectedIntent.inferredRatio
            : previousGenerated?.aspectRatio ?? inferAspectRatioFromPrompt(trimmed);
        const {width, height} = getDimensionsForAspectRatio(resolvedRatio);

        const newAssistantMsg: ChatMessage = {
          id: createId(),
          role: 'assistant',
          content: '',
          createdAt: now + 1,
          generatedImage: {
            id: createId(),
            prompt: cleanPrompt,
            style: resolvedStyle,
            aspectRatio: resolvedRatio,
            width,
            height,
            status: 'generating',
            createdAt: now + 1,
          },
        };

        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeChatId
              ? {
                  ...c,
                  title: shouldUpdateTitle ? deriveFallbackTitle(cleanPrompt) : c.title,
                  updatedAt: now,
                  messages: [...prefixMessages, newAssistantMsg],
                }
              : c
          )
        );

        await runImageGenerationTask({
          conversationId: activeChatId,
          assistantMessageId: newAssistantMsg.id,
          prompt: cleanPrompt,
          style: resolvedStyle,
          width,
          height,
        });
        return;
      }

      const newAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      };

      const controller = beginOptimisticStream(activeChatId, newAssistantMsg.id);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeChatId
            ? {
                ...c,
                title: shouldUpdateTitle
                  ? trimmed
                    ? deriveFallbackTitle(trimmed)
                    : 'Image analysis'
                  : c.title,
                updatedAt: now,
                messages: [...prefixMessages, newAssistantMsg],
              }
            : c
        )
      );

      const historyForApi = await buildCompactHistory(prefixMessages);
      await streamAssistantReply({
        conversationId: activeChatId,
        historyForApi,
        assistantMessageId: newAssistantMsg.id,
        modelToUse: model,
        controller,
      });
    },
    [
      activeChatId,
      beginOptimisticStream,
      isStreaming,
      model,
      runImageGenerationTask,
      streamAssistantReply,
    ]
  );

  return {
    conversations,
    activeChatId,
    activeConversation,
    model,
    setModel,
    isStreaming,
    streamingMessageId,
    streamingText,
    error,
    dismissError,
    warmChatApi,
    createChat,
    selectChat,
    renameChat,
    deleteChat,
    clearAllChats,
    sendMessage,
    generateImage,
    regenerateImage,
    cancelImageGeneration,
    stopGeneration,
    regenerateResponse,
    editMessage,
  };
}

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  ChatError,
  ChatMessage,
  Conversation,
  GeminiModelId,
  PreparedImageAttachment,
} from '../types/chat';
import {createId, deriveFallbackTitle} from '../utils/formatters';
import {
  clearAllImageRecords,
  deleteImageRecords,
  getImageRecord,
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

// Send only recent relevant conversation turns to minimize payload and latency
const MAX_HISTORY_MESSAGES = 8;
const MAX_RECENT_IMAGE_TURNS = 2;

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

  // Find up to MAX_RECENT_IMAGE_TURNS most recent messages that contain images
  const imageTurnIndices = new Set<number>();
  for (let i = finalSlice.length - 1; i >= 0; i--) {
    if (finalSlice[i].attachmentIds.length > 0) {
      imageTurnIndices.add(i);
      if (imageTurnIndices.size >= MAX_RECENT_IMAGE_TURNS) break;
    }
  }

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

function collectAttachmentIds(messages: ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.attachments) {
      for (const att of m.attachments) {
        ids.push(att.id);
      }
    }
  }
  return ids;
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
  const isStreamingRef = useRef(false);
  const conversationsRef = useRef<Conversation[]>(conversations);
  conversationsRef.current = conversations;
  const activeStreamRef = useRef<{
    chatId: string;
    messageId: string;
    text: string;
  } | null>(null);

  // Pre-warm /api/chat serverless function on mount so cold start finishes before first prompt
  useEffect(() => {
    fetch('/api/chat', {method: 'GET'}).catch(() => {});
  }, []);

  useEffect(() => {
    saveActiveChatId(activeChatId);
  }, [activeChatId]);

  useEffect(() => {
    saveModel(model);
  }, [model]);

  // Persist only when idle (avoid JSON.stringify overhead on main thread during active streaming)
  useEffect(() => {
    if (!streamingChatId) {
      saveConversations(conversations);
    }
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
      if (target) {
        const attachmentIds = collectAttachmentIds(target.messages);
        if (attachmentIds.length > 0) {
          void deleteImageRecords(attachmentIds);
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
    setError(null);
    setConversations([]);
    setActiveChatId(null);
    saveConversations([]);
    void clearAllImageRecords();
  }, [stopGeneration]);

  const streamAssistantReply = useCallback(
    async ({
      conversationId,
      historyForApi,
      assistantMessageId,
      modelToUse,
    }: StreamParams): Promise<string | null> => {
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
    [stopGeneration]
  );

  const sendMessage = useCallback(
    async (
      rawContent: string,
      preparedImages?: PreparedImageAttachment[]
    ): Promise<string | null> => {
      const content = rawContent.trim();
      const hasImages = Boolean(preparedImages && preparedImages.length > 0);
      if ((!content && !hasImages) || isStreaming || isStreamingRef.current) {
        return null;
      }

      if (preparedImages && preparedImages.length > 0) {
        await Promise.all(preparedImages.map((img) => saveImageRecord(img)));
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
      let historyForApi: ApiMessage[] = [];

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
        historyForApi = await buildCompactHistory([], {
          content,
          preparedImages,
        });
        setConversations((prev) => [newChat, ...prev]);
        setActiveChatId(targetChatId);
      } else {
        const isFirstMessage = existing.messages.length === 0;
        const shouldAutoTitle = isFirstMessage && existing.isAutoTitled !== false;
        const updatedTitle = shouldAutoTitle ? titleSeed : existing.title;
        historyForApi = await buildCompactHistory(existing.messages, {
          content,
          preparedImages,
        });

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

      if (targetChatId) {
        return await streamAssistantReply({
          conversationId: targetChatId,
          historyForApi,
          assistantMessageId: assistantMsg.id,
          modelToUse: model,
        });
      }
      return null;
    },
    [activeChatId, isStreaming, model, streamAssistantReply]
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
        const assistantId = chat.messages[cutIndex].id;
        const precedingMessages = chat.messages.slice(0, cutIndex);
        const historyForApi = await buildCompactHistory(precedingMessages);

        if (historyForApi.length === 0) return;

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

        await streamAssistantReply({
          conversationId: activeChatId,
          historyForApi,
          assistantMessageId: assistantId,
          modelToUse: model,
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
      const historyForApi = await buildCompactHistory(baseMessages);

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

      await streamAssistantReply({
        conversationId: activeChatId,
        historyForApi,
        assistantMessageId: newAssistantMsg.id,
        modelToUse: model,
      });
    },
    [activeChatId, isStreaming, model, streamAssistantReply]
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
      const hasAttachments = Boolean(targetMsg.attachments && targetMsg.attachments.length > 0);
      if (!trimmed && !hasAttachments) return;

      const discardedIds = collectAttachmentIds(chat.messages.slice(msgIndex + 1));
      if (discardedIds.length > 0) {
        void deleteImageRecords(discardedIds);
      }

      const now = Date.now();
      const updatedUserMsg: ChatMessage = {
        ...targetMsg,
        content: trimmed,
        updatedAt: now,
      };
      const newAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      };

      const prefixMessages = [...chat.messages.slice(0, msgIndex), updatedUserMsg];
      const historyForApi = await buildCompactHistory(prefixMessages);
      const shouldUpdateTitle = msgIndex === 0 && chat.isAutoTitled !== false;

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

      await streamAssistantReply({
        conversationId: activeChatId,
        historyForApi,
        assistantMessageId: newAssistantMsg.id,
        modelToUse: model,
      });
    },
    [activeChatId, isStreaming, model, streamAssistantReply]
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
    createChat,
    selectChat,
    renameChat,
    deleteChat,
    clearAllChats,
    sendMessage,
    stopGeneration,
    regenerateResponse,
    editMessage,
  };
}

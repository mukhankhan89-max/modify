import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  ChatError,
  ChatMessage,
  Conversation,
  GeminiModelId,
} from '../types/chat';
import {createId, deriveFallbackTitle} from '../utils/formatters';
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

interface StreamParams {
  conversationId: string;
  historyForApi: Array<{role: 'user' | 'assistant'; content: string}>;
  assistantMessageId: string;
  modelToUse: GeminiModelId;
}

function buildCompactHistory(
  messages: ChatMessage[],
  extraUserContent?: string
): Array<{role: 'user' | 'assistant'; content: string}> {
  const cleaned = messages
    .filter((m) => m.content.trim().length > 0 && !m.isError)
    .map((m) => ({role: m.role, content: m.content}));

  if (extraUserContent) {
    cleaned.push({role: 'user', content: extraUserContent});
  }

  return cleaned.slice(-MAX_HISTORY_MESSAGES);
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
  }, [stopGeneration]);

  const streamAssistantReply = useCallback(
    async ({conversationId, historyForApi, assistantMessageId, modelToUse}: StreamParams): Promise<boolean> => {
      stopGeneration();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      isStreamingRef.current = true;
      activeStreamRef.current = {chatId: conversationId, messageId: assistantMessageId, text: ''};
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
        return true;
      } catch (err) {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }

        if (controller.signal.aborted) {
          if (accumulatedText.trim()) {
            commitFinalText(accumulatedText);
          } else {
            removePlaceholder();
          }
          return false;
        }

        const errMessage =
          err instanceof Error ? err.message : 'Something went wrong while generating a reply.';
        const errCode =
          err && typeof err === 'object' && 'code' in err ? String((err as {code?: string}).code) : undefined;

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
        return false;
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
    async (rawContent: string) => {
      const content = rawContent.trim();
      if (!content || isStreaming || isStreamingRef.current) return;

      const now = Date.now();
      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        content,
        createdAt: now,
      };
      const assistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      };

      let targetChatId = activeChatId;
      let historyForApi: Array<{role: 'user' | 'assistant'; content: string}> = [];

      const existing = conversationsRef.current.find((c) => c.id === targetChatId);

      if (!existing) {
        targetChatId = createId();
        const derivedTitle = deriveFallbackTitle(content);
        const newChat: Conversation = {
          id: targetChatId,
          title: derivedTitle,
          isAutoTitled: true,
          createdAt: now,
          updatedAt: now,
          messages: [userMsg, assistantMsg],
        };
        historyForApi = [{role: 'user', content}];
        setConversations((prev) => [newChat, ...prev]);
        setActiveChatId(targetChatId);
      } else {
        const isFirstMessage = existing.messages.length === 0;
        const shouldAutoTitle = isFirstMessage && existing.isAutoTitled !== false;
        const updatedTitle = shouldAutoTitle ? deriveFallbackTitle(content) : existing.title;
        historyForApi = buildCompactHistory(existing.messages, content);

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
        await streamAssistantReply({
          conversationId: targetChatId,
          historyForApi,
          assistantMessageId: assistantMsg.id,
          modelToUse: model,
        });
      }
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
        const historyForApi = buildCompactHistory(precedingMessages);

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

      const lastUserIndex = [...chat.messages].reverse().findIndex((m) => m.role === 'user');
      if (lastUserIndex === -1) return;
      const actualUserIndex = chat.messages.length - 1 - lastUserIndex;
      const baseMessages = chat.messages.slice(0, actualUserIndex + 1);
      const newAssistantMsg: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: now,
      };
      const historyForApi = buildCompactHistory(baseMessages);

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
      if (!trimmed || !activeChatId || isStreaming || isStreamingRef.current) return;

      const chat = conversationsRef.current.find((c) => c.id === activeChatId);
      if (!chat) return;

      const msgIndex = chat.messages.findIndex((m) => m.id === messageId);
      if (msgIndex === -1 || chat.messages[msgIndex].role !== 'user') return;

      const now = Date.now();
      const updatedUserMsg: ChatMessage = {
        ...chat.messages[msgIndex],
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
      const historyForApi = buildCompactHistory(prefixMessages);
      const shouldUpdateTitle = msgIndex === 0 && chat.isAutoTitled !== false;

      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeChatId
            ? {
                ...c,
                title: shouldUpdateTitle ? deriveFallbackTitle(trimmed) : c.title,
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

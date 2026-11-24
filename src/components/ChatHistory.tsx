import {Check, MessageSquare, Pencil, Trash2, X} from 'lucide-react';
import {useEffect, useMemo, useRef, useState} from 'react';
import type {Conversation} from '../types/chat';
import {groupConversationsByDate} from '../utils/formatters';

interface ChatHistoryProps {
  conversations: Conversation[];
  activeChatId: string | null;
  searchQuery: string;
  onSelectChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onRequestDeleteChat: (conversation: Conversation) => void;
}

export function ChatHistory({
  conversations,
  activeChatId,
  searchQuery,
  onSelectChat,
  onRenameChat,
  onRequestDeleteChat,
}: ChatHistoryProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }, [conversations, searchQuery]);

  const groups = useMemo(
    () => groupConversationsByDate(filteredConversations),
    [filteredConversations]
  );

  const startEditing = (conv: Conversation) => {
    setEditingId(conv.id);
    setDraftTitle(conv.title);
  };

  const commitRename = () => {
    if (editingId && draftTitle.trim()) {
      onRenameChat(editingId, draftTitle.trim());
    }
    setEditingId(null);
    setDraftTitle('');
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraftTitle('');
  };

  if (conversations.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          No saved conversations yet. Start a message to create your first chat.
        </p>
      </div>
    );
  }

  if (filteredConversations.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No conversations match &ldquo;{searchQuery.trim()}&rdquo;.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="px-2.5 mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
            {group.label}
          </h3>
          <ul className="space-y-0.5">
            {group.items.map((conv) => {
              const isActive = conv.id === activeChatId;
              const isEditing = conv.id === editingId;

              if (isEditing) {
                return (
                  <li key={conv.id} className="px-1.5 py-1">
                    <div className="flex items-center gap-1 rounded-lg bg-white dark:bg-[#0B0F17] border border-teal-600 dark:border-teal-500 px-2 py-1">
                      <input
                        ref={editInputRef}
                        type="text"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEditing();
                          }
                        }}
                        aria-label="Rename conversation"
                        className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100 focus:outline-none py-1"
                      />
                      <button
                        type="button"
                        onClick={commitRename}
                        aria-label="Save title"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-teal-600 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-slate-800 shrink-0"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditing}
                        aria-label="Cancel rename"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-800 shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li key={conv.id} className="group relative flex items-center">
                  <button
                    type="button"
                    onClick={() => onSelectChat(conv.id)}
                    className={`flex items-center gap-2.5 w-full min-h-[40px] pl-2.5 pr-16 py-2 rounded-lg text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 dark:focus-visible:ring-teal-400 ${
                      isActive
                        ? 'bg-slate-200/80 text-slate-900 font-medium dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-700 hover:bg-slate-200/50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
                    }`}
                  >
                    <MessageSquare
                      className={`h-4 w-4 shrink-0 ${
                        isActive
                          ? 'text-teal-700 dark:text-teal-400'
                          : 'text-slate-400 dark:text-slate-500'
                      }`}
                    />
                    <span className="truncate flex-1">{conv.title}</span>
                  </button>

                  <div
                    className={`absolute right-1.5 flex items-center gap-0.5 transition-opacity duration-150 ${
                      isActive
                        ? 'opacity-100'
                        : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditing(conv);
                      }}
                      aria-label={`Rename ${conv.title}`}
                      title="Rename"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-300/60 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-700 transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRequestDeleteChat(conv);
                      }}
                      aria-label={`Delete ${conv.title}`}
                      title="Delete"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 dark:text-slate-400 dark:hover:text-red-400 dark:hover:bg-red-950/50 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

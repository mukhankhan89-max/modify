import {PanelLeftClose, Trash2, X} from 'lucide-react';
import {memo, useState} from 'react';
import type {Conversation, ThemeMode} from '../types/chat';
import {ChatHistory} from './ChatHistory';
import {NewChatButton} from './NewChatButton';
import {SearchChats} from './SearchChats';
import {ThemeToggle} from './ThemeToggle';

interface SidebarProps {
  conversations: Conversation[];
  activeChatId: string | null;
  theme: ThemeMode;
  isDesktopOpen: boolean;
  isMobileOpen: boolean;
  onCloseDesktop: () => void;
  onCloseMobile: () => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onRequestDeleteChat: (conversation: Conversation) => void;
  onRequestClearAll: () => void;
  onToggleTheme: () => void;
}

export const Sidebar = memo(function Sidebar({
  conversations,
  activeChatId,
  theme,
  isDesktopOpen,
  isMobileOpen,
  onCloseDesktop,
  onCloseMobile,
  onNewChat,
  onSelectChat,
  onRenameChat,
  onRequestDeleteChat,
  onRequestClearAll,
  onToggleTheme,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const handleSelect = (id: string) => {
    onSelectChat(id);
    onCloseMobile();
  };

  const handleNewChat = () => {
    onNewChat();
    onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-[#111827] border-r border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <span className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
          Lumen Chat
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCloseDesktop}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="hidden lg:inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation menu"
            className="inline-flex lg:hidden h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="px-3 pb-3 space-y-2.5">
        <NewChatButton onClick={handleNewChat} />
        <SearchChats value={searchQuery} onChange={setSearchQuery} />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <ChatHistory
          conversations={conversations}
          activeChatId={activeChatId}
          searchQuery={searchQuery}
          onSelectChat={handleSelect}
          onRenameChat={onRenameChat}
          onRequestDeleteChat={onRequestDeleteChat}
        />
      </div>

      <div className="border-t border-slate-200 dark:border-slate-800 p-3 space-y-1">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        {conversations.length > 0 && (
          <button
            type="button"
            onClick={onRequestClearAll}
            className="inline-flex items-center gap-2.5 w-full min-h-[40px] px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 whitespace-nowrap"
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            <span>Clear all chats</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        aria-label="Chat history sidebar"
        className={`hidden lg:block shrink-0 transition-[width] duration-200 ease-out overflow-hidden ${
          isDesktopOpen ? 'w-[272px]' : 'w-0'
        }`}
      >
        <div className="w-[272px] h-full">{sidebarContent}</div>
      </aside>

      {/* Mobile drawer backdrop + panel */}
      <div
        className={`fixed inset-0 z-40 lg:hidden transition-opacity duration-200 ${
          isMobileOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!isMobileOpen}
      >
        <div
          className="fixed inset-0 bg-slate-950/50 backdrop-blur-[1px]"
          onClick={onCloseMobile}
        />
        <aside
          aria-label="Mobile chat history sidebar"
          className={`fixed inset-y-0 left-0 z-50 w-[288px] max-w-[85vw] transform transition-transform duration-200 ease-out ${
            isMobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebarContent}
        </aside>
      </div>
    </>
  );
});

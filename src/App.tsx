import {useState} from 'react';
import {ChatWindow} from './components/ChatWindow';
import {ConfirmationDialog} from './components/ConfirmationDialog';
import {Sidebar} from './components/Sidebar';
import {useConversations} from './hooks/useConversations';
import {useTheme} from './hooks/useTheme';
import type {Conversation} from './types/chat';

export default function App() {
  const {theme, toggleTheme} = useTheme();
  const {
    conversations,
    activeChatId,
    activeConversation,
    model,
    setModel,
    isStreaming,
    streamingMessageId,
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
  } = useConversations();

  const [isDesktopSidebarOpen, setIsDesktopSidebarOpen] = useState(true);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [chatToDelete, setChatToDelete] = useState<Conversation | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-white text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      <Sidebar
        conversations={conversations}
        activeChatId={activeChatId}
        theme={theme}
        isDesktopOpen={isDesktopSidebarOpen}
        isMobileOpen={isMobileSidebarOpen}
        onCloseDesktop={() => setIsDesktopSidebarOpen(false)}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
        onNewChat={createChat}
        onSelectChat={selectChat}
        onRenameChat={renameChat}
        onRequestDeleteChat={(conv) => setChatToDelete(conv)}
        onRequestClearAll={() => setConfirmClearAll(true)}
        onToggleTheme={toggleTheme}
      />

      <main className="flex flex-1 min-w-0 h-full">
        <ChatWindow
          conversation={activeConversation}
          model={model}
          isStreaming={isStreaming}
          streamingMessageId={streamingMessageId}
          error={error}
          isDesktopSidebarOpen={isDesktopSidebarOpen}
          onOpenDesktopSidebar={() => setIsDesktopSidebarOpen(true)}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
          onNewChat={createChat}
          onChangeModel={setModel}
          onSendMessage={sendMessage}
          onStopGeneration={stopGeneration}
          onRegenerate={regenerateResponse}
          onEditMessage={editMessage}
          onDismissError={dismissError}
        />
      </main>

      <ConfirmationDialog
        isOpen={chatToDelete !== null}
        title="Delete conversation?"
        description={
          chatToDelete
            ? `"${chatToDelete.title}" and all of its messages will be permanently removed from your local history.`
            : ''
        }
        confirmLabel="Delete chat"
        onConfirm={() => {
          if (chatToDelete) {
            deleteChat(chatToDelete.id);
            setChatToDelete(null);
          }
        }}
        onCancel={() => setChatToDelete(null)}
      />

      <ConfirmationDialog
        isOpen={confirmClearAll}
        title="Clear all chat history?"
        description="This will permanently delete all saved conversations from your browser's Local Storage. This action cannot be undone."
        confirmLabel="Clear all"
        onConfirm={() => {
          clearAllChats();
          setConfirmClearAll(false);
          setIsMobileSidebarOpen(false);
        }}
        onCancel={() => setConfirmClearAll(false)}
      />
    </div>
  );
}

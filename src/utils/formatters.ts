import type {Conversation} from '../types/chat';

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function deriveFallbackTitle(message: string): string {
  const cleaned = message
    .replace(/[`*_#>\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?.!,;:]+$/, '');
  if (!cleaned) return 'New chat';
  if (cleaned.length <= 42) return cleaned;
  const sliced = cleaned.slice(0, 42);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${lastSpace > 18 ? sliced.slice(0, lastSpace) : sliced}...`;
}

export function formatMessageTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(timestamp);
  } catch {
    return '';
  }
}

export interface ConversationGroup {
  label: string;
  items: Conversation[];
}

export function groupConversationsByDate(conversations: Conversation[]): ConversationGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfLastWeek = startOfToday - 7 * 86_400_000;

  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const previousWeek: Conversation[] = [];
  const older: Conversation[] = [];

  for (const conv of conversations) {
    if (conv.updatedAt >= startOfToday) {
      today.push(conv);
    } else if (conv.updatedAt >= startOfYesterday) {
      yesterday.push(conv);
    } else if (conv.updatedAt >= startOfLastWeek) {
      previousWeek.push(conv);
    } else {
      older.push(conv);
    }
  }

  const groups: ConversationGroup[] = [];
  if (today.length > 0) groups.push({label: 'Today', items: today});
  if (yesterday.length > 0) groups.push({label: 'Yesterday', items: yesterday});
  if (previousWeek.length > 0) groups.push({label: 'Previous 7 days', items: previousWeek});
  if (older.length > 0) groups.push({label: 'Older', items: older});

  return groups;
}

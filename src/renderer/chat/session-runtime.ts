export interface SessionRuntimeMessage {
  id: string;
}

export interface WindowVisibilityMessage extends SessionRuntimeMessage {
  hidden?: boolean;
}

/** Hides the current window history without deleting its persisted content. */
export function hideVisibleMessages<T extends WindowVisibilityMessage>(messages: T[]): number {
  let hiddenCount = 0;
  for (const message of messages) {
    if (message.hidden) continue;
    message.hidden = true;
    hiddenCount += 1;
  }
  return hiddenCount;
}

/** Keeps transient streaming messages alive while the user views another session. */
export class SessionMessageCache<T extends SessionRuntimeMessage> {
  private readonly sessions = new Map<string, T[]>();

  remember(sessionId: string, messages: T[]): T[] {
    this.sessions.set(sessionId, messages);
    return messages;
  }

  load(sessionId: string, persisted: T[]): T[] {
    const cached = this.sessions.get(sessionId);
    if (!cached) return this.remember(sessionId, persisted);

    const cachedIds = new Set(cached.map((message) => message.id));
    for (const message of persisted) {
      if (!cachedIds.has(message.id)) cached.push(message);
    }
    return cached;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

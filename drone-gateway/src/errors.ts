export class UnknownAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`Unknown adapter: ${adapterId}`);
    this.name = 'UnknownAdapterError';
  }
}

export class UnknownConversationError extends Error {
  constructor(
    readonly adapterId: string,
    readonly conversationId: string
  ) {
    super(`Unknown conversation: ${adapterId}/${conversationId}`);
    this.name = 'UnknownConversationError';
  }
}

export class InjectionNotEnabledError extends Error {
  constructor(
    readonly adapterId: string,
    readonly conversationId: string
  ) {
    super(
      `Conversation ${adapterId}/${conversationId} is not an injection target ` +
        `(set "injection": { "enabled": true } in its conversation file)`
    );
    this.name = 'InjectionNotEnabledError';
  }
}

/**
 * Context management utilities to prevent context length exceeded errors
 */

// Conservative estimates for GPT-5 context window
// GPT-5 likely has a 128k+ token context window, but we'll use conservative limits
const MAX_CONTEXT_TOKENS = 100000; // Conservative limit to leave room for response
const ESTIMATED_TOKENS_PER_MESSAGE = 500; // Rough estimate for average message size
const MAX_MESSAGES_BEFORE_TRUNCATION = Math.floor(
  MAX_CONTEXT_TOKENS / ESTIMATED_TOKENS_PER_MESSAGE
);

/**
 * Estimate token count for a message (rough approximation)
 * This is a simple heuristic - for production use, consider using tiktoken
 */
function estimateTokenCount(message: any): number {
  if (!message) return 0;

  let text = "";

  // Handle different message formats
  if (message.parts) {
    text = message.parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text || "")
      .join(" ");
  } else if (message.content) {
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text || "")
        .join(" ");
    }
  } else if (message.text) {
    text = message.text;
  }

  // Rough token estimation: ~4 characters per token for English text
  // This is conservative and may vary based on content
  return Math.ceil(text.length / 4);
}

/**
 * Calculate total estimated tokens for a conversation
 */
export function calculateConversationTokens(messages: any[]): number {
  if (!Array.isArray(messages)) return 0;

  return messages.reduce((total, message) => {
    return total + estimateTokenCount(message);
  }, 0);
}

/**
 * Truncate conversation history to stay within context limits
 * Keeps the most recent messages and system context
 */
export function truncateConversationHistory(
  messages: any[],
  maxTokens: number = MAX_CONTEXT_TOKENS
): any[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Calculate current token usage
  const totalTokens = calculateConversationTokens(messages);

  console.log(
    `[ContextManager] Current conversation tokens: ${totalTokens}/${maxTokens}`
  );

  // If we're under the limit, return as-is
  if (totalTokens <= maxTokens) {
    return messages;
  }

  // Start with the most recent message (usually user input)
  const truncatedMessages: any[] = [];
  let currentTokens = 0;

  // Always keep the last message (user input)
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    const lastMessageTokens = estimateTokenCount(lastMessage);
    truncatedMessages.unshift(lastMessage);
    currentTokens += lastMessageTokens;
  }

  // Work backwards through messages, keeping as many as possible
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    const messageTokens = estimateTokenCount(message);

    // Check if adding this message would exceed our limit
    if (currentTokens + messageTokens > maxTokens) {
      // If we have space for at least a partial message, try to fit it
      const remainingTokens = maxTokens - currentTokens;
      if (remainingTokens > 100) {
        // Only if we have meaningful space left
        // Try to truncate the message content if it's too long
        const truncatedMessage = truncateMessageContent(
          message,
          remainingTokens
        );
        if (truncatedMessage) {
          truncatedMessages.unshift(truncatedMessage);
        }
      }
      break;
    }

    truncatedMessages.unshift(message);
    currentTokens += messageTokens;
  }

  console.log(
    `[ContextManager] Truncated conversation from ${messages.length} to ${truncatedMessages.length} messages`
  );
  console.log(
    `[ContextManager] Token usage reduced from ${totalTokens} to ${calculateConversationTokens(
      truncatedMessages
    )}`
  );

  return truncatedMessages;
}

/**
 * Truncate individual message content to fit within token limit
 */
function truncateMessageContent(message: any, maxTokens: number): any | null {
  if (!message || maxTokens < 50) return null; // Need at least some meaningful content

  const messageCopy = { ...message };
  let text = "";

  // Extract text content
  if (message.parts) {
    text = message.parts
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text || "")
      .join(" ");
  } else if (message.content) {
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text || "")
        .join(" ");
    }
  } else if (message.text) {
    text = message.text;
  }

  if (!text) return message; // No text content to truncate

  // Calculate how much text we can keep
  const maxChars = maxTokens * 4; // Rough conversion back to characters

  if (text.length <= maxChars) {
    return message; // No truncation needed
  }

  // Truncate text to fit
  const truncatedText = text.substring(0, maxChars - 100) + "... [truncated]";

  // Update the message with truncated content
  if (message.parts) {
    messageCopy.parts = message.parts.map((part: any) => {
      if (part.type === "text") {
        return { ...part, text: truncatedText };
      }
      return part;
    });
  } else if (message.content) {
    if (typeof message.content === "string") {
      messageCopy.content = truncatedText;
    } else if (Array.isArray(message.content)) {
      messageCopy.content = message.content.map((part: any) => {
        if (part.type === "text") {
          return { ...part, text: truncatedText };
        }
        return part;
      });
    }
  } else if (message.text) {
    messageCopy.text = truncatedText;
  }

  return messageCopy;
}

/**
 * Check if conversation is approaching context limits
 */
export function isNearContextLimit(
  messages: any[],
  threshold: number = 0.8
): boolean {
  const totalTokens = calculateConversationTokens(messages);
  const limit = MAX_CONTEXT_TOKENS * threshold;
  return totalTokens > limit;
}

/**
 * Get context usage statistics
 */
export function getContextStats(messages: any[]): {
  totalTokens: number;
  totalMessages: number;
  usagePercentage: number;
  isNearLimit: boolean;
} {
  const totalTokens = calculateConversationTokens(messages);
  const usagePercentage = (totalTokens / MAX_CONTEXT_TOKENS) * 100;
  const isNearLimit = usagePercentage > 80;

  return {
    totalTokens,
    totalMessages: messages.length,
    usagePercentage: Math.round(usagePercentage * 100) / 100,
    isNearLimit,
  };
}

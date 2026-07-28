/**
 * Structured conversation memory for the AI Agent.
 * Maintains recent chat history and provides formatted context for Gemini.
 */

const MAX_HISTORY_TURNS = 6; // 3 user + 3 assistant pairs

let conversationHistory = [];

/**
 * Add a turn to the conversation history.
 */
export function addTurn(role, content) {
    conversationHistory.push({ role, content, timestamp: Date.now() });
    // Trim to max turns
    if (conversationHistory.length > MAX_HISTORY_TURNS) {
        conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS);
    }
}

/**
 * Get formatted conversation context for the prompt.
 * Returns a string like:
 *   Conversation:
 *   User: previous question
 *   Assistant: previous answer
 *   User: current question
 */
export function getConversationContext() {
    if (conversationHistory.length === 0) return '';

    const lines = ['### Conversation History'];
    for (const turn of conversationHistory) {
        const label = turn.role === 'user' ? 'User' : 'Assistant';
        const content = turn.content.length > 1000
            ? turn.content.slice(0, 1000) + '...'
            : turn.content;
        lines.push('**' + label + ':** ' + content);
    }

    return lines.join('\n\n');
}

/**
 * Clear the conversation history.
 */
export function clearHistory() {
    conversationHistory = [];
}

/**
 * Get raw history array (for debugging).
 */
export function getHistory() {
    return [...conversationHistory];
}

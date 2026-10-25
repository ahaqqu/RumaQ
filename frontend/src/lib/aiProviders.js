// Default model per provider, mirroring backend/src/lib/ai.ts — keep in sync.
// Used for Settings placeholders and persona-generation fallbacks when the
// user has not selected a model.
export const AI_PROVIDER_DEFAULTS = {
  opencode: 'opencode-vision',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  gemini: 'gemini-3.6-flash',
  ollama: 'qwen3-vl:235b-instruct',
  custom: 'llama3.3:70b',
}

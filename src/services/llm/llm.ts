export type LLMProvider = 'openai' | 'local';

export type LLMConfig = {
    provider: LLMProvider;
    model: string;
    temperature: number;
};

export type LLMResponse = {
    text: string;
    prompt?: string;
};

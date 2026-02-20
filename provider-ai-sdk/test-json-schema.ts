import { generateText, jsonSchema } from 'ai';

const mockLanguageModel = {
  specificationVersion: 'v3',
  provider: 'test-provider',
  modelId: 'test-model',
  async doGenerate() {
    return {
      text: "",
      toolCalls: [
         { type: 'tool-call', toolCallType: 'function', toolCallId: '2', toolName: 't', args: JSON.stringify({ pattern: 'abc' }) }
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 20 },
      warnings: [],
      rawCall: { rawPrompt: null, rawSettings: {} },
    }
  }
};

generateText({
  model: mockLanguageModel as any,
  tools: {
    t: { parameters: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }) }
  },
  prompt: 'test'
}).then(res => console.log(JSON.stringify(res.toolCalls, null, 2)))
.catch(console.error);

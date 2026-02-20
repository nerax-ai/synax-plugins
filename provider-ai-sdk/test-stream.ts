import { streamText, generateText } from "ai";
import { stream, generate } from "./src/adapter.ts";

const mockLanguageModel = {
  specificationVersion: 'v3',
  provider: 'test-provider',
  modelId: 'test-model',
  async doStream() {
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'tool-call', toolCallType: 'function', toolCallId: '1', toolName: 'test', args: '{\"a\":1}' });
          controller.close();
        }
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    };
  },
  async doGenerate() {
    return {
      text: "hello",
      toolCalls: [
         { type: 'tool-call', toolCallType: 'function', toolCallId: '2', toolName: 'test_gen', args: '{\"b\":2}' }
      ],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 }
    }
  }
};

async function main() {
  const core = { streamText, generateText };
  console.log('--- STREAM ---');
  const res = stream(core as any, mockLanguageModel as any, {
    model: 'test',
    messages: [{ role: 'user', content: 'test' }],
  });
  for await (const p of res) {
    console.log(p);
  }
  
  console.log('--- GENERATE ---');
  const resGen = await generate(core as any, mockLanguageModel as any, {
    model: 'test',
    messages: [{ role: 'user', content: 'test' }],
  });
  console.log(JSON.stringify(resGen, null, 2));
}

main().catch(console.error);

import { generateText, jsonSchema } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

async function main() {
  const anthropic = createAnthropic({
    apiKey: 'sk-test',
    baseURL: 'http://localhost:3000/anthropic/v1',
  });
  
  const res = await generateText({
    model: anthropic('default'),
    tools: {
      testTool: { description: 'test', parameters: jsonSchema({ type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] }) }
    },
    prompt: 'Use testTool to say hello.'
  });
  
  console.log(JSON.stringify(res.toolCalls, null, 2));
}

main().catch(console.error);

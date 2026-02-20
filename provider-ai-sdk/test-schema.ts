import { generateText, tool, jsonSchema } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import http from 'http';

async function main() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log('HTTP BODY:', body);
      res.writeHead(200);
      res.end('{}');
      server.close();
    });
  });

  server.listen(5006, async () => {
    try {
      const anthropic = createAnthropic({
        apiKey: 'test-key',
        baseURL: 'http://localhost:5006',
      });

      await generateText({
        model: anthropic('claude-3-5-sonnet-20241022'),
        tools: {
          testTool: tool({
            description: 'My tool',
            parameters: jsonSchema({
              type: 'object',
              properties: {
                recipe: { type: 'string', description: 'desc' }
              },
              required: ['recipe']
            })
          })
        },
        prompt: 'test'
      });
    } catch (e) {
      server.close();
    }
  });
}

main().catch(console.error);

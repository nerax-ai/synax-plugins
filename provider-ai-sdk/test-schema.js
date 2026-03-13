import { decodeRequest } from '../endpoint-openai-responses/src/lib/request.ts';
import { modelMessageSchema } from 'ai/prompt';
import fs from 'fs';

const testData = JSON.parse(fs.readFileSync('/Users/illuxiza/Gitwork/tools/openai.json', 'utf-8'));

try {
  const request = decodeRequest(testData);
  console.log('✓ Decode successful');
  console.log('Total messages:', request.messages.length);
  
  // 验证每条消息
  let errors = [];
  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];
    try {
      modelMessageSchema.parse(msg);
    } catch (error) {
      errors.push({ index: i, message: msg, error: error.errors || error.message });
    }
  }
  
  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} messages failed validation`);
    errors.slice(0, 2).forEach(e => {
      console.error(`\nMessage ${e.index} (role: ${e.message.role}):`);
      console.error('Error:', JSON.stringify(e.error, null, 2));
    });
    process.exit(1);
  }
  
  console.log('\n✓ All messages passed AI SDK schema validation');
  
} catch (error) {
  console.error('✗ Failed:', error.message);
  process.exit(1);
}

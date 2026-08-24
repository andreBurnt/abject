import { AntigravityCliProvider } from '../src/llm/antigravity-cli.js';
import { systemMessage, userMessage } from '../src/llm/provider.js';

async function main() {
  console.log('Testing AntigravityCliProvider...');
  const provider = new AntigravityCliProvider();
  const res = await provider.complete(
    [
      systemMessage('You are a test helper. Reply with ONE word: PONG'),
      userMessage('PING'),
    ],
    { tier: 'code', maxTokens: 50 }
  );
  console.log('Result:', JSON.stringify(res));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

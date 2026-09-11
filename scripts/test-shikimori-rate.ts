import 'dotenv/config';
import { getTokens, saveTokens } from '../src/db/database.js';
import { upsertUserRate } from '../src/services/shikimori.js';

async function main() {
  console.log('Checking Shikimori tokens in SQLite...');
  let tokens = getTokens('shikimori');

  if (!tokens && process.env.SHIKIMORI_ACCESS_TOKEN && process.env.SHIKIMORI_REFRESH_TOKEN) {
    console.log('Initializing SQLite tokens from .env...');
    saveTokens(
      'shikimori',
      process.env.SHIKIMORI_ACCESS_TOKEN,
      process.env.SHIKIMORI_REFRESH_TOKEN,
      86400
    );
    tokens = getTokens('shikimori');
  }

  if (!tokens) {
    throw new Error('Shikimori tokens were not found in SQLite or .env.');
  }

  const userId = Number(process.env.SHIKIMORI_USER_ID);
  if (!userId) {
    throw new Error('SHIKIMORI_USER_ID is missing in .env.');
  }

  console.log('Sending test user_rate to Shikimori...');
  const result = await upsertUserRate({
    user_id: userId,
    target_id: 37105,
    target_type: 'Anime',
    status: 'watching',
    episodes: 1,
  });

  console.log('Shikimori user_rate updated successfully:', result);
}

main().catch((error: any) => {
  console.error('Shikimori test failed:', error?.response?.data || error?.message || error);
  process.exit(1);
});

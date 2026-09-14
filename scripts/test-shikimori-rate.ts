import 'dotenv/config';
import { getTokens, saveTokens } from '../src/db/database.js';
import { upsertUserRate } from '../src/services/shikimori.js';

async function main() {
  console.log('Checking Shikimori tokens in SQLite...');
  let tokens = getTokens('shikimori');

  if (process.env.SHIKIMORI_ACCESS_TOKEN && process.env.SHIKIMORI_REFRESH_TOKEN) {
    console.log('Synchronizing SQLite tokens from .env...');
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
  const status = error?.response?.status;
  const errCode = error?.response?.data?.error;
  const errMsg = error?.message || '';

  const isAuthIssue =
    status === 400 ||
    status === 401 ||
    errCode === 'invalid_grant' ||
    errCode === 'unauthorized' ||
    errMsg.includes('tokens were not found') ||
    errMsg.includes('SHIKIMORI_USER_ID is missing');

  if (isAuthIssue) {
    console.warn(
      '[WARN] Shikimori токен не активен. Бот запустится в гостевом режиме (только чтение). Для авторизации используйте OAuth вход в веб-интерфейсе.'
    );
    process.exit(0);
  }

  console.error('Shikimori test failed:', error?.response?.data || error?.message || error);
  process.exit(1);
});

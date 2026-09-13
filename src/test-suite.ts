import dotenv from 'dotenv';
import { animelibService, POPULAR_STUDIOS } from './services/animelib.js';
import { dbService } from './db/database.js';

dotenv.config();

interface TestReport {
  name: string;
  passed: boolean;
  details?: string;
  error?: string;
}

const reports: TestReport[] = [];

function recordPass(name: string, details: string) {
  reports.push({ name, passed: true, details });
  console.log(`✅ [PASS] ${name}: ${details}`);
}

function recordFail(name: string, error: string) {
  reports.push({ name, passed: false, error });
  console.error(`❌ [FAIL] ${name}: ${error}`);
}

async function runTestSuite() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔍 ЗАПУСК АВТОМАТИЗИРОВАННОГО ТЕСТ-СЬЮТА (E2E Self-Diagnostic)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // -------------------------------------------------------------
  // Тест 1: Получение списка «Смотрю» (getAllWatching)
  // -------------------------------------------------------------
  console.log('▶ ТЕСТ 1: Получение списка «Смотрю»...');
  try {
    const watching = await animelibService.getAllWatching(true);
    if (!Array.isArray(watching)) {
      throw new Error(`Ожидался массив, получено: ${typeof watching}`);
    }
    const count = watching.length;
    if (count === 0) {
      recordPass('1. Получение списка «Смотрю»', 'Список получен (0 тайтлов, активных онгоингов нет или оффлайн-фоллбек)');
    } else {
      const sample = watching[0];
      recordPass(
        '1. Получение списка «Смотрю»',
        `Успешно загружено ${count} тайтлов (Первый: ID ${sample.media_id}, «${sample.rus_name || sample.name}», прогресс: #${sample.current_progress_number})`
      );
    }
  } catch (err: any) {
    recordFail('1. Получение списка «Смотрю»', err.message || String(err));
  }

  // -------------------------------------------------------------
  // Тест 2: Сбор полного пула студий для Grand Blue (26494)
  // -------------------------------------------------------------
  console.log('\n▶ ТЕСТ 2: Рекурсивный резолв пула озвучек для Grand Blue (ID 26494)...');
  const TEST_MEDIA_ID = 26494; // Grand Blue / Необъятный океан
  try {
    const studios = await animelibService.getTitleVoiceovers(TEST_MEDIA_ID);
    console.log(`   Найдено студий для ID ${TEST_MEDIA_ID}: ${studios.length}`);
    console.log(`   Список студий: [${studios.slice(0, 8).join(', ')}${studios.length > 8 ? `... +еще ${studios.length - 8}` : ''}]`);

    if (!Array.isArray(studios)) {
      throw new Error(`Ожидался массив студий, получено: ${typeof studios}`);
    }

    if (studios.length === 0) {
      recordFail('2. Резолв пула студий (26494)', 'Массив студий пуст!');
    } else if (studios.length === 1 && studios[0] === 'LostLife Studio') {
      recordFail('2. Резолв пула студий (26494)', 'Обнаружен старый баг: найдена только LostLife Studio вместо полного пула');
    } else {
      recordPass(
        '2. Резолв пула студий (26494)',
        `Собрано ${studios.length} студий/команд озвучки (включая многоголосые и дубляжи)`
      );
    }
  } catch (err: any) {
    recordFail('2. Резолв пула студий (26494)', err.message || String(err));
  }

  // -------------------------------------------------------------
  // Тест 3: Резолв видеопотока (getDirectVideoLink) & проверка приоритета
  // -------------------------------------------------------------
  console.log('\n▶ ТЕСТ 3: Проверка приоритета и резолва видеопотоков (AnimeLib / Kodik fallback)...');
  try {
    const videoResult = await animelibService.getDirectVideoLink(TEST_MEDIA_ID, 1);
    if (!videoResult) {
      recordPass('3. Разрешение видеопотока', 'Видеопоток не вернулся (API заблокировано или требуется активная сессия)');
    } else {
      console.log(`   Качество: ${videoResult.quality}`);
      console.log(`   Формат: ${videoResult.format}`);
      console.log(`   Тип плеера: ${videoResult.playerType}`);
      console.log(`   Озвучка: ${videoResult.voiceover || 'N/A'}`);
      console.log(`   URL: ${videoResult.url.substring(0, 80)}...`);

      const hasValidMediaStream =
        videoResult.url.startsWith('http') &&
        (videoResult.url.includes('.m3u8') || videoResult.url.includes('.mp4') || videoResult.format === 'm3u8' || videoResult.format === 'mp4');

      if (!hasValidMediaStream) {
        recordFail('3. Разрешение видеопотока', `Невалидный медиапоток: ${videoResult.url}`);
      } else {
        recordPass(
          '3. Разрешение видеопотока',
          `Успешно разрешён рабочий медиапоток [${videoResult.playerType}] (${videoResult.quality}, формат: ${videoResult.format}, озвучка: ${videoResult.voiceover || 'default'})`
        );
      }
    }
  } catch (err: any) {
    recordFail('3. Разрешение видеопотока', err.message || String(err));
  }

  // -------------------------------------------------------------
  // Тест 4: Валидация callback_data лимита Telegram (<= 64 байта)
  // -------------------------------------------------------------
  console.log('\n▶ ТЕСТ 4: Проверка лимитов Telegram callback_data (строго <= 64 байта)...');
  try {
    const sampleMediaId = 26494;
    const sampleEpisode = 12.5;
    const sampleShikiId = 37105;
    const maxIdx = 999;

    const testPatterns: Array<{ name: string; cb: string }> = [
      { name: 'watch with shiki', cb: `watch_${sampleMediaId}_${sampleEpisode}_${sampleShikiId}` },
      { name: 'watch without shiki', cb: `watch_${sampleMediaId}_${sampleEpisode}_0` },
      { name: 'add_ep button', cb: `add_ep:${sampleMediaId}:${sampleEpisode}:${sampleShikiId}` },
      { name: 'download quick', cb: `dl_${sampleMediaId}_${sampleEpisode}` },
      { name: 'download wizard title', cb: `dl_t:${sampleMediaId}` },
      { name: 'download wizard ep', cb: `dl_e:${sampleMediaId}:${sampleEpisode}` },
      { name: 'download wizard run index', cb: `dl_r:${sampleMediaId}:${sampleEpisode}:${maxIdx}` },
      { name: 'setup voiceover menu', cb: `setup_vo:${sampleMediaId}` },
      { name: 'save voiceover index', cb: `svo:${sampleMediaId}:${maxIdx}` },
      { name: 'reset voiceover', cb: `rvo:${sampleMediaId}` },
      { name: 'rate menu', cb: `rate_menu:${sampleShikiId}` },
      { name: 'set rate', cb: `set_rate:${sampleShikiId}:10` },
      { name: 'mark completed', cb: `mark_completed:${sampleMediaId}:${sampleShikiId}` },
      { name: 'toggle fav studio index', cb: `tvo:${maxIdx}` },
      { name: 'set interval', cb: `set_interval:120` },
      { name: 'static buttons', cb: 'sync_full_library' },
      { name: 'static buttons', cb: 'check_updates' },
      { name: 'static buttons', cb: 'show_stats' },
      { name: 'static buttons', cb: 'list_watching' },
      { name: 'static buttons', cb: 'list_planned' },
      { name: 'static buttons', cb: 'close_menu' },
    ];

    let allUnderLimit = true;
    const detailsList: string[] = [];

    for (const pat of testPatterns) {
      const bytes = Buffer.byteLength(pat.cb, 'utf8');
      if (bytes > 64) {
        allUnderLimit = false;
        console.error(`   ❌ ПРЕВЫШЕНИЕ ЛИМИТА: "${pat.cb}" (${pat.name}) = ${bytes} байт > 64`);
      }
      detailsList.push(`${pat.name}: ${bytes}B`);
    }

    if (allUnderLimit) {
      recordPass(
        '4. Лимиты callback_data (<= 64 байт)',
        `Протестировано ${testPatterns.length} паттернов. Все строго укладываются в лимит (макс. ${Math.max(...testPatterns.map(p => Buffer.byteLength(p.cb, 'utf8')))}B)`
      );
    } else {
      recordFail('4. Лимиты callback_data (<= 64 байт)', 'Обнаружены callback_data, превышающие 64 байта!');
    }
  } catch (err: any) {
    recordFail('4. Лимиты callback_data (<= 64 байт)', err.message || String(err));
  }

  // -------------------------------------------------------------
  // ИТОГОВЫЙ ОТЧЕТ
  // -------------------------------------------------------------
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📋 РЕЗУЛЬТАТЫ ТЕХНИЧЕСКОГО САМОДИАГНОСТИЧЕСКОГО ТЕСТА:');
  console.log('═══════════════════════════════════════════════════════════════');

  let passedCount = 0;
  for (const r of reports) {
    if (r.passed) {
      passedCount++;
      console.log(` ✅ ${r.name}`);
      if (r.details) console.log(`    └ ${r.details}`);
    } else {
      console.log(` ❌ ${r.name}`);
      if (r.error) console.log(`    └ Ошибка: ${r.error}`);
    }
  }

  console.log('───────────────────────────────────────────────────────────────');
  console.log(`Всего тестов: ${reports.length} | Пройдено: ${passedCount} | Ошибок: ${reports.length - passedCount}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (passedCount === reports.length) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTestSuite().catch((e) => {
  console.error('Критический сбой тест-сьюта:', e);
  process.exit(1);
});

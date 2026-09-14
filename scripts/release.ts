import 'dotenv/config';
import axios, { AxiosError } from 'axios';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';

interface GitHubReleaseResponse {
  html_url: string;
  tag_name: string;
  name: string;
}

function extractLastChangesEntry(): string | null {
  const changesPath = path.resolve(process.cwd(), 'CHANGES.md');
  if (!existsSync(changesPath)) {
    return null;
  }

  try {
    const content = readFileSync(changesPath, 'utf-8');
    const sections = content.split(/\n(?=##\s+)/);
    for (const section of sections) {
      if (section.trim().startsWith('## ')) {
        return section.trim();
      }
    }
    return content.trim().slice(0, 1500);
  } catch {
    return null;
  }
}

function getRecentGitCommits(count: number = 7): string {
  try {
    const raw = execSync(`git log -n ${count} --pretty=format:"* %s (%h)"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.trim();
  } catch {
    return '* Регулярное обновление и стабилизация кодовой базы';
  }
}

async function runReleaseWizard(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log('\n===========================================================================');
    console.log('       A N I M E   T R A C K E R   H U B   //   RELEASE WIZARD');
    console.log('===========================================================================\n');

    const githubPat = process.env.GITHUB_PAT?.trim();
    const githubOwner = process.env.GITHUB_OWNER?.trim();
    const githubRepo = process.env.GITHUB_REPO?.trim();
    const githubBranch =
      process.env.GITHUB_BRANCH?.trim() || 'feat/ai-github-bridge';

    if (!githubPat) {
      console.error('❌ ОШИБКА: GITHUB_PAT не задан в .env файле.');
      console.error('Укажите корректный Personal Access Token (GITHUB_PAT) в файле .env для публикации релиза.\n');
      process.exitCode = 1;
      return;
    }

    if (!githubOwner || !githubRepo) {
      console.error('❌ ОШИБКА: GITHUB_OWNER или GITHUB_REPO не заданы в .env файле.');
      console.error('Пример: GITHUB_OWNER=boykonik, GITHUB_REPO=anime-tracker\n');
      process.exitCode = 1;
      return;
    }

    console.log(`📦 Репозиторий : ${githubOwner}/${githubRepo}`);
    console.log(`🌿 Ветка       : ${githubBranch}\n`);

    // 1) Ввод тега версии
    let version = '';
    while (!version) {
      const answer = await rl.question('1) Введите тег версии (например: v2.1.2): ');
      const trimmed = answer.trim();
      if (!trimmed) {
        console.log('⚠️  Тег версии не может быть пустым. Попробуйте еще раз.\n');
      } else {
        version = trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
      }
    }

    // 2) Ввод названия релиза
    const defaultTitle = `Anime Tracker Hub ${version}`;
    const rawTitle = await rl.question(
      `2) Введите название релиза [по умолчанию: "${defaultTitle}"]: `
    );
    const title = rawTitle.trim() || defaultTitle;

    // 3) Выбор источника описания (Notes Mode)
    console.log('\n3) Выберите источник описания (Release Notes):');
    console.log('   [1] Ввести вручную (одной или несколькими строками)');
    console.log('   [2] Автоматически извлечь последнюю запись из CHANGES.md');
    console.log('   [3] Автоматически сгенерировать из последних git-коммитов');

    let notes = '';
    while (!notes) {
      const mode = (await rl.question('\nВыберите вариант [1-3]: ')).trim();

      if (mode === '1') {
        console.log('\nВведите текст описания. Для завершения ввода введите пустую строку на новой строке:');
        const lines: string[] = [];
        while (true) {
          const line = await rl.question('> ');
          if (!line && lines.length > 0) {
            break;
          }
          if (line) {
            lines.push(line);
          } else if (lines.length === 0) {
            console.log('Текст не может быть пустым. Введите хотя бы одну строку:');
          }
        }
        notes = lines.join('\n');
      } else if (mode === '2') {
        const changesEntry = extractLastChangesEntry();
        if (changesEntry) {
          notes = changesEntry;
          console.log('\n📄 Извлечено из CHANGES.md:\n----------------------------------------');
          console.log(notes);
          console.log('----------------------------------------');
        } else {
          console.log('⚠️ Файл CHANGES.md не найден или пуст. Переключаюсь на генерацию из git коммитов...');
          notes = getRecentGitCommits(7);
          console.log('\n📄 Сгенерировано из git log:\n----------------------------------------');
          console.log(notes);
          console.log('----------------------------------------');
        }
      } else if (mode === '3') {
        notes = getRecentGitCommits(7);
        console.log('\n📄 Сгенерировано из последних git-коммитов:\n----------------------------------------');
        console.log(notes);
        console.log('----------------------------------------');
      } else {
        console.log('⚠️ Пожалуйста, введите цифру 1, 2 или 3.');
      }
    }

    // 4) Запрос подтверждения
    console.log('\n---------------------------------------------------------------------------');
    console.log('Параметры релиза:');
    console.log(`• Тег:      ${version}`);
    console.log(`• Ветка:    ${githubBranch}`);
    console.log(`• Название: ${title}`);
    console.log('---------------------------------------------------------------------------');

    const confirm = (await rl.question('\nСоздать релиз на GitHub? (y/n): ')).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes' && confirm !== 'д' && confirm !== 'да') {
      console.log('\n🚫 Создание релиза отменено пользователем.');
      return;
    }

    console.log('\n🚀 Публикация релиза на GitHub...');

    const response = await axios.post<GitHubReleaseResponse>(
      `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases`,
      {
        tag_name: version,
        target_commitish: githubBranch,
        name: title,
        body: notes,
        draft: false,
        prerelease: false,
      },
      {
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    console.log('\n===========================================================================');
    console.log('✅ Релиз успешно опубликован!');
    console.log(`🔗 Ссылка: ${response.data.html_url}`);
    console.log(`🏷️ Тег:    ${response.data.tag_name}`);
    console.log('===========================================================================\n');
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const axiosErr = error as AxiosError<{ message?: string; errors?: Array<{ message?: string; code?: string }> }>;
      const status = axiosErr.response?.status;
      const apiMsg = axiosErr.response?.data?.message || axiosErr.message;
      const details = axiosErr.response?.data?.errors?.map((e) => e.message || e.code).filter(Boolean).join(', ');

      console.error(`\n❌ Ошибка GitHub API [Status: ${status || 'Unknown'}]: ${apiMsg}`);
      if (details) {
        console.error(`Детали: ${details}`);
      }
    } else if (error instanceof Error) {
      console.error(`\n❌ Ошибка: ${error.message}`);
    } else {
      console.error('\n❌ Неизвестная ошибка при публикации релиза');
    }
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

void runReleaseWizard();

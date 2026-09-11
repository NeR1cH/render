import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const geminiApiKey = process.env.GEMINI_API_KEY;
const githubPat = process.env.GITHUB_PAT;
const githubOwner = process.env.GITHUB_OWNER;
const githubRepo = process.env.GITHUB_REPO;
const githubBranch = process.env.GITHUB_BRANCH || 'master';

const missingConfig = [
  ['GEMINI_API_KEY', geminiApiKey],
  ['GITHUB_PAT', githubPat],
  ['GITHUB_OWNER', githubOwner],
  ['GITHUB_REPO', githubRepo],
].filter(([, value]) => !value).map(([name]) => name);

if (missingConfig.length > 0) {
  throw new Error(`Missing bridge configuration in .env: ${missingConfig.join(', ')}`);
}

const github = axios.create({
  baseURL: `https://api.github.com/repos/${githubOwner}/${githubRepo}`,
  headers: {
    Authorization: `Bearer ${githubPat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

const forbiddenNames = new Set([
  '.env',
  '.env.example',
  '.env.local',
  '.continueignore',
  '.gitignore',
]);
const forbiddenExtensions = ['.db', '.sqlite', '.sqlite3', '.key', '.pem'];
const secretPatterns = [/-----BEGIN .* PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9_]+/, /github_pat_[A-Za-z0-9_]+/, /Bearer\s+eyJ[A-Za-z0-9_-]+/];

function assertSafePath(filePath: string): void {
  const normalized = filePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const fileName = segments.at(-1) || '';

  if (!normalized || normalized.startsWith('/') || segments.includes('..') || forbiddenNames.has(fileName)) {
    throw new Error(`Blocked unsafe path: ${filePath}`);
  }
  if (forbiddenExtensions.some((extension) => normalized.toLowerCase().endsWith(extension))) {
    throw new Error(`Blocked sensitive file extension: ${filePath}`);
  }
}

function assertSafeContent(content: string): void {
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    throw new Error('Blocked content that looks like a credential or private key.');
  }
}

function promptConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  return rl.question(`${question} (y/N): `).then((answer) => {
    rl.close();
    return answer.trim().toLowerCase() === 'y';
  });
}

async function commitFile(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args.path || '');
  const content = String(args.content || '');
  const message = String(args.message || '');
  const branch = String(args.branch || githubBranch);

  assertSafePath(filePath);
  assertSafeContent(content);
  if (!message.trim()) throw new Error('Commit message is required.');

  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  let sha: string | undefined;
  try {
    const current = await github.get(`/contents/${encodedPath}`, { params: { ref: branch } });
    sha = current.data.sha;
  } catch (error: any) {
    if (error.response?.status !== 404) throw error;
  }

  console.log(`\nFile: ${filePath}\nBranch: ${branch}\nCommit: ${message}`);
  if (!(await promptConfirmation('Apply this GitHub commit?'))) return 'Commit cancelled by user.';

  const response = await github.put(`/contents/${encodedPath}`, {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  return `Committed ${filePath}: ${response.data.commit.sha}`;
}

async function createRelease(args: Record<string, unknown>): Promise<string> {
  const tagName = String(args.tag_name || '');
  const title = String(args.title || tagName);
  const notes = String(args.notes || '');
  const target = String(args.target_commitish || githubBranch);

  if (!/^v?\d+\.\d+\.\d+$/.test(tagName)) throw new Error(`Invalid release tag: ${tagName}`);
  if (!notes.trim()) throw new Error('Release notes are required.');

  console.log(`\nRelease: ${tagName}\nTitle: ${title}\nTarget: ${target}\n\n${notes}`);
  if (!(await promptConfirmation('Publish this GitHub release?'))) return 'Release cancelled by user.';

  const response = await github.post('/releases', {
    tag_name: tagName,
    name: title,
    body: notes,
    target_commitish: target,
    draft: false,
    prerelease: false,
  });
  return `Release published: ${response.data.html_url}`;
}

const commitFileTool = {
  name: 'commit_file',
  description: 'Create or update one safe text file in the configured GitHub repository.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: 'Repository-relative file path.' },
      content: { type: Type.STRING, description: 'Complete UTF-8 text content.' },
      message: { type: Type.STRING, description: 'Conventional Commit message.' },
      branch: { type: Type.STRING, description: 'Target branch; defaults to GITHUB_BRANCH.' },
    },
    required: ['path', 'content', 'message'],
  },
};

const releaseTool = {
  name: 'create_release',
  description: 'Publish a GitHub Release after all changes are already committed.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tag_name: { type: Type.STRING, description: 'Semantic version tag such as v1.2.0.' },
      title: { type: Type.STRING, description: 'Release title.' },
      notes: { type: Type.STRING, description: 'Release notes.' },
      target_commitish: { type: Type.STRING, description: 'Branch or commit; defaults to GITHUB_BRANCH.' },
    },
    required: ['tag_name', 'title', 'notes'],
  },
};

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) {
    console.log('Usage: pnpm ai:bridge "Describe the requested change"');
    return;
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: prompt,
    config: {
      systemInstruction: 'You maintain this TypeScript repository. Never request secrets or modify environment, database, or Git metadata files. Ask for clarification when the full file content is unavailable.',
      tools: [{ functionDeclarations: [commitFileTool, releaseTool] }],
    },
  });

  const calls = response.functionCalls || [];
  if (calls.length === 0) {
    console.log(response.text || 'The model returned no text.');
    return;
  }

  for (const call of calls) {
    try {
      const result = call.name === 'commit_file'
        ? await commitFile(call.args as Record<string, unknown>)
        : call.name === 'create_release'
          ? await createRelease(call.args as Record<string, unknown>)
          : `Unknown function: ${call.name}`;
      console.log(result);
    } catch (error: any) {
      console.error(`Bridge action failed: ${error.response?.data?.message || error.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: any) => {
  console.error(`Bridge failed: ${error.message}`);
  process.exitCode = 1;
});

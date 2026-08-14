import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const repositoryRoot = new URL('../', import.meta.url);
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules', 'playwright-report', 'test-results']);
const textExtensions = new Set(['.css', '.html', '.json', '.md', '.mjs', '.ts', '.tsx']);
const errors = [];

async function collectFiles(relativeDirectory) {
  const directory = new URL(`${relativeDirectory}/`, repositoryRoot);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // Untracked directories such as `docs/` are absent in a fresh clone; nothing there to lint.
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await collectFiles(join(relativeDirectory, entry.name)));
      }
    } else if (textExtensions.has(extname(entry.name))) {
      files.push(join(relativeDirectory, entry.name));
    }
  }
  return files;
}

async function read(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), 'utf8');
}

function report(relativePath, rule) {
  errors.push(`${relativePath}: ${rule}`);
}

const files = [
  ...await collectFiles('src'),
  ...await collectFiles('tests'),
  ...await collectFiles('public'),
  ...await collectFiles('docs'),
  ...await collectFiles('scripts'),
  'AGENTS.md',
  'README.md',
];

for (const relativePath of files) {
  const content = await read(relativePath);
  if (/\p{Extended_Pictographic}/u.test(content)) report(relativePath, 'emoji is not allowed');
  if ((relativePath.endsWith('.ts') || relativePath.endsWith('.tsx')) && /\bany\b/.test(content)) {
    report(relativePath, 'the any type is not allowed');
  }
  if (relativePath.startsWith('src/') && /chrome\.storage\.sync/.test(content)) {
    report(relativePath, 'chrome.storage.sync is not allowed');
  }
  if (relativePath.startsWith('src/ui/') &&
      /(chrome\.(tabs|tabGroups)|api\.openai\.com|OpenAiClassifier)/.test(content)) {
    report(relativePath, 'UI architecture boundary violation');
  }
  if ((relativePath.startsWith('src/') || relativePath.startsWith('public/')) &&
      /sk-[A-Za-z0-9_-]{20,}/.test(content)) {
    report(relativePath, 'possible packaged API key');
  }
}

const localeCatalogs = await Promise.all(['en', 'ko', 'ja'].map(async (locale) => {
  const content = await read(`public/_locales/${locale}/messages.json`);
  return { locale, keys: Object.keys(JSON.parse(content)).sort() };
}));
const englishKeys = JSON.stringify(localeCatalogs[0].keys);
for (const catalog of localeCatalogs.slice(1)) {
  if (JSON.stringify(catalog.keys) !== englishKeys) {
    report(`public/_locales/${catalog.locale}/messages.json`, 'locale keys differ from English');
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log('Repository lint passed.');
}

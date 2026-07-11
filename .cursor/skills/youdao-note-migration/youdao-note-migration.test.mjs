import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rename, utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildMigrationPaths,
  loadRules,
  RULES_FILENAME,
  SKILL_DIR_SEGMENTS,
  skillDirectory,
} from './lib/paths.mjs';
import {
  extractImages,
  parseSearchCandidates,
} from './lib/images.mjs';
import { isGloballyRoutableAddress } from './lib/network.mjs';
import {
  acquireCacheLock,
  cacheNote,
  cachePublicShare,
} from './lib/cache.mjs';
import {
  parseReadResponse,
  preflightYoudao,
  readYoudaoNote,
} from './lib/youdao.mjs';
import {
  assertShareId,
  parsePublicShareResponse,
  readPublicShare,
} from './lib/public-share.mjs';
import { runCli } from './lib/cli.mjs';
import {
  validateDraftMetadata,
  validateDraftOutput,
} from './lib/draft-validator.mjs';

const execFileAsync = promisify(execFile);
const skillRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(skillRoot, '../../..');
const CLI_SCRIPT = path.join('.cursor', 'skills', 'youdao-note-migration', 'youdao-note-migration.mjs');
const RULES_REPO_PATH = path.posix.join(...SKILL_DIR_SEGMENTS, RULES_FILENAME);
const DRAFT_TEMPLATE_PATH = path.join(skillRoot, 'youdao-note-migration-draft-template.json');
const defaultRules = {
  version: 1,
  cacheRoot: '.tmp',
  contentRoot: 'content/notes',
  imageRoot: 'static/images/notes',
  branchTemplate: 'docs/{category}-{slug}',
  commitTemplate: 'docs: 新增 {title} 学习笔记',
  approvalUserId: 'wunianor',
};
const draftValidationOptions = { approvalUserId: defaultRules.approvalUserId };

test('rejects every IPv4 special-purpose range while allowing public addresses', () => {
  const specialPurposeAddresses = [
    '0.1.2.3',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.88.99.1',
    '192.168.1.1',
    '192.175.48.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ];

  for (const address of specialPurposeAddresses) {
    assert.equal(isGloballyRoutableAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '223.255.255.254']) {
    assert.equal(isGloballyRoutableAddress(address), true, address);
  }
});

test('rejects configured IPv6 special-use ranges while allowing global unicast addresses', () => {
  for (const address of [
    '::1',
    'fe80::1',
    'fc00::1',
    'ff00::1',
    '2001:db8::1',
    '2001:2::1',
    '2001:10::1',
    '2002::1',
    '3fff::1',
    '3fff:0fff::1',
  ]) {
    assert.equal(isGloballyRoutableAddress(address), false, address);
  }
  for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111', '3fff:1000::1']) {
    assert.equal(isGloballyRoutableAddress(address), true, address);
  }
});

function writeRulesFixture(temporaryRoot, overrides = {}) {
  const directory = skillDirectory(temporaryRoot);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, RULES_FILENAME),
    JSON.stringify({ ...defaultRules, ...overrides }),
  );
}

function withTemporaryRules(overrides, verify) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'youdao-note-migration-'));

  try {
    writeRulesFixture(temporaryRoot, overrides);
    verify(temporaryRoot);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

test('loads the versioned Youdao note migration rules', () => {
  const rules = loadRules(repoRoot);

  assert.deepEqual(rules, defaultRules);
});

test('rejects traversal segments in configured output roots', () => {
  for (const rootField of ['cacheRoot', 'contentRoot', 'imageRoot']) {
    withTemporaryRules({ [rootField]: '../../outside' }, (temporaryRoot) => {
      assert.throws(
        () => loadRules(temporaryRoot),
        new RegExp(`${rootField}.*relative path segment`, 'i'),
      );
    });
  }
});

test('rejects absolute configured output roots', () => {
  for (const rootField of ['cacheRoot', 'contentRoot', 'imageRoot']) {
    withTemporaryRules({ [rootField]: path.resolve('outside') }, (temporaryRoot) => {
      assert.throws(
        () => loadRules(temporaryRoot),
        new RegExp(`${rootField}.*absolute`, 'i'),
      );
    });
  }
});

test('requires cacheRoot to be exactly the repository .tmp directory', () => {
  for (const cacheRoot of ['.', 'cache', '.tmp/nested']) {
    withTemporaryRules({ cacheRoot }, (temporaryRoot) => {
      assert.throws(
        () => loadRules(temporaryRoot),
        /cacheRoot.*exactly .tmp/i,
      );
    });
  }
});

test('requires an explicit configured approval user identifier', () => {
  withTemporaryRules({ approvalUserId: undefined }, (temporaryRoot) => {
    assert.throws(() => loadRules(temporaryRoot), /non-empty approvalUserId/i);
  });
});

test('builds exact cache and final migration paths', () => {
  const paths = buildMigrationPaths(
    {
      cacheRoot: '.tmp',
      contentRoot: 'content/notes',
      imageRoot: 'static/images/notes',
    },
    { categorySlug: 'linux', topicSlug: 'io-multiplexing', articleSlug: 'io-basics' },
  );

  assert.deepEqual(paths, {
    cacheRoot: '.tmp',
    cacheContentDir: '.tmp/content/notes/linux/io-multiplexing/io-basics',
    cacheImageDir: '.tmp/static/images/notes/linux/io-basics',
    contentDir: 'content/notes/linux/io-multiplexing',
    imageDir: 'static/images/notes/linux/io-basics',
  });
});

test('rejects traversal in migration slugs', () => {
  assert.throws(
    () =>
      buildMigrationPaths(
        {
          cacheRoot: '.tmp',
          contentRoot: 'content/notes',
          imageRoot: 'static/images/notes',
        },
        { categorySlug: 'linux', topicSlug: '../escape', articleSlug: 'io-basics' },
      ),
    /topicSlug.*relative path segment/i,
  );
});

test('CLI prints migration paths as formatted JSON', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      CLI_SCRIPT,
      'paths',
      '--category', 'linux', '--topic',
      'io-multiplexing',
      '--article',
      'io-basics',
    ],
    { cwd: repoRoot },
  );

  assert.equal(stderr, '');
  assert.equal(
    stdout,
    `${JSON.stringify(
      {
        cacheRoot: '.tmp',
        cacheContentDir: '.tmp/content/notes/linux/io-multiplexing/io-basics',
        cacheImageDir: '.tmp/static/images/notes/linux/io-basics',
        contentDir: 'content/notes/linux/io-multiplexing',
        imageDir: 'static/images/notes/linux/io-basics',
      },
      null,
      2,
    )}\n`,
  );
});

test('CLI exits nonzero for an unknown command', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_SCRIPT, 'unknown'], {
      cwd: repoRoot,
    }),
    (error) => error.code !== 0 && /Unknown command: unknown/.test(error.stderr),
  );
});

test('parses file candidates from youdaonote search output', () => {
  assert.deepEqual(
    parseSearchCandidates(
      [
        '📁 folder-1\tLinux',
        '📄 file-1\tI/O 多路复用',
        'not a result line',
        '📄 \tMissing id',
        '📄 file-2\t中文标题',
      ].join('\n'),
    ),
    [
      { id: 'file-1', title: 'I/O 多路复用' },
      { id: 'file-2', title: '中文标题' },
    ],
  );
});

test('reads JSON content and rejects incomplete responses', async () => {
  const execute = async () => ({ stdout: '{"content":"# Linux"}', stderr: '' });
  const note = await readYoudaoNote('note-1', { execute });

  assert.deepEqual(note, {
    rawJson: '{"content":"# Linux"}',
    content: '# Linux',
  });
  assert.throws(() => parseReadResponse('{"title":"Linux"}'), /content/i);
});

test('reads nonempty transformed plaintext and rejects only clearly object-JSON malformed output', async () => {
  const rawText = '25.1. IO 概念\n转换后的正文';
  const execute = async () => ({ stdout: rawText, stderr: '' });

  assert.deepEqual(await readYoudaoNote('note-1', { execute }), {
    rawText,
    content: rawText,
    sourceFormat: 'plain-text',
    isRaw: false,
  });
  assert.throws(() => parseReadResponse('{"content":'), /malformed JSON/i);
  for (const plainText of ['[intro](https://example.test)', '[not valid JSON]', '{not an object JSON}']) {
    assert.deepEqual(parseReadResponse(plainText), {
      rawText: plainText,
      content: plainText,
      sourceFormat: 'plain-text',
      isRaw: false,
    });
  }
  assert.throws(() => parseReadResponse(' \n\t '), /nonempty plaintext/i);
});

test('redacts credentials while preserving youdaonote failure context', async () => {
  const secret = 'sk-test-credential-should-never-appear';

  await assert.rejects(
    readYoudaoNote('note-1', {
      execute: async () => {
        const error = new Error(`Authorization: Bearer ${secret}`);
        error.code = 23;
        error.stderr = `apiKey=${secret}\ntoken=${secret}\nAuthorization: Bearer ${secret}`;
        throw error;
      },
    }),
    (error) =>
      !error.message.includes(secret) &&
      /youdaonote -s ydn read note-1 failed/.test(error.message) &&
      /exit code 23/.test(error.message),
  );
});

test('redacts JSON and quoted credential values in youdaonote errors', async () => {
  const secrets = [
    'json-token-must-not-leak',
    'json-api-key-must-not-leak',
    'json-password-must-not-leak',
    'json-secret-must-not-leak',
  ];

  await assert.rejects(
    readYoudaoNote('note-1', {
      execute: async () => {
        const error = new Error('youdaonote failed');
        error.code = 9;
        error.stderr = JSON.stringify({
          token: secrets[0],
          apiKey: secrets[1],
          password: secrets[2],
          secret: secrets[3],
          Authorization: `Bearer ${secrets[0]}`,
        });
        throw error;
      },
    }),
    (error) =>
      secrets.every((secret) => !error.message.includes(secret)) &&
      /youdaonote -s ydn read note-1 failed/.test(error.message) &&
      /exit code 9/.test(error.message),
  );
});

test('runs read-only preflight commands in required order', async () => {
  const calls = [];
  const output = await preflightYoudao({
    execute: async (argumentsList) => {
      calls.push(argumentsList);
      if (argumentsList[0] === 'version') {
        return { stdout: 'youdaonote 1.0.0\n', stderr: '' };
      }

      if (argumentsList[0] === 'check') {
        return { stdout: '{"ok":true,"token":"do-not-print"}', stderr: '' };
      }

      return { stdout: '/Linux\n', stderr: '' };
    },
  });

  assert.deepEqual(calls, [['list'], ['version'], ['check', '--json']]);
  assert.deepEqual(output, {
    version: 'youdaonote 1.0.0',
    healthCheck: { ok: true },
    rootsListed: true,
  });
});

test('extracts deduplicated HTTP Markdown and HTML images in source order', () => {
  assert.deepEqual(
    extractImages([
      '![first](https://example.test/one.png)',
      '<img alt="second" src="https://example.test/two.jpg">',
      '![duplicate](https://example.test/one.png)',
      '![local](file:///tmp/three.png)',
      '<img src="data:image/png;base64,abc">',
    ].join('\n')),
    [
      { alt: 'first', sourceUrl: 'https://example.test/one.png' },
      { alt: 'second', sourceUrl: 'https://example.test/two.jpg' },
    ],
  );
});

test('preserves balanced parentheses in Markdown and HTML image URLs', () => {
  assert.deepEqual(
    extractImages([
      '![chart](https://cdn.example.test/a_(1).png)',
      '<img alt="same" src="https://cdn.example.test/a_(1).png">',
      '<img src="https://cdn.example.test/b_(2).jpg">',
    ].join('\n')),
    [
      { alt: 'chart', sourceUrl: 'https://cdn.example.test/a_(1).png' },
      { alt: '', sourceUrl: 'https://cdn.example.test/b_(2).jpg' },
    ],
  );
});

async function withTemporaryCache(verify) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-cache-'));
  try {
    await verify(temporaryRoot);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function cacheImage(temporaryRoot, sourceUrl, options = {}) {
  return cacheNote({
    repoRoot: temporaryRoot,
    rules: defaultRules,
    categorySlug: 'linux', topicSlug: 'io-multiplexing',
    articleSlug: 'io-basics',
    note: {
      id: 'note-1',
      rawJson: JSON.stringify({ content: `![image](${sourceUrl})` }),
      content: `![image](${sourceUrl})`,
    },
    ...options,
  });
}

test('rejects local and private image hosts before fetching', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return new Response('image');
    };

    await assert.rejects(
      cacheImage(temporaryRoot, 'http://localhost/image.png', { fetchImpl }),
      /public/i,
    );
    await assert.rejects(
      cacheImage(temporaryRoot, 'http://10.0.0.8/image.png', { fetchImpl }),
      /public/i,
    );
    await assert.rejects(
      cacheImage(temporaryRoot, 'http://[fe90::1]/image.png', { fetchImpl }),
      /public/i,
    );
    await assert.rejects(
      cacheImage(temporaryRoot, 'http://[::]/image.png', { fetchImpl }),
      /public/i,
    );
    await assert.rejects(
      cacheImage(temporaryRoot, 'http://[ff02::1]/image.png', { fetchImpl }),
      /public/i,
    );
    await assert.equal(fetchCalls, 0);
  });
});

test('rejects image hosts whose DNS result is private', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/image.png', {
        fetchImpl: async () => new Response('image'),
        resolveHost: async () => [{ address: '192.168.1.20' }],
      }),
      /public/i,
    );
  });
});

test('uses redirect errors and rejects oversized image responses', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    let redirectMode;
    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/image.png', {
        fetchImpl: async (_url, options) => {
          redirectMode = options?.redirect;
          return new Response('', { status: 302, headers: { location: 'https://other.test/x' } });
        },
        resolveHost: async () => [{ address: '8.8.8.8' }],
      }),
      /redirect/i,
    );
    assert.equal(redirectMode, 'error');

    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/large.png', {
        fetchImpl: async () => new Response(Buffer.alloc(1025)),
        resolveHost: async () => [{ address: '8.8.8.8' }],
        maxResponseBytes: 1024,
      }),
      /too large/i,
    );
  });
});

test('aborts an image fetch after its configured timeout', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const pending = cacheImage(temporaryRoot, 'https://cdn.example.test/slow.png', {
      fetchImpl: async (_url, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      resolveHost: async () => [{ address: '8.8.8.8' }],
      timeoutMs: 10,
    });
    const result = Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout')), 100)),
    ]);

    await assert.rejects(result, /timed out/i);
  });
});

test('redacts image URL credentials from download errors', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const secret = 'signed-url-secret';
    await assert.rejects(
      cacheImage(
        temporaryRoot,
        `https://user:pass@cdn.example.test/image.png?token=${secret}`,
        {
          fetchImpl: async () => new Response('missing', { status: 404 }),
          resolveHost: async () => [{ address: '8.8.8.8' }],
        },
      ),
      (error) =>
        /HTTP 404/.test(error.message) &&
        !error.message.includes(secret) &&
        !error.message.includes('user:pass@'),
    );
  });
});

test('rejects IPv4-mapped IPv6 loopback image hosts', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    await assert.rejects(
      cacheImage(temporaryRoot, 'http://[::ffff:7f00:1]/image.png', {
        fetchImpl: async () => new Response('image'),
        resolveHost: async () => [{ address: '8.8.8.8' }],
      }),
      /public/i,
    );
  });
});

test('uses the DNS-verified address for streaming image requests', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    let requestOptions;
    await cacheImage(temporaryRoot, 'https://cdn.example.test/image.png', {
      requestImpl: async (_url, options) => {
        requestOptions = options;
        return {
          status: 200,
          headers: {},
          stream: Readable.from([Buffer.from('image')]),
          abort: () => {},
        };
      },
      resolveHost: async () => [{ address: '8.8.8.8' }],
    });
    assert.equal(requestOptions.address, '8.8.8.8');
    assert.equal(requestOptions.lookup('cdn.example.test'), '8.8.8.8');
  });
});

test('aborts streaming image downloads that exceed the byte limit', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    let aborted = false;
    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/large.png', {
        requestImpl: async () => ({
          status: 200,
          headers: {},
          stream: Readable.from([Buffer.from('123'), Buffer.from('456')]),
          abort: () => {
            aborted = true;
          },
        }),
        resolveHost: async () => [{ address: '8.8.8.8' }],
        maxResponseBytes: 5,
      }),
      /too large/i,
    );
    assert.equal(aborted, true);
  });
});

async function withHttpServer(handler, verify) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    await verify(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('caches source files, downloaded images, mirror, and provenance', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-cache-'));
  const imageBytes = Buffer.from('image fixture');

  try {
    await withHttpServer((request, response) => {
      if (request.url === '/diagram.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(imageBytes);
        return;
      }

      response.writeHead(404);
      response.end();
    }, async (baseUrl) => {
      const sourceUrl = 'https://cdn.example.test/diagram.png';
      const result = await cacheNote({
        repoRoot: temporaryRoot,
        rules: defaultRules,
        categorySlug: 'linux', topicSlug: 'io-multiplexing',
        articleSlug: 'io-basics',
        note: {
          id: 'note-1',
          rawJson: `{"content":"![图](${sourceUrl})"}`,
          content: `![图](${sourceUrl})`,
        },
        fetchImpl: () => fetch(`${baseUrl}/diagram.png`, { redirect: 'error' }),
        resolveHost: async () => [{ address: '8.8.8.8' }],
      });

      const cacheDirectory = path.join(
        temporaryRoot,
        '.tmp',
        'content',
        'notes',
        'linux',
        'io-multiplexing',
        'io-basics',
      );
      const originalImage = path.join(cacheDirectory, 'images', 'original', 'image-001.png');
      const mirroredImage = path.join(
        temporaryRoot,
        '.tmp',
        'static',
        'images',
        'notes',
        'linux',
        'io-basics',
        'image-001.png',
      );
      const provenance = JSON.parse(
        readFileSync(path.join(cacheDirectory, 'reports', 'provenance.json'), 'utf8'),
      );

      assert.equal(result.cacheDirectory, '.tmp/content/notes/linux/io-multiplexing/io-basics');
      assert.equal(result.imageCount, 1);
      assert.equal(
        readFileSync(path.join(cacheDirectory, 'source', 'note.json'), 'utf8'),
        `{"content":"![图](${sourceUrl})"}`,
      );
      assert.equal(
        readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8'),
        `![图](${sourceUrl})`,
      );
      assert.deepEqual(readFileSync(originalImage), imageBytes);
      assert.deepEqual(readFileSync(mirroredImage), imageBytes);
      assert.equal(provenance.source.id, 'note-1');
      assert.equal(provenance.source.sourceFormat, 'json-content');
      assert.equal(provenance.source.isRaw, true);
      assert.equal(provenance.images[0].localPath,
        '.tmp/content/notes/linux/io-multiplexing/io-basics/images/original/image-001.png');
      assert.match(provenance.images[0].sha256, /^[a-f0-9]{64}$/);
    });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('caches transformed plaintext without extracting or downloading embedded image syntax', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const rawText = '25.1. IO 概念\n![converted image](https://cdn.example.test/diagram.png)';
    let imageRequestAttempted = false;
    const result = await cacheNote({
      repoRoot: temporaryRoot,
      rules: defaultRules,
      categorySlug: 'linux', topicSlug: 'io-multiplexing',
      articleSlug: 'io-basics',
      note: {
        id: 'note-1',
        rawText,
        content: rawText,
        sourceFormat: 'plain-text',
        isRaw: false,
      },
      fetchImpl: async () => {
        imageRequestAttempted = true;
        throw new Error('plain text cache must not request images');
      },
    });
    const cacheDirectory = path.join(
      temporaryRoot,
      '.tmp',
      'content',
      'notes',
      'linux',
      'io-multiplexing',
      'io-basics',
    );
    const provenance = JSON.parse(
      readFileSync(path.join(cacheDirectory, 'reports', 'provenance.json'), 'utf8'),
    );

    assert.equal(result.imageCount, 0);
    assert.equal(imageRequestAttempted, false);
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'note.txt'), 'utf8'), rawText);
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8'), rawText);
    assert.equal(existsSync(path.join(cacheDirectory, 'source', 'note.json')), false);
    assert.deepEqual(provenance.source, {
      id: 'note-1',
      sourceFormat: 'plain-text',
      isRaw: false,
      fetchedAt: provenance.source.fetchedAt,
    });
    assert.deepEqual(provenance.images, []);
  });
});

test('rejects plain-text cache input whose preserved source differs from content', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    await assert.rejects(
      cacheNote({
        repoRoot: temporaryRoot,
        rules: defaultRules,
        categorySlug: 'linux', topicSlug: 'io-multiplexing',
        articleSlug: 'io-basics',
        note: {
          id: 'note-1',
          rawText: 'preserved output',
          content: 'normalized output',
          sourceFormat: 'plain-text',
          isRaw: false,
        },
      }),
      /rawText.*content/i,
    );
    assert.equal(existsSync(path.join(temporaryRoot, '.tmp')), false);
  });
});

test('fails cache creation when an image download has a non-success status', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-cache-'));

  try {
    await withHttpServer((request, response) => {
      response.writeHead(503);
      response.end('unavailable');
    }, async (baseUrl) => {
      const sourceUrl = 'https://cdn.example.test/missing.png';
      await assert.rejects(
        cacheNote({
          repoRoot: temporaryRoot,
          rules: defaultRules,
          categorySlug: 'linux', topicSlug: 'io-multiplexing',
          articleSlug: 'io-basics',
          note: {
            id: 'note-1',
            rawJson: '{"content":"missing"}',
            content: `![missing](${sourceUrl})`,
          },
          fetchImpl: () => fetch(`${baseUrl}/missing.png`, { redirect: 'error' }),
          resolveHost: async () => [{ address: '8.8.8.8' }],
        }),
        /HTTP 503/,
      );
    });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('publishes cache atomically and removes stale images on successful rerun', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-cache-'));
  const url = 'https://images.example.test';
  const cacheDirectory = path.join(
    temporaryRoot,
    '.tmp',
    'content',
    'notes',
    'linux',
    'io-multiplexing',
    'io-basics',
  );
  const originalDirectory = path.join(cacheDirectory, 'images', 'original');

  const response = (body, status = 200) => new Response(body, { status });
  const cache = (content, fetchImpl) =>
    cacheNote({
      repoRoot: temporaryRoot,
      rules: defaultRules,
      categorySlug: 'linux', topicSlug: 'io-multiplexing',
      articleSlug: 'io-basics',
      note: { id: 'note-1', rawJson: JSON.stringify({ content }), content },
      fetchImpl,
      resolveHost: async () => [{ address: '8.8.8.8' }],
    });

  try {
    await cache(
      `![old one](${url}/old-one.png)\n![old two](${url}/old-two.png)`,
      async () => response('old-image'),
    );
    const oldContent = readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8');
    const oldImage = readFileSync(path.join(originalDirectory, 'image-001.png'));

    await assert.rejects(
      cache(
        `![new one](${url}/new-one.png)\n![new two](${url}/new-two.png)`,
        async (sourceUrl) =>
          sourceUrl.endsWith('new-two.png') ? response('unavailable', 503) : response('new-image'),
      ),
      /HTTP 503/,
    );
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8'), oldContent);
    assert.deepEqual(readFileSync(path.join(originalDirectory, 'image-001.png')), oldImage);

    await cache(`![replacement](${url}/replacement.png)`, async () => response('replacement'));
    const provenance = JSON.parse(
      readFileSync(path.join(cacheDirectory, 'reports', 'provenance.json'), 'utf8'),
    );
    assert.equal(existsSync(path.join(originalDirectory, 'image-002.png')), false);
    assert.deepEqual(provenance.images.map((image) => image.sourceUrl), [`${url}/replacement.png`]);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('locks concurrent cache writes and marks completed cache pairs', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    let releaseFirstFetch;
    let markFirstFetchReached;
    const firstFetchReached = new Promise((resolve) => {
      markFirstFetchReached = resolve;
    });
    const first = cacheImage(temporaryRoot, 'https://cdn.example.test/first.png', {
      fetchImpl: () =>
        new Promise((resolve) => {
          releaseFirstFetch = () => resolve(new Response('first'));
          markFirstFetchReached();
        }),
      resolveHost: async () => [{ address: '8.8.8.8' }],
    });
    try {
      await firstFetchReached;
      await assert.rejects(
        cacheImage(temporaryRoot, 'https://cdn.example.test/second.png', {
          fetchImpl: async () => new Response('second'),
          resolveHost: async () => [{ address: '8.8.8.8' }],
        }),
        /already in progress/i,
      );
    } finally {
      releaseFirstFetch();
      await first;
    }

    const manifestPath = path.join(
      temporaryRoot,
      '.tmp',
      'content',
      'notes',
      'linux',
      'io-multiplexing',
      'io-basics',
      'reports',
      'cache-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.complete, true);
  });
});

test('rolls both cache trees back when mirror publication fails', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const options = {
      fetchImpl: async () => new Response('old'),
      resolveHost: async () => [{ address: '8.8.8.8' }],
    };
    await cacheImage(temporaryRoot, 'https://cdn.example.test/old.png', options);
    const cacheDirectory = path.join(
      temporaryRoot,
      '.tmp',
      'content',
      'notes',
      'linux',
      'io-multiplexing',
      'io-basics',
    );
    const mirrorImage = path.join(
      temporaryRoot,
      '.tmp',
      'static',
      'images',
      'notes',
      'linux',
      'io-basics',
      'image-001.png',
    );
    const oldContent = readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8');
    const oldMirror = readFileSync(mirrorImage);

    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/new.png', {
        ...options,
        renameImpl: async (from, to) => {
          if (to.endsWith(path.join('static', 'images', 'notes', 'linux', 'io-basics'))) {
            throw new Error('mirror publish failed');
          }
          return rename(from, to);
        },
      }),
      /mirror publish failed/,
    );
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8'), oldContent);
    assert.deepEqual(readFileSync(mirrorImage), oldMirror);
  });
});

test('keeps a published cache when backup cleanup only warns', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const options = {
      fetchImpl: async () => new Response('image'),
      resolveHost: async () => [{ address: '8.8.8.8' }],
      isProcessAlive: () => false,
    };
    await cacheImage(temporaryRoot, 'https://cdn.example.test/old.png', options);
    const result = await cacheImage(temporaryRoot, 'https://cdn.example.test/new.png', {
      ...options,
      cleanupBackup: async () => {
        throw new Error('cleanup unavailable');
      },
    });

    assert.match(result.warnings[0], /cleanup unavailable/);
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(
            temporaryRoot,
            '.tmp',
            'content',
            'notes',
            'linux',
            'io-multiplexing',
            'io-basics',
            'reports',
            'cache-manifest.json',
          ),
          'utf8',
        ),
      ).complete,
      true,
    );
  });
});

test('recovers stale shared locks and rejects active shared locks', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const lockDirectory = path.join(
      temporaryRoot,
      '.tmp',
      '.locks',
      'linux-io-multiplexing-io-basics.lock',
    );
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(
      path.join(lockDirectory, 'owner-stale.json'),
      JSON.stringify({ token: 'stale', pid: 1, createdAt: Date.now() - 16 * 60 * 1000, topic: 'old', article: 'io-basics' }),
    );
    await utimes(path.join(lockDirectory, 'owner-stale.json'), new Date(0), new Date(0));
    await cacheImage(temporaryRoot, 'https://cdn.example.test/image.png', {
      fetchImpl: async () => new Response('image'),
      resolveHost: async () => [{ address: '8.8.8.8' }],
      isProcessAlive: () => false,
    });
    assert.equal(existsSync(lockDirectory), false);

    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(
      path.join(lockDirectory, 'owner-active.json'),
      JSON.stringify({ token: 'active', pid: 1, createdAt: Date.now(), topic: 'current', article: 'io-basics' }),
    );
    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/next.png', {
        fetchImpl: async () => new Response('image'),
        resolveHost: async () => [{ address: '8.8.8.8' }],
      }),
      /already in progress/i,
    );
  });
});

test('lock ownership metadata stays immutable while heartbeat updates mtime', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linux-note-lock-'));
  const lockPath = path.join(root, 'article.lock');
  try {
    let now = 1_000;
    const lock = await acquireCacheLock(lockPath, { topic: 'linux', article: 'article' }, {
      now: () => now,
      randomUUID: () => 'owner-a',
      lockTtlMs: 100,
      heartbeatIntervalMs: 5,
    });
    const before = readFileSync(lock.ownerPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = readFileSync(lock.ownerPath, 'utf8');
    assert.equal(after, before);
    await lock.release();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('reports lock cleanup failures without discarding a completed cache', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const result = await cacheImage(temporaryRoot, 'https://cdn.example.test/image.png', {
      fetchImpl: async () => new Response('image'),
      resolveHost: async () => [{ address: '8.8.8.8' }],
      isProcessAlive: () => true,
      cleanupLock: async () => {
        throw new Error('lock cleanup unavailable');
      },
    });
    assert.match(result.warnings.at(-1), /lock cleanup unavailable/);
    assert.equal(
      existsSync(
        path.join(
          temporaryRoot,
          '.tmp',
          'content',
          'notes',
          'linux',
          'io-multiplexing',
          'io-basics',
          'reports',
          'cache-manifest.json',
        ),
      ),
      true,
    );
  });
});

test('rejects cross-topic cache writes for an existing article mirror', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const options = {
      fetchImpl: async () => new Response('image'),
      resolveHost: async () => [{ address: '8.8.8.8' }],
    };
    await cacheImage(temporaryRoot, 'https://cdn.example.test/first.png', options);
    await assert.rejects(
      cacheNote({
        repoRoot: temporaryRoot,
        rules: defaultRules,
        categorySlug: 'linux', topicSlug: 'another-topic',
        articleSlug: 'io-basics',
        note: {
          id: 'note-2',
          rawJson: '{"content":"# Other"}',
          content: '# Other',
        },
        ...options,
      }),
      /unique article slug/i,
    );
  });
});

test('rejects cache paths that traverse an existing symlink', async (t) => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-cache-'));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-outside-'));
  const cacheRoot = path.join(temporaryRoot, '.tmp');

  try {
    mkdirSync(cacheRoot);
    try {
      symlinkSync(outsideRoot, path.join(cacheRoot, 'content'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip(`directory symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      cacheNote({
        repoRoot: temporaryRoot,
        rules: defaultRules,
        categorySlug: 'linux', topicSlug: 'io-multiplexing',
        articleSlug: 'io-basics',
        note: { id: 'note-1', rawJson: '{"content":"# Linux"}', content: '# Linux' },
        fetchImpl: async () => new Response('unused'),
      }),
      /symbolic link/i,
    );
    assert.equal(existsSync(path.join(outsideRoot, 'notes')), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
    rmSync(outsideRoot, { force: true, recursive: true });
  }
});

test('CLI cache requires confirmation before creating its cache root', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-cli-'));

  try {
    writeRulesFixture(temporaryRoot);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          path.join(skillRoot, 'youdao-note-migration.mjs'),
          'cache',
          '--id',
          'note-1',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
        ],
        { cwd: temporaryRoot },
      ),
      (error) => error.code !== 0 && /--confirmed/.test(error.stderr),
    );
    assert.equal(existsSync(path.join(temporaryRoot, '.tmp')), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('CLI formats safe preflight and search JSON without exposing command output', async () => {
  const output = [];
  const dependencies = {
    preflight: async () => ({
      version: 'youdaonote 1.0.0',
      healthCheck: { ok: true },
      rootsListed: true,
    }),
    search: async () => ({
      stdout: '📄 note-1\tI/O 多路复用\n📁 root\tLinux\n',
      stderr: '',
    }),
  };

  await runCli(['preflight'], { repoRoot, dependencies, write: (value) => output.push(value) });
  assert.deepEqual(JSON.parse(output.pop()), {
    version: 'youdaonote 1.0.0',
    healthCheck: { ok: true },
    rootsListed: true,
  });

  await runCli(
    ['search', '--title', 'I/O'],
    { repoRoot, dependencies, write: (value) => output.push(value) },
  );
  assert.deepEqual(JSON.parse(output.pop()), [{ id: 'note-1', title: 'I/O 多路复用' }]);
});

test('CLI cache only reads after an explicit confirmation flag', async () => {
  let readCalls = 0;
  const output = [];
  const dependencies = {
    read: async () => {
      readCalls += 1;
      return { rawJson: '{"content":"# Linux"}', content: '# Linux' };
    },
    cache: async () => ({
      cacheDirectory: '.tmp/content/notes/linux/io-multiplexing/io-basics',
      imageCount: 0,
      provenancePath: '.tmp/content/notes/linux/io-multiplexing/io-basics/reports/provenance.json',
    }),
  };

  await assert.rejects(
    runCli(
      ['cache', '--id', 'note-1', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'],
      { repoRoot, dependencies, write: (value) => output.push(value) },
    ),
    /--confirmed/,
  );
  assert.equal(readCalls, 0);

  await runCli(
    [
      'cache',
      '--id',
      'note-1',
      '--category', 'linux', '--topic',
      'io-multiplexing',
      '--article',
      'io-basics',
      '--confirmed',
    ],
    { repoRoot, dependencies, write: (value) => output.push(value) },
  );
  assert.equal(readCalls, 1);
  assert.deepEqual(JSON.parse(output.pop()), {
    cacheDirectory: '.tmp/content/notes/linux/io-multiplexing/io-basics',
    imageCount: 0,
    provenancePath: '.tmp/content/notes/linux/io-multiplexing/io-basics/reports/provenance.json',
  });
});

test('migration skill requires preflight, candidate confirmation, and tmp-only cache', () => {
  const skill = readFileSync(
    path.join(repoRoot, '.cursor', 'skills', 'youdao-note-migration', 'SKILL.md'),
    'utf8',
  );

  assert.match(skill, /preflight/);
  assert.match(skill, /search --title/);
  assert.match(skill, /--confirmed/);
  assert.match(skill, /只写 `.tmp`/);
  assert.match(skill, /不直接写 `content\/` 或最终 `static\/`/);
  assert.match(skill, /share-info --share-id/);
  assert.match(skill, /cache-share --share-id/);
  assert.match(skill, /公开 API shareId/);
  assert.match(skill, /index\.html\?id=/);
  assert.match(skill, /纯文本.*source\/note\.txt/);
  assert.match(skill, /无法提供.*嵌入图片.*公共分享.*导出/);
  assert.match(skill, /首个非空白字符.*`\{`.*对象 JSON/);
  assert.match(skill, /rawText.*content.*完全一致/);
});

test('validates a public share ID and parses a complete public API response', async () => {
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  const rawJson = JSON.stringify({ tl: 'Linux I/O', content: '<p>body</p>' });
  const calls = [];

  assert.equal(assertShareId(shareId), shareId);
  for (const invalidShareId of [
    '',
    '2712403aa99569831b6a4e38c73afec',
    `${shareId}x`,
    '../2712403aa99569831b6a4e38c73afec6',
    'g712403aa99569831b6a4e38c73afec6',
  ]) {
    assert.throws(() => assertShareId(invalidShareId), /share ID/i);
  }
  assert.deepEqual(parsePublicShareResponse(rawJson, shareId), {
    shareId,
    title: 'Linux I/O',
    content: '<p>body</p>',
    rawJson,
  });
  assert.throws(() => parsePublicShareResponse('not JSON', shareId), /valid JSON/i);
  assert.throws(() => parsePublicShareResponse('{"tl":"only title"}', shareId), /content/i);

  const share = await readPublicShare(shareId, {
    requestJson: async (url) => {
      calls.push(url);
      return rawJson;
    },
  });
  assert.equal(calls[0], `https://note.youdao.com/yws/public/note/${shareId}?sev=j1&editorType=0`);
  assert.equal(share.title, 'Linux I/O');
});

test('uses injected DNS and a pinned request implementation for public share reads', async () => {
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  const rawJson = '{"tl":"Pinned request","content":"<p>safe</p>"}';
  const originalFetch = globalThis.fetch;
  let requestOptions;

  globalThis.fetch = async () => {
    throw new Error('real network access is disabled in this test');
  };
  try {
    const share = await readPublicShare(shareId, {
      resolveHost: async () => [{ address: '8.8.8.8' }],
      requestImpl: async (_url, options) => {
        requestOptions = options;
        return {
          status: 200,
          headers: {},
          stream: Readable.from([rawJson]),
          abort: () => {},
        };
      },
    });
    assert.equal(share.title, 'Pinned request');
    assert.equal(requestOptions.address, '8.8.8.8');
    assert.equal(requestOptions.lookup('note.youdao.com'), '8.8.8.8');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extracts sixteen valid HTML image forms without non-HTTP sources', () => {
  const urls = Array.from({ length: 16 }, (_value, index) => `https://cdn.example.test/${index + 1}.png`);
  const html = [
    `<img src="${urls[0]}">`,
    `<img src='${urls[1]}' alt='two'>`,
    `<img alt="three" src=${urls[2]}>`,
    `<IMG SRC="${urls[3]}">`,
    `<img data-id="5" src = "${urls[4]}" />`,
    `<img\nsrc="${urls[5]}"\nalt="six">`,
    `<img alt="seven" src='${urls[6]}' loading="lazy">`,
    `<img class=diagram src=${urls[7]}>`,
    `<img src="${urls[8]}" data-origin="note">`,
    `<img aria-label="ten" src="${urls[9]}">`,
    `<img src='${urls[10]}'/>`,
    `<img src=${urls[11]} alt=twelve>`,
    `<img style="display:block" src="${urls[12]}">`,
    `<img src="${urls[13]}" width="100">`,
    `<img height=50 src='${urls[14]}'>`,
    `<img\n alt="sixteen"\n src=${urls[15]}\n>`,
    '<img src="data:image/png;base64,ignore">',
    '<img src="file:///tmp/ignore.png">',
  ].join('\n');

  assert.deepEqual(extractImages(html).map((image) => image.sourceUrl), urls);
});

test('cache-share requires confirmation before reading or creating a cache directory', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-share-cli-'));
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  let readCalls = 0;

  try {
    writeRulesFixture(temporaryRoot);
    await assert.rejects(
      runCli(
        ['cache-share', '--share-id', shareId, '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'],
        {
          repoRoot: temporaryRoot,
          dependencies: {
            readShare: async () => {
              readCalls += 1;
              return {};
            },
          },
        },
      ),
      /--confirmed/,
    );
    assert.equal(readCalls, 0);
    assert.equal(existsSync(path.join(temporaryRoot, '.tmp')), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('share-info prints only title, share ID, and image count', async () => {
  const output = [];
  const shareId = '2712403aa99569831b6a4e38c73afec6';

  await runCli(
    ['share-info', '--share-id', shareId],
    {
      dependencies: {
        readShare: async () => ({
          shareId,
          title: 'Public Linux note',
          content: '<p>secret body</p><img src="https://cdn.example.test/image.png">',
          rawJson: '{"content":"secret body"}',
        }),
      },
      write: (value) => output.push(value),
    },
  );

  assert.deepEqual(JSON.parse(output.pop()), {
    title: 'Public Linux note',
    shareId,
    imageCount: 1,
  });
  assert.equal(output.join('').includes('secret body'), false);
});

test('cache-share follows a verified public resource redirect and records public provenance', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-public-share-'));
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  const imageBytes = Buffer.from('redirected public image');
  const calls = [];

  try {
    const result = await cachePublicShare({
      repoRoot: temporaryRoot,
      rules: defaultRules,
      categorySlug: 'linux', topicSlug: 'io-multiplexing',
      articleSlug: 'public-io',
      share: {
        shareId,
        title: 'Public Linux note',
        rawJson: '{"tl":"Public Linux note"}',
        content: '<img alt="diagram" src="https://note.youdao.com/yws/public/resource/share/xmlnote/image.png">',
      },
      resolveHost: async (hostname) => [{ address: hostname === 'note.youdao.com' ? '8.8.8.8' : '1.1.1.1' }],
      requestImpl: async (url, options) => {
        calls.push({ url, address: options.address });
        if (calls.length === 1) {
          return {
            status: 302,
            headers: { location: 'https://cdn.example.test/image.png' },
            stream: Readable.from([]),
            abort: () => {},
          };
        }
        return {
          status: 200,
          headers: {},
          stream: Readable.from([imageBytes]),
          abort: () => {},
        };
      },
    });
    const cacheDirectory = path.join(
      temporaryRoot, '.tmp', 'content', 'notes', 'linux', 'io-multiplexing', 'public-io',
    );
    const provenance = JSON.parse(
      readFileSync(path.join(cacheDirectory, 'reports', 'provenance.json'), 'utf8'),
    );

    assert.equal(result.imageCount, 1);
    assert.deepEqual(calls, [
      {
        url: 'https://note.youdao.com/yws/public/resource/share/xmlnote/image.png',
        address: '8.8.8.8',
      },
      { url: 'https://cdn.example.test/image.png', address: '1.1.1.1' },
    ]);
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'share.json'), 'utf8'),
      '{"tl":"Public Linux note"}');
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'content.html'), 'utf8'),
      '<img alt="diagram" src="https://note.youdao.com/yws/public/resource/share/xmlnote/image.png">');
    assert.equal(provenance.source.type, 'public-share');
    assert.equal(provenance.source.shareId, shareId);
    assert.equal(provenance.source.title, 'Public Linux note');
    assert.equal(existsSync(path.join(temporaryRoot, 'content')), false);
    assert.equal(existsSync(path.join(temporaryRoot, 'static')), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('public resources reject unsafe redirects after at most three verified hops', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-public-redirects-'));
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  let calls = 0;

  try {
    await assert.rejects(
      cachePublicShare({
        repoRoot: temporaryRoot,
        rules: defaultRules,
        categorySlug: 'linux', topicSlug: 'io-multiplexing',
        articleSlug: 'too-many-redirects',
        share: {
          shareId,
          title: 'Redirects',
          rawJson: '{}',
          content: '<img src="https://cdn.example.test/start.png">',
        },
        resolveHost: async () => [{ address: '8.8.8.8' }],
        requestImpl: async () => {
          calls += 1;
          return {
            status: 302,
            headers: { location: `https://cdn.example.test/${calls}.png` },
            stream: Readable.from([]),
            abort: () => {},
          };
        },
      }),
      /redirect/i,
    );
    assert.equal(calls, 4);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('draft template requires provenance, change, image, target, and approval metadata', () => {
  const template = JSON.parse(
    readFileSync(
      DRAFT_TEMPLATE_PATH,
      'utf8',
    ),
  );

  assert.deepEqual(template.required, [
    'sourceSections',
    'outputSections',
    'contentChanges',
    'images',
    'target',
    'approval',
  ]);
  assert.deepEqual(template.properties.sourceSections.items.required, [
    'ref',
    'id',
    'title',
    'headingPath',
  ]);
  assert.deepEqual(template.properties.outputSections.items.required, [
    'ref',
    'sourceSectionRefs',
    'paragraphs',
  ]);
  assert.deepEqual(template.properties.contentChanges.items.required, [
    'kind',
    'reason',
    'status',
    'sourceSectionRefs',
  ]);
  assert.equal(
    template.properties.contentChanges.items.allOf[0].else.required.includes('approvalId'),
    true,
  );
  assert.deepEqual(template.properties.contentChanges.items.properties.frontMatter, {
    type: 'boolean',
    const: true,
  });
  assert.deepEqual(template.properties.images.items.required, [
    'source',
    'cachePath',
    'finalPath',
    'sourceSectionRef',
    'decision',
    'status',
    'approvalId',
  ]);
  assert.deepEqual(template.properties.target.required, [
    'title',
    'categorySlug',
    'topicSlug',
    'articleSlug',
    'markdownPath',
    'imageDir',
  ]);
  assert.deepEqual(template.properties.approval.required, [
    'status',
    'approvals',
  ]);
  assert.deepEqual(template.properties.approval.properties.approvals.items.required, [
    'id',
    'status',
    'recordedAt',
    'confirmedBy',
    'confirmedAt',
  ]);
  assert.equal(JSON.stringify(template).includes('body'), false);
});

function createApprovedDraft() {
  return {
    sourceSections: [
      {
        ref: 'source-1',
        id: 'note-1',
        title: 'I/O basics',
        headingPath: ['Linux', 'I/O'],
      },
    ],
    outputSections: [
      {
        ref: 'section-1',
        sourceSectionRefs: ['source-1'],
        paragraphs: [{ ref: 'paragraph-1', sourceSectionRefs: ['source-1'] }],
      },
    ],
    contentChanges: [
      {
        kind: 'structural',
        reason: 'Use confirmed Front Matter and heading numbers',
        status: 'approved',
        sourceSectionRefs: ['source-1'],
        frontMatter: true,
        approvalId: 'approval-1',
      },
    ],
    images: [
      {
        source: 'https://cdn.example.test/io.png',
        cachePath: '.tmp/static/images/notes/linux/io-basics/image-001.png',
        finalPath: 'static/images/notes/linux/io-basics/image-001.png',
        sourceSectionRef: 'source-1',
        decision: 'preserve-original',
        status: 'approved',
        approvalId: 'approval-1',
      },
    ],
    target: {
      title: 'I/O basics',
      categorySlug: 'linux', topicSlug: 'io-multiplexing',
      articleSlug: 'io-basics',
      markdownPath: 'content/notes/linux/io-multiplexing/io-basics.md',
      imageDir: 'static/images/notes/linux/io-basics',
    },
    approval: {
      status: 'approved',
      approvals: [
        {
          id: 'approval-1',
          status: 'approved',
          recordedAt: '2026-07-11T08:00:00Z',
          confirmedBy: 'wunianor',
          confirmedAt: '2026-07-11T08:00:00Z',
        },
      ],
    },
  };
}

function createApprovedMarkdown() {
  return [
    '---',
    'title: "I/O basics"',
    'date: "2026-07-11"',
    'draft: false',
    'categories:',
    '  - "linux"',
    'tags:',
    '  - "io"',
    'type: "note"',
    'weight: 1',
    'description: "Confirmed I/O study note"',
    '---',
    '',
    '## 1. I/O basics',
    '### 1.1. Details',
    '#### 1.1.1. Example',
    '',
    '![I/O diagram](/images/notes/linux/io-basics/image-001.png)',
  ].join('\n');
}

test('draft validator accepts mapped output with Hugo heading and image paths', () => {
  const draft = createApprovedDraft();
  const markdown = createApprovedMarkdown();

  assert.doesNotThrow(() => validateDraftMetadata(draft, draftValidationOptions));
  assert.doesNotThrow(() => validateDraftOutput(draft, markdown, draftValidationOptions));
});

test('draft output requires globally and individually approved decisions', () => {
  const cases = [
    {
      name: 'root approval pending',
      mutate: (draft) => {
        draft.approval.status = 'pending';
      },
    },
    {
      name: 'referenced approval rejected',
      mutate: (draft) => {
        draft.approval.approvals[0].status = 'rejected';
      },
    },
    {
      name: 'non-mechanical change blocked',
      mutate: (draft) => {
        draft.contentChanges[0].status = 'blocked';
      },
    },
    {
      name: 'image decision pending',
      mutate: (draft) => {
        draft.images[0].status = 'pending';
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const draft = createApprovedDraft();
    mutate(draft);
    assert.throws(
      () => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions),
      /approval|contentChanges|images/,
      name,
    );
  }
});

test('draft metadata enforces schema enums, patterns, and closed objects', () => {
  const cases = [
    {
      name: 'unknown image property',
      mutate: (draft) => {
        draft.images[0].unexpected = true;
      },
      expected: /images\[0\].*unexpected/,
    },
    {
      name: 'unknown content change kind',
      mutate: (draft) => {
        draft.contentChanges[0].kind = 'rewrite';
      },
      expected: /contentChanges\[0\]\.kind/,
    },
    {
      name: 'invalid source reference pattern',
      mutate: (draft) => {
        draft.sourceSections[0].ref = 'source ref';
      },
      expected: /sourceSections\[0\]\.ref/,
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = createApprovedDraft();
    mutate(draft);
    assert.throws(() => validateDraftMetadata(draft, draftValidationOptions), expected, name);
  }
});

test('draft output requires confirmed front matter and forbids HTML images', () => {
  const cases = [
    {
      name: 'missing title',
      markdown: () => createApprovedMarkdown().replace('title: "I/O basics"\n', ''),
      expected: /front matter.*title/i,
    },
    {
      name: 'draft output',
      markdown: () => createApprovedMarkdown().replace('draft: false', 'draft: true'),
      expected: /front matter.*draft/i,
    },
    {
      name: 'HTML image',
      markdown: () => `${createApprovedMarkdown()}\n<img src="/images/notes/linux/io-basics/image-001.png">`,
      expected: /HTML.*img/i,
    },
  ];

  for (const { name, markdown, expected } of cases) {
    assert.throws(
      () => validateDraftOutput(createApprovedDraft(), markdown(), draftValidationOptions),
      expected,
      name,
    );
  }
});

test('draft output requires consecutive heading numbers and parent prefixes', () => {
  const cases = [
    {
      name: 'top-level jump',
      markdown: () => createApprovedMarkdown().replace('## 1. I/O basics', '## 2. I/O basics'),
    },
    {
      name: 'sibling jump',
      markdown: () => `${createApprovedMarkdown()}\n## 3. Another section`,
    },
    {
      name: 'wrong parent prefix',
      markdown: () => createApprovedMarkdown().replace('### 1.1. Details', '### 2.1. Details'),
    },
    {
      name: 'unnumbered subsection',
      markdown: () => createApprovedMarkdown().replace('### 1.1. Details', '### Details'),
    },
    {
      name: 'standalone unnumbered subsection',
      markdown: () => createApprovedMarkdown().replace(
        '### 1.1. Details\n#### 1.1.1. Example\n\n',
        '### Details\n\n',
      ),
    },
  ];

  for (const { name, markdown } of cases) {
    assert.throws(
      () => validateDraftOutput(createApprovedDraft(), markdown(), draftValidationOptions),
      /heading/,
      name,
    );
  }
});

test('draft validator rejects missing provenance, approvals, and target paths', () => {
  const cases = [
    {
      name: 'source section ref',
      mutate: (draft) => {
        delete draft.sourceSections[0].ref;
      },
      expected: /sourceSections\[0\]\.ref/,
    },
    {
      name: 'paragraph mapping',
      mutate: (draft) => {
        draft.outputSections[0].paragraphs[0].sourceSectionRefs = ['unknown-source'];
      },
      expected: /paragraphs\[0\]\.sourceSectionRefs/,
    },
    {
      name: 'content approval',
      mutate: (draft) => {
        delete draft.contentChanges[0].approvalId;
      },
      expected: /contentChanges\[0\]\.approvalId/,
    },
    {
      name: 'image mapping',
      mutate: (draft) => {
        delete draft.images[0].sourceSectionRef;
      },
      expected: /images\[0\]\.sourceSectionRef/,
    },
    {
      name: 'arbitrary image path',
      mutate: (draft) => {
        draft.images[0].finalPath = 'static/images/notes/elsewhere/image-001.png';
      },
      expected: /images\[0\]\.finalPath/,
    },
    {
      name: 'target markdown path',
      mutate: (draft) => {
        draft.target.markdownPath = 'content/notes/linux/io-multiplexing/other.md';
      },
      expected: /target\.markdownPath/,
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = createApprovedDraft();
    mutate(draft);
    assert.throws(() => validateDraftMetadata(draft, draftValidationOptions), expected, name);
  }
});

test('draft validation requires configured confirmation evidence and an approved Front Matter change', () => {
  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), createApprovedMarkdown()),
    /approvalUserId/,
    'approval validation must not fall back to a default user',
  );

  const cases = [
    {
      name: 'arbitrary confirmer',
      mutate: (draft) => {
        draft.approval.approvals[0].confirmedBy = 'someone-else';
      },
      expected: /confirmedBy/,
    },
    {
      name: 'missing confirmation timestamp',
      mutate: (draft) => {
        delete draft.approval.approvals[0].confirmedAt;
      },
      expected: /confirmedAt/,
    },
    {
      name: 'invalid confirmation timestamp',
      mutate: (draft) => {
        draft.approval.approvals[0].confirmedAt = '2026-02-30T08:00:00Z';
      },
      expected: /confirmedAt/,
    },
    {
      name: 'unmarked Front Matter change',
      mutate: (draft) => {
        delete draft.contentChanges[0].frontMatter;
      },
      expected: /frontMatter/,
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = createApprovedDraft();
    mutate(draft);
    assert.throws(
      () => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions),
      expected,
      name,
    );
  }
});

test('validate-draft reports a safe JSON summary without writing output files', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-draft-validation-'));
  try {
    writeRulesFixture(temporaryRoot);
    writeFileSync(
      path.join(temporaryRoot, 'draft.json'),
      JSON.stringify(createApprovedDraft()),
    );
    writeFileSync(path.join(temporaryRoot, 'article.md'), createApprovedMarkdown());

    let output = '';
    await runCli(['validate-draft', '--draft', 'draft.json', '--markdown', 'article.md'], {
      repoRoot: temporaryRoot,
      write: (value) => {
        output += value;
      },
    });

    assert.deepEqual(JSON.parse(output), {
      valid: true,
      draft: 'draft.json',
      markdown: 'article.md',
      target: {
        markdownPath: 'content/notes/linux/io-multiplexing/io-basics.md',
        imageDir: 'static/images/notes/linux/io-basics',
      },
      counts: {
        sourceSections: 1,
        outputSections: 1,
        paragraphs: 1,
        contentChanges: 1,
        images: 1,
      },
    });
    assert.equal(existsSync(path.join(temporaryRoot, 'content')), false);
    assert.equal(existsSync(path.join(temporaryRoot, 'static')), false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('validate-draft rejects paths that escape the repository root', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-draft-validation-'));
  try {
    writeFileSync(path.join(temporaryRoot, 'draft.json'), '{}');
    await assert.rejects(
      runCli(['validate-draft', '--draft', '../draft.json', '--markdown', 'article.md'], {
        repoRoot: temporaryRoot,
      }),
      /draft.*repository root/i,
    );
    await assert.rejects(
      runCli(['validate-draft', '--draft', 'draft.json', '--markdown', 'C:\\outside.md'], {
        repoRoot: temporaryRoot,
      }),
      /markdown.*repository root/i,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('validate-draft exits nonzero with a safe JSON error summary', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-draft-validation-'));
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          path.join(skillRoot, 'youdao-note-migration.mjs'),
          'validate-draft',
          '--draft',
          '../draft.json',
          '--markdown',
          'article.md',
        ],
        { cwd: temporaryRoot },
      ),
      (error) => {
        assert.equal(error.code, 1);
        const summary = JSON.parse(error.stderr);
        assert.equal(summary.valid, false);
        assert.match(summary.error, /repository root/i);
        assert.equal(summary.error.includes('sourceSections'), false);
        return true;
      },
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

function createQualityGateRoot() {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-quality-gate-'));
  writeRulesFixture(temporaryRoot);
  writeFileSync(path.join(temporaryRoot, 'draft.json'), JSON.stringify(createApprovedDraft()));

  const markdown = createApprovedMarkdown();
  writeFileSync(path.join(temporaryRoot, 'candidate.md'), markdown);
  mkdirSync(path.join(temporaryRoot, 'content', 'notes', 'linux', 'io-multiplexing'), {
    recursive: true,
  });
  writeFileSync(
    path.join(temporaryRoot, 'content', 'notes', 'linux', 'io-multiplexing', 'io-basics.md'),
    markdown,
  );
  mkdirSync(path.join(temporaryRoot, 'static', 'images', 'notes', 'linux', 'io-basics'), {
    recursive: true,
  });
  writeFileSync(
    path.join(
      temporaryRoot,
      'static',
      'images',
      'notes',
      'linux',
      'io-basics',
      'image-001.png',
    ),
    'image bytes',
  );
  const provenanceDirectory = path.join(
    temporaryRoot,
    '.tmp',
    'content',
    'notes',
    'linux',
    'io-multiplexing',
    'io-basics',
    'reports',
  );
  mkdirSync(provenanceDirectory, { recursive: true });
  const originalImageDirectory = path.join(
    temporaryRoot,
    '.tmp',
    'content',
    'notes',
    'linux',
    'io-multiplexing',
    'io-basics',
    'images',
    'original',
  );
  mkdirSync(originalImageDirectory, { recursive: true });
  writeFileSync(path.join(originalImageDirectory, 'image-001.png'), 'image bytes');
  writeFileSync(
    path.join(provenanceDirectory, 'provenance.json'),
    JSON.stringify({
      images: [
        {
          sourceUrl: 'https://cdn.example.test/io.png',
          localPath:
            '.tmp/content/notes/linux/io-multiplexing/io-basics/images/original/image-001.png',
          sha256: createHash('sha256').update('image bytes').digest('hex'),
        },
      ],
    }),
  );
  return temporaryRoot;
}

test('check-note validates final paths, approved image assets, and safe Markdown links without mutation', async () => {
  const temporaryRoot = createQualityGateRoot();
  try {
    let output = '';
    await runCli(
      [
        'check-note',
        '--draft',
        'draft.json',
        '--approved-markdown',
        'candidate.md',
        '--category', 'linux', '--topic',
        'io-multiplexing',
        '--article',
        'io-basics',
      ],
      {
        repoRoot: temporaryRoot,
        write: (value) => {
          output += value;
        },
      },
    );

    assert.deepEqual(JSON.parse(output), {
      valid: true,
      command: 'check-note',
      markdown: 'content/notes/linux/io-multiplexing/io-basics.md',
      imageDir: 'static/images/notes/linux/io-basics',
      images: 1,
    });
    assert.equal(
      readFileSync(path.join(temporaryRoot, 'content', 'notes', 'linux', 'io-multiplexing', 'io-basics.md'), 'utf8'),
      createApprovedMarkdown(),
    );

    writeFileSync(
      path.join(temporaryRoot, 'content', 'notes', 'linux', 'io-multiplexing', 'io-basics.md'),
      `${createApprovedMarkdown()}\nA final-file discrepancy.`,
    );
    await assert.rejects(
      runCli(
        [
          'check-note',
          '--draft',
          'draft.json',
          '--approved-markdown',
          'candidate.md',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
        ],
        { repoRoot: temporaryRoot },
      ),
      /final markdown.*approved candidate/i,
    );
    await assert.rejects(
      runCli(
        [
          'check-note',
          '--draft',
          'draft.json',
          '--approved-markdown',
          'candidate.md',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
          '--content-dir',
          '../outside',
        ],
        { repoRoot: temporaryRoot },
      ),
      /content-dir.*repository root/i,
    );

    writeFileSync(
      path.join(temporaryRoot, 'content', 'notes', 'linux', 'io-multiplexing', 'io-basics.md'),
      createApprovedMarkdown(),
    );
    writeFileSync(
      path.join(
        temporaryRoot,
        'static',
        'images',
        'notes',
        'linux',
        'io-basics',
        'unapproved.png',
      ),
      'unapproved',
    );
    await assert.rejects(
      runCli(
        [
          'check-note',
          '--draft',
          'draft.json',
          '--approved-markdown',
          'candidate.md',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
        ],
        { repoRoot: temporaryRoot },
      ),
      /unapproved final image asset.*unapproved\.png/i,
    );
    rmSync(
      path.join(
        temporaryRoot,
        'static',
        'images',
        'notes',
        'linux',
        'io-basics',
        'unapproved.png',
      ),
    );
    writeFileSync(
      path.join(
        temporaryRoot,
        'static',
        'images',
        'notes',
        'linux',
        'io-basics',
        'image-001.png',
      ),
      'tampered image bytes',
    );
    await assert.rejects(
      runCli(
        [
          'check-note',
          '--draft',
          'draft.json',
          '--approved-markdown',
          'candidate.md',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
        ],
        { repoRoot: temporaryRoot },
      ),
      /preserve-original.*SHA256/i,
    );
    rmSync(
      path.join(
        temporaryRoot,
        'static',
        'images',
        'notes',
        'linux',
        'io-basics',
        'image-001.png',
      ),
    );
    await assert.rejects(
      runCli(
        [
          'check-note',
          '--draft',
          'draft.json',
          '--approved-markdown',
          'candidate.md',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
        ],
        { repoRoot: temporaryRoot },
      ),
      /approved final image/i,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('check-note permits an absent image directory for an approved zero-image draft', async () => {
  const temporaryRoot = createQualityGateRoot();
  try {
    const draft = createApprovedDraft();
    draft.images = [];
    const markdown = createApprovedMarkdown().replace(
      '![I/O diagram](/images/notes/linux/io-basics/image-001.png)',
      '',
    );
    writeFileSync(path.join(temporaryRoot, 'draft.json'), JSON.stringify(draft));
    writeFileSync(path.join(temporaryRoot, 'candidate.md'), markdown);
    writeFileSync(
      path.join(temporaryRoot, 'content', 'notes', 'linux', 'io-multiplexing', 'io-basics.md'),
      markdown,
    );
    rmSync(path.join(temporaryRoot, 'static', 'images', 'notes', 'linux', 'io-basics'), {
      force: true,
      recursive: true,
    });

    let output = '';
    await runCli(
      [
        'check-note',
        '--draft',
        'draft.json',
        '--approved-markdown',
        'candidate.md',
        '--category', 'linux', '--topic',
        'io-multiplexing',
        '--article',
        'io-basics',
      ],
      {
        repoRoot: temporaryRoot,
        write: (value) => {
          output += value;
        },
      },
    );

    assert.deepEqual(JSON.parse(output), {
      valid: true,
      command: 'check-note',
      markdown: 'content/notes/linux/io-multiplexing/io-basics.md',
      imageDir: 'static/images/notes/linux/io-basics',
      images: 0,
    });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('check-note requires the image directory when the approved inventory is non-empty', async () => {
  const temporaryRoot = createQualityGateRoot();
  try {
    rmSync(path.join(temporaryRoot, 'static', 'images', 'notes', 'linux', 'io-basics'), {
      force: true,
      recursive: true,
    });

    await assert.rejects(
      runCli(
        [
          'check-note',
          '--draft',
          'draft.json',
          '--approved-markdown',
          'candidate.md',
          '--category', 'linux', '--topic',
          'io-multiplexing',
          '--article',
          'io-basics',
        ],
        { repoRoot: temporaryRoot },
      ),
      /final image directory.*exist/i,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('check-site invokes Hugo with fixed safe arguments and reports runner failures', async () => {
  const calls = [];
  let output = '';
  await runCli(['check-site'], {
    repoRoot,
    dependencies: {
      runProcess: async (command, argumentsList, options) => {
        calls.push({ command, argumentsList, options });
        return { exitCode: 0, stdout: 'built', stderr: '' };
      },
    },
    write: (value) => {
      output += value;
    },
  });

  assert.deepEqual(calls, [
    {
      command: 'hugo',
      argumentsList: ['--minify', '--environment', 'production'],
      options: { cwd: repoRoot },
    },
  ]);
  assert.deepEqual(JSON.parse(output), {
    valid: true,
    command: 'check-site',
    exitCode: 0,
  });
  await assert.rejects(
    runCli(['check-site'], {
      repoRoot,
      dependencies: {
        runProcess: async () => ({ exitCode: 127, stdout: '', stderr: 'hugo not found' }),
      },
    }),
    /Hugo.*127/i,
  );
});

test('git-readiness permits only explicit article assets and explicit extra allow-list paths', async () => {
  const calls = [];
  const runProcess = async (command, argumentsList, options) => {
    calls.push({ command, argumentsList, options });
    if (argumentsList[0] === 'branch') {
      return { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' };
    }
    if (argumentsList[0] === 'diff') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return {
      exitCode: 0,
      stdout: [
        ' M content/notes/linux/io-multiplexing/io-basics.md',
        '?? static/images/notes/linux/io-basics/image-001.png',
        ` M ${RULES_REPO_PATH}`,
      ].join('\n'),
      stderr: '',
    };
  };
  let output = '';
  await runCli(
    [
      'git-readiness',
      '--category', 'linux', '--topic',
      'io-multiplexing',
      '--article',
      'io-basics',
      '--allow',
      RULES_REPO_PATH,
    ],
    {
      repoRoot,
      dependencies: { runProcess },
      write: (value) => {
        output += value;
      },
    },
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], {
    command: 'git',
    argumentsList: ['branch', '--show-current'],
    options: { cwd: repoRoot },
  });
  assert.deepEqual(calls[1], {
    command: 'git',
    argumentsList: ['status', '--porcelain=v1', '--untracked-files=all'],
    options: { cwd: repoRoot },
  });
  assert.deepEqual(calls[2], {
    command: 'git',
    argumentsList: ['diff', '--check'],
    options: { cwd: repoRoot },
  });
  assert.deepEqual(calls[3], {
    command: 'git',
    argumentsList: ['diff', '--cached', '--check'],
    options: { cwd: repoRoot },
  });
  assert.deepEqual(JSON.parse(output), {
    valid: true,
    command: 'git-readiness',
    branch: 'docs/linux-io-basics',
    changedPaths: [
      'content/notes/linux/io-multiplexing/io-basics.md',
      'static/images/notes/linux/io-basics/image-001.png',
      RULES_REPO_PATH,
    ],
  });
  await assert.rejects(
    runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', '../escape'], {
      repoRoot,
      dependencies: { runProcess },
    }),
    /articleSlug/i,
  );
  await assert.rejects(
    runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot,
      dependencies: {
        runProcess: async (_command, argumentsList) =>
          argumentsList[0] === 'branch'
            ? { exitCode: 0, stdout: 'main\n', stderr: '' }
            : { exitCode: 0, stdout: '?? .tmp/escape.md\n', stderr: '' },
      },
    }),
    /branch.*docs\/linux-io-basics/i,
  );
  await assert.rejects(
    runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot,
      dependencies: {
        runProcess: async (_command, argumentsList) =>
          argumentsList[0] === 'branch'
            ? { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' }
            : { exitCode: 0, stdout: '?? .tmp/escape.md\n', stderr: '' },
      },
    }),
    /unexpected changed paths.*\.tmp/i,
  );
  await assert.rejects(
    runCli(
      [
        'git-readiness',
        '--category', 'linux', '--topic',
        'io-multiplexing',
        '--article',
        'io-basics',
        '--allow',
        '.tmp/escape.md',
      ],
      {
        repoRoot,
        dependencies: {
          runProcess: async (_command, argumentsList) =>
            argumentsList[0] === 'branch'
              ? { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' }
              : { exitCode: 0, stdout: '?? .tmp/escape.md\n', stderr: '' },
        },
      },
    ),
    /unexpected changed paths.*\.tmp/i,
  );
});

test('git-readiness runs both diff checks before rejecting unexpected paths', async () => {
  const calls = [];
  const runProcess = async (command, argumentsList, options) => {
    calls.push({ command, argumentsList, options });
    if (argumentsList[0] === 'branch') {
      return { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' };
    }
    if (argumentsList[0] === 'status') {
      return { exitCode: 0, stdout: '?? .tmp/force-added.txt\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot,
      dependencies: { runProcess },
    }),
    /unexpected changed paths.*\.tmp/i,
  );
  assert.deepEqual(
    calls.map(({ command, argumentsList }) => ({ command, argumentsList })),
    [
      { command: 'git', argumentsList: ['branch', '--show-current'] },
      { command: 'git', argumentsList: ['status', '--porcelain=v1', '--untracked-files=all'] },
      { command: 'git', argumentsList: ['diff', '--check'] },
      { command: 'git', argumentsList: ['diff', '--cached', '--check'] },
    ],
  );
});

test('git-readiness allows an ignored root .tmp directory but rejects diff whitespace errors', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-git-readiness-'));
  try {
    writeRulesFixture(temporaryRoot);
    mkdirSync(path.join(temporaryRoot, '.tmp'), { recursive: true });
    writeFileSync(path.join(temporaryRoot, '.tmp', 'ignored.md'), 'temporary');
    const cleanGitRunner = async (_command, argumentsList) => {
      if (argumentsList[0] === 'branch') {
        return { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    let output = '';
    await runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot: temporaryRoot,
      dependencies: { runProcess: cleanGitRunner },
      write: (value) => {
        output += value;
      },
    });
    assert.deepEqual(JSON.parse(output).changedPaths, []);
    rmSync(path.join(temporaryRoot, '.tmp'), { force: true, recursive: true });
    await assert.rejects(
      runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
        repoRoot: temporaryRoot,
        dependencies: {
          runProcess: async (_command, argumentsList) => {
            if (argumentsList[0] === 'branch') {
              return { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' };
            }
            if (argumentsList[0] === 'diff') {
              return { exitCode: 1, stdout: 'trailing whitespace', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
      }),
      /Git diff check.*1/i,
    );
    await assert.rejects(
      runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
        repoRoot: temporaryRoot,
        dependencies: {
          runProcess: async (_command, argumentsList) => {
            if (argumentsList[0] === 'branch') {
              return { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' };
            }
            if (argumentsList.includes('--cached')) {
              return { exitCode: 1, stdout: 'staged trailing whitespace', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
      }),
      /Git cached diff check.*1/i,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('git-readiness rejects whitespace and conflict markers in allowed untracked Markdown', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'linux-note-untracked-markdown-'));
  try {
    writeRulesFixture(temporaryRoot);
    const markdownPath = path.join(
      temporaryRoot,
      'content',
      'notes',
      'linux',
      'io-multiplexing',
      'io-basics.md',
    );
    mkdirSync(path.dirname(markdownPath), { recursive: true });
    const runProcess = async (_command, argumentsList) =>
      argumentsList[0] === 'branch'
        ? { exitCode: 0, stdout: 'docs/linux-io-basics\n', stderr: '' }
        : {
          exitCode: 0,
          stdout:
            argumentsList[0] === 'status'
              ? '?? content/notes/linux/io-multiplexing/io-basics.md\n'
              : '',
          stderr: '',
        };

    for (const { markdown, expected } of [
      { markdown: 'A trailing space \n', expected: /trailing whitespace/i },
      { markdown: '<<<<<<< HEAD\n', expected: /conflict marker/i },
    ]) {
      writeFileSync(markdownPath, markdown);
      await assert.rejects(
        runCli(['git-readiness', '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
          repoRoot: temporaryRoot,
          dependencies: { runProcess },
        }),
        expected,
      );
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('quality gate command errors use safe JSON and a nonzero exit', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(skillRoot, 'youdao-note-migration.mjs'), 'check-note'],
      { cwd: repoRoot },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), {
        valid: false,
        command: 'check-note',
        error: 'Usage: check-note --draft <relative-json> --approved-markdown <relative-md> --category <slug> --topic <slug> --article <slug> [--content-dir <relative-dir>] [--image-dir <relative-dir>]',
      });
      return true;
    },
  );
});

test('strict-fidelity protocol gates non-mechanical edits and defines Hugo output', () => {
  const skill = readFileSync(
    path.join(repoRoot, '.cursor', 'skills', 'youdao-note-migration', 'SKILL.md'),
    'utf8',
  );
  const protocol = readFileSync(
    path.join(repoRoot, '.cursor', 'skills', 'youdao-note-migration', 'generation-protocol.md'),
    'utf8',
  );

  assert.match(skill, /\[严格保真生成协议\]\(generation-protocol\.md\)/);
  assert.match(skill, /公共分享缓存.*私有 CLI 缓存/);
  assert.match(skill, /变更计划/);
  assert.match(skill, /确认后.*独立 worktree/);
  assert.match(skill, /不得.*生成.*重排.*纠错.*正文.*确认/);
  assert.match(skill, /候选.*id.*标题/);
  assert.doesNotMatch(skill, /展示候选.*标题路径/);
  assert.match(skill, /内容 source 读取后.*headingPath/);
  assert.match(skill, /AI.*缓存来源.*逐段落/);
  assert.match(skill, /差异检查清单/);
  assert.match(skill, /validate-draft/);
  assert.match(skill, /不得声称机器验证器能证明/);
  assert.match(protocol, /输入\/输出契约/);
  assert.match(protocol, /章节.*图片.*溯源/);
  assert.match(protocol, /AI 语义保真审查与确定性门禁/);
  assert.match(protocol, /不能.*证明来源语义保真/);
  assert.match(protocol, /frontMatter/);
  assert.match(protocol, /approvalUserId/);
  assert.match(protocol, /仅允许自动进行的机械变更/);
  assert.match(protocol, /结构性.*事实性.*图片.*不确定/);
  assert.match(protocol, /原样保留.*Markdown 转写.*候选重绘.*阻塞/);
  assert.match(protocol, /确认记录/);
  assert.match(protocol, /approvalId/);
  assert.match(protocol, /title:/);
  assert.match(protocol, /## 1\./);
  assert.match(protocol, /### 1\.1\./);
  assert.match(protocol, /#### 1\.1\.1\./);
  assert.match(protocol, /\/images\/notes\/<category-slug>\/<article-slug>\//);
  assert.match(protocol, /不得提交 `\.tmp`/);
  assert.match(protocol, /纯文本.*嵌入图片.*公共分享.*导出/);
  assert.match(protocol, /`\{`.*对象 JSON.*`\[`.*纯文本/);
  assert.match(protocol, /rawText.*content.*完全一致/);
  assert.match(skill, /写入前.*独立 worktree.*分支/);
  assert.match(skill, /AI.*审查/);
  assert.match(skill, /check-note/);
  assert.match(skill, /--approved-markdown/);
  assert.match(skill, /check-site/);
  assert.match(skill, /git-readiness/);
  assert.match(skill, /路径变更/);
  assert.match(skill, /忽略的.*根目录.*\.tmp.*保留/);
  assert.match(skill, /Git.*报告.*\.tmp.*变更.*阻止/);
  assert.match(skill, /用户明确确认.*git add.*git commit/);
  assert.match(skill, /docs: 新增 <标题> 学习笔记/);
  assert.match(skill, /用户明确.*push.*PR/);
  assert.match(skill, /明确.*合并.*删除/);
  assert.match(skill, /不得自动/);
});

test('requires a category and uses generic project-scoped migration paths', () => {
  const rules = {
    cacheRoot: '.tmp',
    contentRoot: 'content/notes',
    imageRoot: 'static/images/notes',
  };

  assert.throws(
    () => buildMigrationPaths(rules, { topicSlug: 'concurrency', articleSlug: 'select' }),
    /categorySlug.*non-empty slug/i,
  );
  assert.deepEqual(
    buildMigrationPaths(rules, {
      categorySlug: 'go',
      topicSlug: 'concurrency',
      articleSlug: 'select',
    }),
    {
      cacheRoot: '.tmp',
      cacheContentDir: '.tmp/content/notes/go/concurrency/select',
      cacheImageDir: '.tmp/static/images/notes/go/select',
      contentDir: 'content/notes/go/concurrency',
      imageDir: 'static/images/notes/go/select',
    },
  );
});

test('keeps all Youdao migration skill files in one project skill folder', () => {
  const skillDir = skillDirectory(repoRoot);
  const requiredRelativePaths = [
    'SKILL.md',
    'generation-protocol.md',
    'youdao-note-migration.json',
    'youdao-note-migration-draft-template.json',
    'youdao-note-migration.mjs',
    'youdao-note-migration.test.mjs',
    path.join('lib', 'cli.mjs'),
    path.join('lib', 'paths.mjs'),
  ];
  for (const relativePath of requiredRelativePaths) {
    assert.equal(existsSync(path.join(skillDir, relativePath)), true, relativePath);
  }

  const retiredPaths = [
    path.join(repoRoot, 'config', 'youdao-note-migration.json'),
    path.join(repoRoot, 'config', 'youdao-note-migration-draft-template.json'),
    path.join(repoRoot, 'scripts', 'youdao-note-migration.mjs'),
    path.join(repoRoot, 'scripts', 'lib', 'youdao-note-migration'),
    path.join(repoRoot, 'test', 'youdao-note-migration.test.mjs'),
    path.join(repoRoot, '.cursor', 'skills', 'linux-note-migration', 'SKILL.md'),
  ];
  for (const retiredPath of retiredPaths) {
    assert.equal(existsSync(retiredPath), false, retiredPath);
  }

  const skill = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: youdao-note-migration$/m);
  assert.match(skill, /\.cursor\/skills\/youdao-note-migration\/youdao-note-migration\.mjs/);
  assert.match(skill, /全部文件均位于/);
});

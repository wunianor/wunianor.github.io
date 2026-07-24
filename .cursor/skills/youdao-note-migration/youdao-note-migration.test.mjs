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
} from './lib/images.mjs';
import { createPinnedLookup, isGloballyRoutableAddress } from './lib/network.mjs';
import {
  acquireCacheLock,
  cacheNote,
  cachePublicShare,
} from './lib/cache.mjs';
import {
  assertShareId,
  parsePublicShareResponse,
  readPublicShare,
  resolveShareInput,
} from './lib/public-share.mjs';
import {
  validateDraftMetadata,
  validateDraftOutput,
} from './lib/draft-validator.mjs';
import { main as cacheShareMain } from './scripts/cache-share.mjs';
import { main as checkNoteMain } from './scripts/check-note.mjs';
import { main as checkSiteMain } from './scripts/check-site.mjs';
import { main as gitReadinessMain } from './scripts/git-readiness.mjs';
import { main as shareInfoMain } from './scripts/share-info.mjs';
import { main as validateDraftMain } from './scripts/validate-draft.mjs';

const execFileAsync = promisify(execFile);
const skillRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(skillRoot, '../../..');
const SCRIPT_PATHS = {
  paths: path.join(skillRoot, 'scripts', 'paths.mjs'),
  'share-info': path.join(skillRoot, 'scripts', 'share-info.mjs'),
  'cache-share': path.join(skillRoot, 'scripts', 'cache-share.mjs'),
  'validate-draft': path.join(skillRoot, 'scripts', 'validate-draft.mjs'),
  'check-note': path.join(skillRoot, 'scripts', 'check-note.mjs'),
  'check-site': path.join(skillRoot, 'scripts', 'check-site.mjs'),
  'git-readiness': path.join(skillRoot, 'scripts', 'git-readiness.mjs'),
};
const RULES_REPO_PATH = path.posix.join(...SKILL_DIR_SEGMENTS, RULES_FILENAME);
const DRAFT_TEMPLATE_PATH = path.join(skillRoot, 'youdao-note-migration-draft-template.json');
const defaultRules = {
  version: 1,
  cacheRoot: '.tmp',
  contentRoot: 'content/notes',
  imageRoot: 'static/images/notes',
  branchTemplate: 'docs/{category}_{topic}_{article}',
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

test('createPinnedLookup supports Node all:true and legacy lookup callbacks', () => {
  const lookup = createPinnedLookup('8.8.8.8');

  lookup('note.youdao.com', { all: true }, (error, results) => {
    assert.equal(error, null);
    assert.deepEqual(results, [{ address: '8.8.8.8', family: 4 }]);
  });

  lookup('note.youdao.com', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });

  lookup('note.youdao.com', (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });

  const ipv6Lookup = createPinnedLookup('2001:4860:4860::8888');
  ipv6Lookup('note.youdao.com', { all: true }, (error, results) => {
    assert.equal(error, null);
    assert.deepEqual(results, [{ address: '2001:4860:4860::8888', family: 6 }]);
  });

  assert.throws(() => createPinnedLookup('not-an-ip'), /valid IP/i);
  assert.throws(() => createPinnedLookup(''), /non-empty/i);
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
    cacheImageDir: '.tmp/content/notes/linux/io-multiplexing/io-basics/images',
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

test('paths script prints migration paths as formatted JSON', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      SCRIPT_PATHS.paths,
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
        cacheImageDir: '.tmp/content/notes/linux/io-multiplexing/io-basics/images',
        contentDir: 'content/notes/linux/io-multiplexing',
        imageDir: 'static/images/notes/linux/io-basics',
      },
      null,
      2,
    )}\n`,
  );
});

test('validate-draft rejects unknown positional arguments', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        SCRIPT_PATHS['validate-draft'],
        'unknown',
        '--draft',
        'draft.json',
        '--markdown',
        'article.md',
      ],
      { cwd: repoRoot },
    ),
    (error) => error.code !== 0 && /Usage: validate-draft/.test(error.stderr),
  );
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

test('caches source files, downloaded images, and provenance without a static mirror', async () => {
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
      const staticMirrorRoot = path.join(temporaryRoot, '.tmp', 'static');
      const provenance = JSON.parse(
        readFileSync(path.join(cacheDirectory, 'reports', 'provenance.json'), 'utf8'),
      );
      const manifest = JSON.parse(
        readFileSync(path.join(cacheDirectory, 'reports', 'cache-manifest.json'), 'utf8'),
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
      assert.equal(existsSync(staticMirrorRoot), false);
      assert.equal(manifest.imageDir, '.tmp/content/notes/linux/io-multiplexing/io-basics/images');
      assert.equal(manifest.mirrorPath, undefined);
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

test('locks concurrent cache writes and marks completed cache manifests', async () => {
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

test('rolls cache tree back when publication fails', async () => {
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
    const oldContent = readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8');
    const oldImage = readFileSync(path.join(cacheDirectory, 'images', 'original', 'image-001.png'));

    await assert.rejects(
      cacheImage(temporaryRoot, 'https://cdn.example.test/new.png', {
        ...options,
        renameImpl: async (from, to) => {
          if (to === cacheDirectory) {
            throw new Error('cache publish failed');
          }
          return rename(from, to);
        },
      }),
      /cache publish failed/,
    );
    assert.equal(readFileSync(path.join(cacheDirectory, 'source', 'content.md'), 'utf8'), oldContent);
    assert.deepEqual(readFileSync(path.join(cacheDirectory, 'images', 'original', 'image-001.png')), oldImage);
    assert.equal(existsSync(path.join(temporaryRoot, '.tmp', 'static')), false);
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

test('allows the same article slug under different topics in article cache layout', async () => {
  await withTemporaryCache(async (temporaryRoot) => {
    const options = {
      fetchImpl: async () => new Response('image'),
      resolveHost: async () => [{ address: '8.8.8.8' }],
    };
    await cacheImage(temporaryRoot, 'https://cdn.example.test/first.png', options);
    await cacheNote({
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
    });
    assert.equal(
      existsSync(path.join(
        temporaryRoot,
        '.tmp',
        'content',
        'notes',
        'linux',
        'another-topic',
        'io-basics',
        'reports',
        'cache-manifest.json',
      )),
      true,
    );
    assert.equal(existsSync(path.join(temporaryRoot, '.tmp', 'static')), false);
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

test('migration skill requires share-info confirmation and tmp-only cache', () => {
  const skill = readFileSync(
    path.join(repoRoot, '.cursor', 'skills', 'youdao-note-migration', 'SKILL.md'),
    'utf8',
  );

  assert.match(skill, /--confirmed/);
  assert.match(skill, /只写该文章的 `\.tmp\/content\/notes\/|缓存与临时候选只写/);
  assert.match(skill, /禁止在 `\.tmp\/` 根目录/);
  assert.match(skill, /不直接写 `content\/` 或最终 `static\/`/);
  assert.match(skill, /share-info --share-id|scripts\/share-info\.mjs --share-id/);
  assert.match(skill, /cache-share\.mjs --share-id|cache-share --share-id/);
  assert.match(skill, /公共分享缓存/);
  assert.match(skill, /短链|share\.note\.youdao\.com\/s\//);
  assert.match(skill, /32 位 hex|shareId-or-url/);
  assert.match(skill, /勿.*手动打开浏览器|勿.*打开浏览器/);
  assert.match(skill, /仅支持公共分享|不走私有笔记/);
  assert.doesNotMatch(skill, /\bpreflight\b/);
  assert.doesNotMatch(skill, /search --title/);
  assert.doesNotMatch(skill, /\byoudaonote\b/i);
  assert.doesNotMatch(skill, /API[ -]?[Kk]ey/);
  assert.doesNotMatch(skill, /私有 CLI 缓存/);
  assert.doesNotMatch(skill, /source\/note\.txt/);
  assert.doesNotMatch(skill, /plain-text/);
  assert.doesNotMatch(skill, /必须.*打开浏览器.*短链|短链接必须.*API/);
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

test('resolveShareInput passes through hex share IDs without network access', async () => {
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  let requestCalls = 0;

  assert.equal(
    await resolveShareInput(shareId, {
      requestImpl: async () => {
        requestCalls += 1;
        throw new Error('network must not be used for hex share IDs');
      },
    }),
    shareId,
  );
  assert.equal(
    await resolveShareInput(shareId.toUpperCase(), {
      requestImpl: async () => {
        requestCalls += 1;
        throw new Error('network must not be used for hex share IDs');
      },
    }),
    shareId,
  );
  assert.equal(requestCalls, 0);
});

test('resolveShareInput extracts hex from long share links without following redirects', async () => {
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  let requestCalls = 0;
  const longUrl =
    `https://share.note.youdao.com/ynoteshare/index.html?id=${shareId}&type=note`;

  assert.equal(
    await resolveShareInput(longUrl, {
      requestImpl: async () => {
        requestCalls += 1;
        throw new Error('network must not be used when id is already present');
      },
    }),
    shareId,
  );
  assert.equal(requestCalls, 0);
});

test('resolveShareInput follows a short share URL redirect to a hex share ID', async () => {
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  const shortUrl = 'https://share.note.youdao.com/s/abcShortToken';
  const calls = [];

  const resolved = await resolveShareInput(shortUrl, {
    resolveHost: async () => [{ address: '8.8.8.8' }],
    requestImpl: async (url, options) => {
      calls.push({ url, address: options.address });
      return {
        status: 302,
        headers: {
          location: `https://share.note.youdao.com/ynoteshare/index.html?id=${shareId}&type=note`,
        },
        stream: Readable.from([]),
        abort: () => {},
      };
    },
  });

  assert.equal(resolved, shareId);
  assert.deepEqual(calls, [{ url: shortUrl, address: '8.8.8.8' }]);
});

test('resolveShareInput rejects illegal hosts and private DNS answers', async () => {
  await assert.rejects(
    resolveShareInput('https://evil.example.test/s/token', {
      resolveHost: async () => [{ address: '8.8.8.8' }],
      requestImpl: async () => {
        throw new Error('network must not be used for illegal hosts');
      },
    }),
    /not allowed/i,
  );

  await assert.rejects(
    resolveShareInput('https://share.note.youdao.com/s/token', {
      resolveHost: async () => [{ address: '127.0.0.1' }],
      requestImpl: async () => {
        throw new Error('network must not be used for private DNS answers');
      },
    }),
    /public address/i,
  );
});

test('resolveShareInput rejects more than three verified redirect hops', async () => {
  let calls = 0;

  await assert.rejects(
    resolveShareInput('https://share.note.youdao.com/s/start', {
      resolveHost: async () => [{ address: '8.8.8.8' }],
      requestImpl: async () => {
        calls += 1;
        return {
          status: 302,
          headers: { location: `https://share.note.youdao.com/s/hop-${calls}` },
          stream: Readable.from([]),
          abort: () => {},
        };
      },
    }),
    /redirect/i,
  );
  assert.equal(calls, 4);
});

test('share-info accepts a short URL by resolving it before reading the share', async () => {
  const output = [];
  const shareId = '2712403aa99569831b6a4e38c73afec6';
  const shortUrl = 'https://share.note.youdao.com/s/cliToken';
  let readShareId;

  await shareInfoMain(
    ['--share-id', shortUrl],
    {
      dependencies: {
        resolveShareInput: async (input) => {
          assert.equal(input, shortUrl);
          return shareId;
        },
        readShare: async (id) => {
          readShareId = id;
          return {
            shareId: id,
            title: 'Resolved short link',
            content: '<p>body</p>',
            rawJson: '{}',
          };
        },
      },
      write: (value) => output.push(value),
    },
  );

  assert.equal(readShareId, shareId);
  assert.deepEqual(JSON.parse(output.pop()), {
    title: 'Resolved short link',
    shareId,
    imageCount: 0,
  });
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
      cacheShareMain(
        ['--share-id', shareId, '--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'],
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

  await shareInfoMain(
    ['--share-id', shareId],
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
    'formatChanges',
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
  assert.deepEqual(template.properties.formatChanges.items.required, [
    'category',
    'location',
    'sourceExcerpt',
    'reason',
    'status',
    'approvalId',
  ]);
  assert.deepEqual(template.properties.formatChanges.items.properties.location, {
    type: 'string',
    minLength: 1,
  });
  assert.deepEqual(template.properties.formatChanges.items.properties.sourceExcerpt, {
    type: 'string',
    minLength: 1,
  });
  assert.match(
    template.properties.images.items.properties.cachePath.pattern,
    /images\/\(original\|generated\)/,
  );
  assert.deepEqual(template.properties.formatChanges.items.properties.category.enum, [
    'heading-structure',
    'emphasis-syntax',
    'chinese-punctuation',
    'code-fence-comments',
    'other-format',
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
  assert.deepEqual(template.properties.images.items.properties.decision.enum, [
    'preserve-original',
    'markdown-transcription',
    'redraw-candidate',
    'alternate-expression',
    'blocked',
  ]);
  assert.deepEqual(template.properties.images.items.properties.expressionForm, {
    type: 'string',
    minLength: 1,
  });
  assert.equal(
    template.properties.images.items.allOf[0].then.required.includes('expressionForm'),
    true,
  );
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
    formatChanges: [],
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
        cachePath: '.tmp/content/notes/linux/io-multiplexing/io-basics/images/original/image-001.png',
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
    '### 1.2. Extra',
    '',
    '![I/O diagram](/images/notes/linux/io-basics/image-001.png)',
    '',
    '## 2. Follow-up',
    '### 2.1. Notes',
  ].join('\n');
}

test('draft validator accepts mapped output with Hugo heading and image paths', () => {
  const draft = createApprovedDraft();
  const markdown = createApprovedMarkdown();

  assert.doesNotThrow(() => validateDraftMetadata(draft, draftValidationOptions));
  assert.doesNotThrow(() => validateDraftOutput(draft, markdown, draftValidationOptions));
});

test('draft validator accepts alternate-expression when expressionForm is recorded', () => {
  const draft = createApprovedDraft();
  draft.images[0].decision = 'alternate-expression';
  draft.images[0].expressionForm = 'table';
  draft.images[0].finalPath = 'static/images/notes/linux/io-basics/image-001.png';
  const markdown = createApprovedMarkdown().replace(
    '![I/O diagram](/images/notes/linux/io-basics/image-001.png)',
    '![I/O diagram](/images/notes/linux/io-basics/image-001.png)\n\n| col |\n| --- |\n| val |',
  );

  assert.doesNotThrow(() => validateDraftMetadata(draft, draftValidationOptions));
  assert.doesNotThrow(() => validateDraftOutput(draft, markdown, draftValidationOptions));
});

test('draft validator accepts approved formatChanges by category with unique approvals', () => {
  const draft = createApprovedDraft();
  draft.approval.approvals.push(
    {
      id: 'approval-format-heading',
      status: 'approved',
      recordedAt: '2026-07-11T08:00:00Z',
      confirmedBy: 'wunianor',
      confirmedAt: '2026-07-11T08:00:00Z',
    },
    {
      id: 'approval-format-punctuation',
      status: 'approved',
      recordedAt: '2026-07-11T08:00:00Z',
      confirmedBy: 'wunianor',
      confirmedAt: '2026-07-11T08:00:00Z',
    },
    {
      id: 'approval-format-punctuation-2',
      status: 'approved',
      recordedAt: '2026-07-11T08:00:00Z',
      confirmedBy: 'wunianor',
      confirmedAt: '2026-07-11T08:00:00Z',
    },
  );
  draft.formatChanges = [
    {
      category: 'heading-structure',
      location: '## 1. shell',
      sourceExcerpt: '## 1. shell\n### 1.1. only-child\n#### 1.1.1. deeper',
      reason: 'Flatten a single top-level ## shell',
      status: 'approved',
      approvalId: 'approval-format-heading',
    },
    {
      category: 'chinese-punctuation',
      location: 'paragraph after ### 1.1.',
      sourceExcerpt: '例如, 这里',
      reason: 'Use Chinese punctuation outside code spans',
      status: 'approved',
      approvalId: 'approval-format-punctuation',
    },
    {
      category: 'chinese-punctuation',
      location: 'paragraph after #### 1.1.1.',
      sourceExcerpt: '另外; 还有',
      reason: 'Second punctuation instance confirmed separately',
      status: 'approved',
      approvalId: 'approval-format-punctuation-2',
    },
  ];

  assert.doesNotThrow(() => validateDraftMetadata(draft, draftValidationOptions));
  assert.doesNotThrow(() => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions));
});

test('draft validator accepts generated cachePath for redraw-candidate images', () => {
  const draft = createApprovedDraft();
  draft.images[0].decision = 'redraw-candidate';
  draft.images[0].cachePath =
    '.tmp/content/notes/linux/io-multiplexing/io-basics/images/generated/image-001.png';

  assert.doesNotThrow(() => validateDraftMetadata(draft, draftValidationOptions));
  assert.doesNotThrow(() => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions));
});

test('draft metadata requires per-instance formatChanges approvals', () => {
  const cases = [
    {
      name: 'missing formatChanges array',
      mutate: (draft) => {
        delete draft.formatChanges;
      },
      expected: /formatChanges/,
    },
    {
      name: 'unknown format category',
      mutate: (draft) => {
        draft.formatChanges = [{
          category: 'rewrite-style',
          location: 'body',
          sourceExcerpt: 'text',
          reason: 'not allowed',
          status: 'approved',
          approvalId: 'approval-1',
        }];
      },
      expected: /formatChanges\[0\]\.category/,
    },
    {
      name: 'missing location',
      mutate: (draft) => {
        draft.formatChanges = [{
          category: 'emphasis-syntax',
          sourceExcerpt: '**text,**',
          reason: 'fix punctuation adjacency',
          status: 'approved',
          approvalId: 'approval-1',
        }];
      },
      expected: /formatChanges\[0\]\.location/,
    },
    {
      name: 'missing sourceExcerpt',
      mutate: (draft) => {
        draft.formatChanges = [{
          category: 'emphasis-syntax',
          location: 'paragraph 1',
          reason: 'fix punctuation adjacency',
          status: 'approved',
          approvalId: 'approval-1',
        }];
      },
      expected: /formatChanges\[0\]\.sourceExcerpt/,
    },
    {
      name: 'shared approvalId across format changes',
      mutate: (draft) => {
        draft.formatChanges = [
          {
            category: 'emphasis-syntax',
            location: 'first',
            sourceExcerpt: '**a,**',
            reason: 'first',
            status: 'approved',
            approvalId: 'approval-1',
          },
          {
            category: 'code-fence-comments',
            location: 'second',
            sourceExcerpt: '作用:',
            reason: 'second',
            status: 'approved',
            approvalId: 'approval-1',
          },
        ];
      },
      expected: /formatChanges\[1\]\.approvalId.*unique per format/i,
    },
    {
      name: 'missing format approvalId',
      mutate: (draft) => {
        draft.formatChanges = [{
          category: 'other-format',
          location: 'body',
          sourceExcerpt: 'snippet',
          reason: 'misc',
          status: 'approved',
        }];
      },
      expected: /formatChanges\[0\]\.approvalId/,
    },
    {
      name: 'rejects legacy static mirror cachePath',
      mutate: (draft) => {
        draft.images[0].cachePath = '.tmp/static/images/notes/linux/io-basics/image-001.png';
      },
      expected: /images\[0\]\.cachePath/,
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = createApprovedDraft();
    mutate(draft);
    assert.throws(() => validateDraftMetadata(draft, draftValidationOptions), expected, name);
  }
});

test('draft output rejects formatChanges that are not approved', () => {
  const draft = createApprovedDraft();
  draft.approval.approvals.push({
    id: 'approval-format-pending',
    status: 'pending',
    recordedAt: '2026-07-11T08:00:00Z',
    confirmedBy: 'wunianor',
    confirmedAt: '2026-07-11T08:00:00Z',
  });
  draft.formatChanges = [{
    category: 'heading-structure',
    location: '## 1. pending shell',
    sourceExcerpt: '## 1. pending shell\n### 1.1. child',
    reason: 'pending flatten plan',
    status: 'approved',
    approvalId: 'approval-format-pending',
  }];

  assert.throws(
    () => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions),
    /formatChanges\[0\]\.approvalId/,
  );

  draft.formatChanges[0].approvalId = 'approval-1';
  draft.formatChanges[0].status = 'pending';
  assert.throws(
    () => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions),
    /formatChanges\[0\]\.status/,
  );
});

test('draft metadata requires per-image approvals and alternate-expression form', () => {
  const cases = [
    {
      name: 'missing image approvalId',
      mutate: (draft) => {
        delete draft.images[0].approvalId;
      },
      expected: /images\[0\]\.approvalId/,
    },
    {
      name: 'shared approvalId across images',
      mutate: (draft) => {
        draft.images.push({
          source: 'https://cdn.example.test/io-2.png',
          cachePath: '.tmp/content/notes/linux/io-multiplexing/io-basics/images/original/image-002.png',
          finalPath: 'static/images/notes/linux/io-basics/image-002.png',
          sourceSectionRef: 'source-1',
          decision: 'preserve-original',
          status: 'approved',
          approvalId: 'approval-1',
        });
      },
      expected: /images\[1\]\.approvalId.*unique per image/i,
    },
    {
      name: 'unknown image decision',
      mutate: (draft) => {
        draft.images[0].decision = 'keep-all';
      },
      expected: /images\[0\]\.decision/,
    },
    {
      name: 'alternate-expression without expressionForm',
      mutate: (draft) => {
        draft.images[0].decision = 'alternate-expression';
      },
      expected: /images\[0\]\.expressionForm/,
    },
    {
      name: 'expressionForm on preserve-original',
      mutate: (draft) => {
        draft.images[0].expressionForm = 'table';
      },
      expected: /images\[0\]\.expressionForm/,
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const draft = createApprovedDraft();
    mutate(draft);
    assert.throws(() => validateDraftMetadata(draft, draftValidationOptions), expected, name);
  }
});

test('draft output rejects images whose approval is not approved', () => {
  const draft = createApprovedDraft();
  draft.approval.approvals.push({
    id: 'approval-image-pending',
    status: 'pending',
    recordedAt: '2026-07-11T08:00:00Z',
    confirmedBy: 'wunianor',
    confirmedAt: '2026-07-11T08:00:00Z',
  });
  draft.images[0].approvalId = 'approval-image-pending';
  draft.images[0].status = 'approved';

  assert.throws(
    () => validateDraftOutput(draft, createApprovedMarkdown(), draftValidationOptions),
    /images\[0\]\.approvalId/,
  );
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
      name: 'format change blocked',
      mutate: (draft) => {
        draft.formatChanges = [{
          category: 'emphasis-syntax',
          location: 'blocked emphasis',
          sourceExcerpt: '**text,**',
          reason: 'blocked emphasis fix',
          status: 'blocked',
          approvalId: 'approval-1',
        }];
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
      /approval|formatChanges|contentChanges|images/,
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
      markdown: () => `${createApprovedMarkdown()}\n## 4. Another section`,
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
        '### 1.1. Details\n#### 1.1.1. Example\n### 1.2. Extra\n\n',
        '### Details\n### 1.2. Extra\n\n',
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

function markdownWithFrontMatter(body, { allowSoleTopLevelHeading = false } = {}) {
  const headingCount = String(body)
    .split(/\r?\n/)
    .filter((line) => /^## \d+\./.test(line))
    .length;
  const normalizedBody =
    allowSoleTopLevelHeading || headingCount !== 1
      ? body
      : `${String(body).trimEnd()}\n\n## 2. More\n### 2.1. Note`;
  return [
    '---',
    'title: "I/O basics"',
    'description: "Basics of Linux I/O"',
    'date: "2026-07-11"',
    'draft: false',
    'type: "note"',
    'weight: 10',
    'categories:',
    '  - "linux"',
    'tags:',
    '  - "io"',
    '---',
    '',
    normalizedBody,
    '',
    '![I/O diagram](/images/notes/linux/io-basics/image-001.png)',
  ].join('\n');
}

function draftWithApprovedHeadingStructure() {
  const draft = createApprovedDraft();
  draft.approval.approvals.push({
    id: 'approval-format-heading',
    status: 'approved',
    recordedAt: '2026-07-11T08:00:00Z',
    confirmedBy: 'wunianor',
    confirmedAt: '2026-07-11T08:00:00Z',
  });
  draft.formatChanges = [{
    category: 'heading-structure',
    location: 'top-level ## shells',
    sourceExcerpt: '## 1. Shell A\n### 1.1. Real chapter',
    reason: 'Flatten top-level ## shells',
    status: 'approved',
    approvalId: 'approval-format-heading',
  }];
  return draft;
}

test('heading-structure gate fails on unfixed top-level ## shells without approval', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Shell A',
    '### 1.1. Real chapter',
    '#### 1.1.1. First',
    '#### 1.1.2. Second',
    '## 2. Shell B',
    '### 2.1. Other chapter',
    '#### 2.1.1. Nested',
  ].join('\n'));

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /heading-structure/,
  );
});

test('heading-structure gate passes unfixed top-level ## shells when category is approved', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Shell A',
    '### 1.1. Real chapter',
    '#### 1.1.1. First',
    '#### 1.1.2. Second',
    '## 2. Shell B',
    '### 2.1. Other chapter',
    '#### 2.1.1. Nested',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(draftWithApprovedHeadingStructure(), markdown, draftValidationOptions);
  });
});

test('heading-structure gate passes already-flattened multi-section markdown without the category', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Real chapter A',
    '### 1.1. First',
    '### 1.2. Second',
    '## 2. Real chapter B',
    '### 2.1. Nested',
    '### 2.2. More',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('heading-structure gate fails on sole top-level ## without approval', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Sole shell',
    '### 1.1. Intermediate',
    '#### 1.1.1. First',
    '#### 1.1.2. Second',
  ].join('\n'), { allowSoleTopLevelHeading: true });

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /heading-structure/,
  );
});

test('heading-structure gate passes sole top-level ## when category is approved', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Sole shell',
    '### 1.1. Intermediate',
    '#### 1.1.1. First',
    '#### 1.1.2. Second',
  ].join('\n'), { allowSoleTopLevelHeading: true });

  assert.doesNotThrow(() => {
    validateDraftOutput(draftWithApprovedHeadingStructure(), markdown, draftValidationOptions);
  });
});

test('heading-structure gate fails on sole ## with body only without approval', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Overview',
    '',
    'Body under the sole top-level heading.',
  ].join('\n'), { allowSoleTopLevelHeading: true });

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /heading-structure/,
  );
});

test('heading-structure gate ignores deeper ### single-child nests alone', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section A',
    '### 1.1. First',
    '### 1.2. Parent with one child',
    '#### 1.2.1. Only grandchild',
    '## 2. Section B',
    '### 2.1. Alpha',
    '### 2.2. Beta',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('heading-structure gate ignores ## with a single ### that has no further subheadings', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section A',
    '### 1.1. Only child with body text only',
    '',
    'Body under the sole ###.',
    '## 2. Section B',
    '### 2.1. Alpha',
    '### 2.2. Beta',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

function draftWithApprovedFormatCategory(category, reason = `Approved ${category}`) {
  const draft = createApprovedDraft();
  const approvalId = `approval-format-${category}`;
  draft.approval.approvals.push({
    id: approvalId,
    status: 'approved',
    recordedAt: '2026-07-11T08:00:00Z',
    confirmedBy: 'wunianor',
    confirmedAt: '2026-07-11T08:00:00Z',
  });
  draft.formatChanges = [{
    category,
    location: `format gate for ${category}`,
    sourceExcerpt: `excerpt for ${category}`,
    reason,
    status: 'approved',
    approvalId,
  }];
  return draft;
}

test('emphasis-syntax gate fails on punctuation jammed into bold markers', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '1.**(最重要)能管理的fd数量太少了,**',
  ].join('\n'));

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /emphasis-syntax/,
  );
});

test('emphasis-syntax gate fails on unclosed emphasis outside code', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '这是 **未闭合的强调',
  ].join('\n'));

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /emphasis-syntax/,
  );
});

test('emphasis-syntax gate ignores emphasis markers inside code fences and inline code', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    'Use `**literal**` and:',
    '```',
    '**not emphasis,**',
    '```',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('emphasis-syntax gate passes broken emphasis when category is approved', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    // Chinese fullwidth comma still trips emphasis adjacency, but not chinese-punctuation.
    '**文本，**',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(
      draftWithApprovedFormatCategory('emphasis-syntax', 'Fix emphasis punctuation'),
      markdown,
      draftValidationOptions,
    );
  });
});

test('emphasis-syntax gate passes clean markdown without the category', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '**重要**，其余正常。',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('chinese-punctuation gate fails on ASCII comma beside Chinese text', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '这是中文,还有下文。',
  ].join('\n'));

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /chinese-punctuation/,
  );
});

test('chinese-punctuation gate ignores ASCII punct in code, URLs, and numbering dots', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '见文档 https://example.com/a,b 与 `foo,bar`。',
    '版本 2.0 可用。',
    '```c',
    'int x = 1, y = 2;',
    '```',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('chinese-punctuation gate passes dirty prose when category is approved', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '你好;世界!',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(
      draftWithApprovedFormatCategory('chinese-punctuation'),
      markdown,
      draftValidationOptions,
    );
  });
});

test('chinese-punctuation gate passes clean Chinese punctuation without the category', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '你好，世界！这是正常中文。',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('code-fence-comments gate fails on Chinese annotation lines without comment syntax', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '```c',
    '作用: 演示 select',
    '参数: nfds',
    'int select(int nfds);',
    '```',
  ].join('\n'));

  assert.throws(
    () => validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions),
    /code-fence-comments/,
  );
});

test('code-fence-comments gate passes when annotations use language comment syntax', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '```c',
    '// 作用: 演示 select',
    '// 参数: nfds',
    'int select(int nfds);',
    '```',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('code-fence-comments gate ignores text fences and real code without annotation prefixes', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '```text',
    '作用: 这不是代码',
    '```',
    '```c',
    'int 参数 = 1;',
    'printf("hello");',
    '```',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(createApprovedDraft(), markdown, draftValidationOptions);
  });
});

test('code-fence-comments gate passes dirty fences when category is approved', () => {
  const markdown = markdownWithFrontMatter([
    '## 1. Section',
    '### 1.1. Details',
    '',
    '```python',
    '说明: 入口',
    'def main():',
    '    pass',
    '```',
  ].join('\n'));

  assert.doesNotThrow(() => {
    validateDraftOutput(
      draftWithApprovedFormatCategory('code-fence-comments'),
      markdown,
      draftValidationOptions,
    );
  });
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
    await validateDraftMain(['--draft', 'draft.json', '--markdown', 'article.md'], {
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
        formatChanges: 0,
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
      validateDraftMain(['--draft', '../draft.json', '--markdown', 'article.md'], {
        repoRoot: temporaryRoot,
      }),
      /draft.*repository root/i,
    );
    await assert.rejects(
      validateDraftMain(['--draft', 'draft.json', '--markdown', 'C:\\outside.md'], {
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
          SCRIPT_PATHS['validate-draft'],
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
    await checkNoteMain(
      [
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
      checkNoteMain(
        [
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
      checkNoteMain(
        [
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
      checkNoteMain(
        [
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
      checkNoteMain(
        [
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
      checkNoteMain(
        [
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
    await checkNoteMain(
      [
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
      checkNoteMain(
        [
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
  await checkSiteMain([], {
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
    checkSiteMain([], {
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
      return { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' };
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
  await gitReadinessMain(
    [
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
    branch: 'docs/linux_io-multiplexing_io-basics',
    changedPaths: [
      'content/notes/linux/io-multiplexing/io-basics.md',
      'static/images/notes/linux/io-basics/image-001.png',
      RULES_REPO_PATH,
    ],
  });
  await assert.rejects(
    gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', '../escape'], {
      repoRoot,
      dependencies: { runProcess },
    }),
    /articleSlug/i,
  );
  await assert.rejects(
    gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot,
      dependencies: {
        runProcess: async (_command, argumentsList) =>
          argumentsList[0] === 'branch'
            ? { exitCode: 0, stdout: 'main\n', stderr: '' }
            : { exitCode: 0, stdout: '?? .tmp/escape.md\n', stderr: '' },
      },
    }),
    /branch.*docs\/linux_io-multiplexing_io-basics/i,
  );
  await assert.rejects(
    gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot,
      dependencies: {
        runProcess: async (_command, argumentsList) =>
          argumentsList[0] === 'branch'
            ? { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' }
            : { exitCode: 0, stdout: '?? .tmp/escape.md\n', stderr: '' },
      },
    }),
    /unexpected changed paths.*\.tmp/i,
  );
  await assert.rejects(
    gitReadinessMain(
      [
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
              ? { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' }
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
      return { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' };
    }
    if (argumentsList[0] === 'status') {
      return { exitCode: 0, stdout: '?? .tmp/force-added.txt\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
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
        return { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    let output = '';
    await gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
      repoRoot: temporaryRoot,
      dependencies: { runProcess: cleanGitRunner },
      write: (value) => {
        output += value;
      },
    });
    assert.deepEqual(JSON.parse(output).changedPaths, []);
    rmSync(path.join(temporaryRoot, '.tmp'), { force: true, recursive: true });
    await assert.rejects(
      gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
        repoRoot: temporaryRoot,
        dependencies: {
          runProcess: async (_command, argumentsList) => {
            if (argumentsList[0] === 'branch') {
              return { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' };
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
      gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
        repoRoot: temporaryRoot,
        dependencies: {
          runProcess: async (_command, argumentsList) => {
            if (argumentsList[0] === 'branch') {
              return { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' };
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
        ? { exitCode: 0, stdout: 'docs/linux_io-multiplexing_io-basics\n', stderr: '' }
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
        gitReadinessMain(['--category', 'linux', '--topic', 'io-multiplexing', '--article', 'io-basics'], {
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
      [SCRIPT_PATHS['check-note']],
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
  assert.match(skill, /公共分享缓存/);
  assert.match(skill, /仅支持公共分享/);
  assert.match(skill, /短链/);
  assert.match(skill, /shareId-or-url/);
  assert.match(skill, /勿.*手动打开浏览器|勿.*打开浏览器/);
  assert.doesNotMatch(skill, /私有 CLI 缓存/);
  assert.doesNotMatch(skill, /API[ -]?[Kk]ey/);
  assert.doesNotMatch(skill, /必须.*打开浏览器.*短链|短链接必须.*API/);
  assert.match(skill, /变更计划/);
  assert.match(skill, /确认后.*当前仓库.*交付分支|当前仓库切换到交付分支/);
  assert.doesNotMatch(skill, /独立 worktree/);
  assert.match(skill, /不得.*生成.*重排.*纠错.*正文.*确认/);
  assert.match(skill, /内容 source 读取后.*headingPath/);
  assert.match(skill, /候选 Markdown 与缓存来源逐段落|与缓存来源逐段落/);
  assert.match(skill, /差异检查清单/);
  assert.match(skill, /validate-draft/);
  assert.match(skill, /格式门禁|heading-structure.*emphasis-syntax|顶层标题空壳/);
  assert.match(skill, /不得声称机器验证器能证明/);
  assert.match(protocol, /输入\/输出契约/);
  assert.match(protocol, /公共分享缓存/);
  assert.match(protocol, /短链或 hex|App 短链或 hex/);
  assert.match(protocol, /章节.*图片.*溯源/);
  assert.match(protocol, /AI 语义保真审查与确定性门禁/);
  assert.match(protocol, /不能.*证明来源语义保真/);
  assert.match(protocol, /formatChanges/);
  assert.match(protocol, /contentChanges/);
  assert.match(protocol, /heading-structure/);
  assert.match(protocol, /emphasis-syntax/);
  assert.match(protocol, /chinese-punctuation/);
  assert.match(protocol, /code-fence-comments/);
  assert.match(protocol, /逐处确认|location.*sourceExcerpt/);
  assert.match(protocol, /按项确认|内容类.*按项/);
  assert.match(protocol, /格式门禁.*heading-structure|确定性检查确认记录.*格式门禁/);
  assert.match(protocol, /images\/original|images\/generated/);
  assert.doesNotMatch(protocol, /\.tmp\/static/);
  assert.doesNotMatch(protocol, /独立 worktree/);
  assert.doesNotMatch(protocol, /门禁预留字段/);
  assert.match(skill, /formatChanges/);
  assert.match(skill, /contentChanges/);
  assert.match(skill, /heading-structure/);
  assert.match(skill, /emphasis-syntax/);
  assert.match(skill, /chinese-punctuation/);
  assert.match(skill, /code-fence-comments/);
  assert.match(skill, /格式类.*逐处确认|逐处.*formatChanges|逐处提问/);
  assert.match(skill, /内容类.*每项确认|每项确认一次/);
  assert.match(skill, /images\/original|scripts\/|candidates\//);
  assert.doesNotMatch(skill, /\.tmp\/static/);
  assert.match(protocol, /frontMatter/);
  assert.match(protocol, /approvalUserId/);
  assert.match(protocol, /仅允许自动进行的机械变更/);
  assert.match(protocol, /结构性.*事实性.*图片.*不确定/);
  assert.match(protocol, /原样保留.*Markdown 转写.*候选重绘.*用其他方式表达.*阻塞/);
  assert.match(protocol, /alternate-expression/);
  assert.match(protocol, /expressionForm/);
  assert.match(protocol, /每一张.*图片.*AskQuestion|AskQuestion.*每一张/);
  assert.match(protocol, /禁止.*批量默认|禁止.*全部原样保留/);
  assert.match(protocol, /独立.*approvalId/);
  assert.match(protocol, /正文锚点位置|锚点位置必须与原文/);
  assert.match(skill, /每一张.*图.*AskQuestion|AskQuestion.*每一张/);
  assert.match(skill, /alternate-expression/);
  assert.match(skill, /禁止.*全部原样保留|禁止.*批量默认/);
  assert.match(skill, /锚点位置必须与原文|正文中的图片锚点位置/);
  assert.match(protocol, /确认记录/);
  assert.match(protocol, /approvalId/);
  assert.match(protocol, /title:/);
  assert.match(protocol, /## 1\./);
  assert.match(protocol, /### 1\.1\./);
  assert.match(protocol, /#### 1\.1\.1\./);
  assert.match(protocol, /顶层标题扁平化|仅处理顶层.*##|heading-structure/);
  assert.match(protocol, /恰好一个.*###|仅一个.*###/);
  assert.match(protocol, /最顶层.*##.*只出现|唯一顶层.*##|全文.*唯一.*##/);
  assert.match(protocol, /删除该顶层|取消.*顶层.*##|###.*升为.*##/);
  assert.match(protocol, /###` 及以下|### 及以下/);
  assert.match(skill, /docs\/<category-slug>_<topic-slug>_<article-slug>|docs\/\{category\}_\{topic\}_\{article\}/);
  assert.match(protocol, /docs\/<category-slug>_<topic-slug>_<article-slug>|学习笔记所在.*路径|content\/notes/);
  assert.match(protocol, /强调语法|emphasis-syntax/);
  assert.match(protocol, /\*\*文本,\*\*|标点.*强调|强调标记/);
  assert.match(protocol, /中文标点|chinese-punctuation/);
  assert.match(protocol, /代码围栏|行内代码|URL/);
  assert.match(protocol, /代码围栏伪注释|code-fence-comments/);
  assert.match(protocol, /作用:|参数:/);
  assert.match(protocol, /\/images\/notes\/<category-slug>\/<article-slug>\//);
  assert.match(protocol, /不得提交 `\.tmp`/);
  assert.doesNotMatch(protocol, /私有 CLI/);
  assert.doesNotMatch(protocol, /API[ -]?[Kk]ey/);
  assert.doesNotMatch(protocol, /plain-text/);
  assert.doesNotMatch(protocol, /source\/note\.txt/);
  assert.doesNotMatch(protocol, /rawText/);
  assert.doesNotMatch(protocol, /\byoudaonote\b/i);
  assert.match(skill, /当前仓库.*分支 `docs\/|切换到分支 `docs\//);
  assert.match(skill, /逐段落审查|AI.*审查/);
  assert.match(skill, /check-note/);
  assert.match(skill, /--approved-markdown/);
  assert.match(skill, /check-site/);
  assert.match(skill, /git-readiness/);
  assert.match(skill, /validate-draft.*check-note.*check-site.*git-readiness|依次运行 `validate-draft`/);
  assert.match(skill, /路径变更/);
  assert.match(skill, /忽略的.*根目录.*\.tmp.*保留/);
  assert.match(skill, /Git.*报告.*\.tmp.*变更.*阻止/);
  assert.match(skill, /用户明确确认.*git add.*git commit/);
  assert.match(skill, /docs: 新增 <标题> 学习笔记/);
  assert.match(skill, /用户明确.*push.*PR/);
  assert.match(skill, /明确.*合并.*删除/);
  assert.match(skill, /不得自动/);
  assert.match(skill, /share-info.*cache-share.*validate-draft|scripts\/share-info\.mjs/);
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
      cacheImageDir: '.tmp/content/notes/go/concurrency/select/images',
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
    'youdao-note-migration.test.mjs',
    path.join('lib', 'script-utils.mjs'),
    path.join('lib', 'note-check.mjs'),
    path.join('lib', 'paths.mjs'),
    path.join('scripts', 'share-info.mjs'),
    path.join('scripts', 'cache-share.mjs'),
    path.join('scripts', 'paths.mjs'),
    path.join('scripts', 'validate-draft.mjs'),
    path.join('scripts', 'check-note.mjs'),
    path.join('scripts', 'check-site.mjs'),
    path.join('scripts', 'git-readiness.mjs'),
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
  assert.match(skill, /\.cursor\/skills\/youdao-note-migration\/scripts\/validate-draft\.mjs/);
  assert.match(skill, /全部文件均位于/);
});

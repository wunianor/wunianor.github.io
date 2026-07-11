import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function redactSensitiveText(value) {
  return String(value)
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(
      /((?:["'])(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|authorization|secret|password)(?:["'])|(?:\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|authorization|secret|password)\b))\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/gi,
      '$1=<redacted>',
    );
}

async function executeYoudao(argumentsList) {
  return execFileAsync('youdaonote', ['-s', 'ydn', ...argumentsList], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runCommand(argumentsList, execute = executeYoudao) {
  const command = redactSensitiveText(`youdaonote -s ydn ${argumentsList.join(' ')}`);

  try {
    const result = await execute(argumentsList);
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    const exitCode = Number.isInteger(error.code) ? error.code : 'unknown';
    const diagnostic = redactSensitiveText(error.stderr?.trim() || error.message || '')
      .replace(/\s+/g, ' ')
      .slice(0, 240);
    const summary = diagnostic || 'no diagnostic output';
    throw new Error(`${command} failed (exit code ${exitCode}): ${summary}`);
  }
}

export function parseReadResponse(rawJson) {
  if (rawJson.trim() === '') {
    throw new Error('youdaonote read output must be nonempty plaintext or JSON.');
  }

  if (!/^\s*\{\s*(?:"|})/.test(rawJson)) {
    return {
      rawText: rawJson,
      content: rawJson,
      sourceFormat: 'plain-text',
      isRaw: false,
    };
  }

  let parsed;

  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('youdaonote read output begins with JSON syntax but is malformed JSON.');
  }

  if (typeof parsed?.content !== 'string') {
    throw new Error('youdaonote read JSON must contain a string content field.');
  }

  return {
    rawJson,
    content: parsed.content,
  };
}

export async function preflightYoudao({ execute } = {}) {
  const list = await runCommand(['list'], execute);
  const version = await runCommand(['version'], execute);
  const check = await runCommand(['check', '--json'], execute);
  let health;

  try {
    health = JSON.parse(check.stdout);
  } catch {
    throw new Error('youdaonote check --json output is not valid JSON.');
  }

  return {
    version: version.stdout.trim(),
    healthCheck: { ok: health?.ok === true },
    rootsListed: list.stdout.trim() !== '' || list.stderr.trim() === '',
  };
}

export async function searchYoudao(title, { execute } = {}) {
  return runCommand(['search', title], execute);
}

export async function readYoudaoNote(fileId, { execute } = {}) {
  const result = await runCommand(['read', fileId], execute);
  return parseReadResponse(result.stdout);
}

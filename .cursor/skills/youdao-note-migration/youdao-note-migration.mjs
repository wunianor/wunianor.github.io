import { runCli } from './lib/cli.mjs';

const argumentsList = process.argv.slice(2);

try {
  await runCli(argumentsList);
} catch (error) {
  if (argumentsList[0] === 'validate-draft') {
    process.stderr.write(`${JSON.stringify({ valid: false, error: error.message })}\n`);
  } else if (['check-note', 'check-site', 'git-readiness'].includes(argumentsList[0])) {
    process.stderr.write(
      `${JSON.stringify({ valid: false, command: argumentsList[0], error: error.message })}\n`,
    );
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
  process.exitCode = 1;
}

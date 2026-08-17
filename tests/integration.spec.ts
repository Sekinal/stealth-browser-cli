/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { test, expect } from '@playwright/test';

type CliResult = {
  output: string;
  error: string;
  exitCode: number | null;
};

async function runCli(...args: string[]): Promise<CliResult> {
  return runCliWithOptions({}, ...args);
}

async function runCliWithOptions(options: { env?: NodeJS.ProcessEnv, cwd?: string }, ...args: string[]): Promise<CliResult> {
  const cliPath = path.join(__dirname, '../playwright-cli.js');

  return new Promise<CliResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const childProcess = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        PLAYWRIGHT_CLI_BROWSER_PROVIDER: process.env.PLAYWRIGHT_CLI_BROWSER_PROVIDER || 'patchright',
        PLAYWRIGHT_CLI_INSTALLATION_FOR_TEST: test.info().outputPath(),
        PWTEST_DAEMON_SESSION_DIR: path.join(test.info().outputPath(), 'daemon'),
        NO_UPDATE_NOTIFIER: '1',
        ...options.env,
      },
      cwd: options.cwd ?? test.info().outputPath(),
    });

    childProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code) => {
      resolve({
        output: stdout.trim(),
        error: stderr.trim(),
        exitCode: code,
      });
    });

    childProcess.on('error', reject);
  });
}

test('open data URL', async ({}) => {
  expect(await runCli('open', 'data:text/html,hello', '--persistent')).toEqual(expect.objectContaining({
    output: expect.stringContaining('hello'),
    exitCode: 0,
  }));

  expect(await runCli('delete-data')).toEqual(expect.objectContaining({
    output: expect.stringContaining('Deleted user data for'),
    exitCode: 0,
  }));
});

test('warns when installed skill is out of date', async ({}) => {
  expect(await runCli('install', '--skills')).toEqual(expect.objectContaining({
    exitCode: 0,
  }));

  const skillFile = path.join(test.info().outputPath(), '.claude', 'skills', 'playwright-cli', 'SKILL.md');
  fs.appendFileSync(skillFile, 'x');

  expect(await runCli('--help')).toEqual(expect.objectContaining({
    error: expect.stringContaining('does not match the tool version'),
  }));
});

test('browser provider selection respects explicit config', async ({}) => {
  const providers = require('../browserProviders');

  expect(providers.resolveProviderOrder(undefined)).toEqual(['cloakbrowser']);
  expect(providers.resolveProviderOrder('camoufox,patchright')).toEqual(['camoufox', 'patchright']);

  expect(providers.hasExplicitBrowserConfig(['open', '--browser=firefox'], {})).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open', '--config', 'cli.json'], {})).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open'], { PLAYWRIGHT_MCP_BROWSER: 'firefox' })).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open'], {})).toBe(false);

  expect(providers.createProviderState('open', ['open'], {}).enabled).toBe(true);
  expect(providers.createProviderState('open', ['open', '--browser=webkit'], {}).enabled).toBe(false);
  expect(providers.createProviderState('close', ['close'], {}).enabled).toBe(false);
});

test('recovers provider identity from browser config when metadata is missing', async ({}) => {
  const { inferProviderDetails } = require('../cliEnhancements');
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { channel: 'chrome-for-testing' } },
  })).toEqual({ name: 'patchright', version: '1.61.1' });
  expect(inferProviderDetails({
    browser: { browserName: 'firefox', launchOptions: { executablePath: '/cache/camoufox/camoufox-bin' } },
  })).toEqual({ name: 'camoufox', version: '0.10.2' });
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { executablePath: '/cache/.cloakbrowser/chrome' } },
  })).toEqual({ name: 'cloakbrowser', version: '0.5.3' });
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { args: ['--fingerprint={"seed":42}'] } },
  })).toEqual({ name: 'cloakbrowser', version: '0.5.3' });
  expect(inferProviderDetails({
    browser: { browserName: 'chromium', launchOptions: { channel: 'chrome' } },
  })).toBeUndefined();
});

test('reports declared versions when an optional provider package is unavailable', async ({}) => {
  const { providerVersion } = require('../browserProviders');
  expect(providerVersion('camoufox', () => {
    throw new Error('optional package is not installed');
  })).toBe('0.10.2');
});

test('waits for a missing Camoufox browser installation before continuing', async ({}) => {
  const { ensureCamoufoxInstalled } = require('../browserProviders');
  let installed = false;
  let installCompleted = false;

  class CamoufoxFetcher {
    async install() {
      await new Promise(resolve => setTimeout(resolve, 10));
      installed = true;
      installCompleted = true;
    }
  }

  const downloaded = await ensureCamoufoxInstalled({
    camoufoxPath: () => {
      if (!installed)
        throw new Error('Camoufox executable not found');
      return '/cached/camoufox';
    },
    CamoufoxFetcher,
  });
  expect(downloaded).toBe(true);
  expect(installCompleted).toBe(true);

  expect(await ensureCamoufoxInstalled({
    camoufoxPath: () => '/cached/camoufox',
    CamoufoxFetcher,
  })).toBe(false);
});

test('Camoufox daemon adapter exposes the Playwright session to the CLI registry', async ({}) => {
  const { camoufoxStartDaemon } = require('../browserProviders');
  const daemonDir = path.join(test.info().outputPath(), 'cli-daemon');
  const playwrightDaemonDir = path.join(test.info().outputPath(), 'playwright-daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.mkdirSync(playwrightDaemonDir, { recursive: true });

  const fallback = {
    requested: 'cloakbrowser',
    active: 'camoufox',
    reason: 'cloakbrowser: missing; patchright: failed',
  };
  const startDaemon = camoufoxStartDaemon({
    sessionModule: {
      Session: {
        startDaemon: async () => {
          fs.writeFileSync(path.join(playwrightDaemonDir, 'camoufox.session'), '{"name":"camoufox"}');
          return { pid: 42, sessionName: 'camoufox' };
        },
      },
    },
    registryModule: {
      createClientInfo: () => ({ daemonProfilesDir: playwrightDaemonDir }),
    },
  }, { PLAYWRIGHT_CLI_BROWSER_PROVIDER_FALLBACK: JSON.stringify(fallback) });

  expect(await startDaemon({ daemonProfilesDir: daemonDir }, {}, 'open')).toEqual({
    pid: 42,
    sessionName: 'camoufox',
  });
  expect(fs.readFileSync(path.join(daemonDir, 'camoufox.session'), 'utf8')).toBe('{"name":"camoufox"}');
  expect(JSON.parse(fs.readFileSync(path.join(playwrightDaemonDir, 'camoufox.provider.json'), 'utf8'))).toEqual({
    provider: 'camoufox',
    version: '0.10.2',
    fallback,
  });
});

test('Camoufox disables WebGL sampling when its optional SQLite binding is unavailable', async ({}) => {
  const { camoufoxLaunchOptions } = require('../browserProviders');
  const calls: unknown[] = [];
  const options = await camoufoxLaunchOptions(async (value: unknown) => {
    calls.push(value);
    if (calls.length === 1)
      throw new Error('Could not locate the bindings file: better_sqlite3.node');
    return { executablePath: '/cached/camoufox', ...value as object };
  });

  expect(calls).toEqual([
    { headless: true, env: {} },
    { headless: true, env: {}, block_webgl: true, i_know_what_im_doing: true },
  ]);
  expect(options).toEqual(expect.objectContaining({
    executablePath: '/cached/camoufox',
    block_webgl: true,
  }));
});

test('does not warn when installed skill only differs in line endings', async ({}) => {
  expect(await runCli('install', '--skills')).toEqual(expect.objectContaining({
    exitCode: 0,
  }));

  const skillFile = path.join(test.info().outputPath(), '.claude', 'skills', 'playwright-cli', 'SKILL.md');
  fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf8').replace(/\n/g, '\r\n'));

  expect(await runCli('--help')).toEqual(expect.objectContaining({
    error: expect.not.stringContaining('does not match the tool version'),
  }));
});

test('provider fallbacks include activation and launch failure reasons', async ({}) => {
  const { configureBrowserProviderFallbacks, readProviderFallback } = require('../browserProviders');

  const activationEnv: NodeJS.ProcessEnv = {
    PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'cloakbrowser,patchright',
  };
  let activationError = '';
  class ActivationSession {
    static async startDaemon() {
      return { pid: 1, sessionName: 'default' };
    }
  }
  await configureBrowserProviderFallbacks({
    command: 'open',
    env: activationEnv,
    sessionModule: { Session: ActivationSession },
    stderr: { write: (value: string) => activationError += value },
    activateProvider: async (_state: unknown, provider: string, env: NodeJS.ProcessEnv) => {
      if (provider === 'cloakbrowser')
        throw new Error('Cloak executable was not found');
      env.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER = provider;
    },
  });
  expect(activationError).toContain("'cloakbrowser' is unavailable (Cloak executable was not found)");
  expect(activationEnv.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER).toBe('patchright');
  expect(readProviderFallback(activationEnv)).toEqual({
    requested: 'cloakbrowser',
    active: 'patchright',
    reason: 'cloakbrowser: Cloak executable was not found',
  });

  const multiActivationEnv: NodeJS.ProcessEnv = {
    PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'cloakbrowser,patchright,camoufox',
  };
  await configureBrowserProviderFallbacks({
    command: 'open',
    env: multiActivationEnv,
    sessionModule: { Session: class { static async startDaemon() {} } },
    stderr: { write: () => {} },
    activateProvider: async (_state: unknown, provider: string, env: NodeJS.ProcessEnv) => {
      if (provider === 'cloakbrowser')
        throw new Error('Cloak is missing');
      if (provider === 'patchright')
        throw new Error('Patchright cannot launch');
      env.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER = provider;
    },
  });
  expect(readProviderFallback(multiActivationEnv)).toEqual({
    requested: 'cloakbrowser',
    active: 'camoufox',
    reason: 'cloakbrowser: Cloak is missing; patchright: Patchright cannot launch',
  });

  const launchEnv: NodeJS.ProcessEnv = {
    PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'cloakbrowser,patchright',
  };
  let launchError = '';
  class LaunchSession {
    static async startDaemon() {
      if (launchEnv.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER === 'cloakbrowser')
        throw new Error('Daemon crashed during launch');
      return { pid: 2, sessionName: 'default' };
    }
  }
  await configureBrowserProviderFallbacks({
    command: 'open',
    env: launchEnv,
    sessionModule: { Session: LaunchSession },
    stderr: { write: (value: string) => launchError += value },
    activateProvider: async (_state: unknown, provider: string, env: NodeJS.ProcessEnv) => {
      env.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER = provider;
    },
  });
  await LaunchSession.startDaemon();
  expect(launchError).toContain("'cloakbrowser' failed (Daemon crashed during launch)");
  expect(launchEnv.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER).toBe('patchright');
  expect(readProviderFallback(launchEnv)).toEqual({
    requested: 'cloakbrowser',
    active: 'patchright',
    reason: 'cloakbrowser: Daemon crashed during launch',
  });
});

test('an explicit provider override replaces conflicting upstream browser environment', async ({}) => {
  const { configureBrowserProviderFallbacks } = require('../browserProviders');
  const env: NodeJS.ProcessEnv = {
    PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'patchright',
    PLAYWRIGHT_MCP_BROWSER: 'chromium',
    PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/wrong/browser',
  };
  class Session {
    static async startDaemon() {
      return { pid: 1, sessionName: 'default' };
    }
  }

  await configureBrowserProviderFallbacks({
    command: 'open',
    env,
    sessionModule: { Session },
  });
  expect(env.PLAYWRIGHT_MCP_BROWSER).toBeUndefined();
  expect(env.PLAYWRIGHT_MCP_EXECUTABLE_PATH).toBeUndefined();
  expect(env.PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER).toBe('patchright');
});

test('structured output reports and persists provider fallback provenance', async ({}) => {
  const missingCloak = path.join(test.info().outputPath(), 'missing-cloak');
  const opened = await runCliWithOptions({
    env: {
      PLAYWRIGHT_CLI_BROWSER_PROVIDER: 'cloakbrowser,patchright',
      CLOAKBROWSER_BINARY_PATH: missingCloak,
    },
  }, '-s=fallback-json', 'open', 'data:text/html,<title>Fallback</title>', '--json');
  expect(opened.exitCode).toBe(0);
  expect(opened.error).toContain("falling back to 'patchright'");
  expect(JSON.parse(opened.output)).toEqual(expect.objectContaining({
    ok: true,
    provider: { name: 'patchright', version: '1.61.1' },
    fallback: {
      requested: 'cloakbrowser',
      active: 'patchright',
      reason: expect.stringContaining(missingCloak),
    },
  }));

  const evaluated = await runCli('-s=fallback-json', 'eval', '() => document.title', '--json');
  expect(JSON.parse(evaluated.output)).toEqual(expect.objectContaining({
    ok: true,
    provider: { name: 'patchright', version: '1.61.1' },
    fallback: {
      requested: 'cloakbrowser',
      active: 'patchright',
      reason: expect.stringContaining(missingCloak),
    },
  }));

  const failed = await runCli('-s=fallback-json', 'eval', '() => { throw new Error("expected failure") }', '--json');
  expect(failed.exitCode).toBe(1);
  expect(JSON.parse(failed.output)).toEqual(expect.objectContaining({
    ok: false,
    provider: { name: 'patchright', version: '1.61.1' },
    fallback: {
      requested: 'cloakbrowser',
      active: 'patchright',
      reason: expect.stringContaining(missingCloak),
    },
    error: expect.stringContaining('expected failure'),
  }));
  await runCli('-s=fallback-json', 'close');
});

test('reports active provider, re-evaluates it, and lists the provider name', async ({}) => {
  const firstOpen = await runCli('-s=provider-report', 'open', 'data:text/html,<title>First</title>');
  expect(firstOpen).toEqual(expect.objectContaining({
    output: expect.stringContaining('### Browser provider\n- name: patchright\n- version: 1.61.1'),
    exitCode: 0,
  }));

  const daemonRoot = path.join(test.info().outputPath(), 'daemon');
  const metadataRelativePath = fs.readdirSync(daemonRoot, { recursive: true })
      .map(String)
      .find(file => file.endsWith('provider-report.provider.json'));
  expect(metadataRelativePath).toBeTruthy();
  fs.unlinkSync(path.join(daemonRoot, metadataRelativePath!));

  const list = await runCli('list');
  expect(list.output).toContain('browser-type: patchright');
  expect(list.output).not.toContain('browser-type: chrome-for-testing');

  const listJson = JSON.parse((await runCli('list', '--json')).output);
  expect(listJson.result.browsers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'provider-report', browserType: 'patchright' }),
  ]));

  const inferredJson = await runCli('-s=provider-report', 'eval', '() => document.title', '--json');
  expect(JSON.parse(inferredJson.output)).toEqual(expect.objectContaining({
    ok: true,
    provider: { name: 'patchright', version: '1.61.1' },
  }));

  const secondOpen = await runCli('-s=provider-report', 'open', 'data:text/html,<title>Second</title>');
  expect(secondOpen).toEqual(expect.objectContaining({
    error: expect.stringContaining("restarting it to re-evaluate provider order (patchright)"),
    exitCode: 0,
  }));

  await runCli('-s=provider-report', 'close');
});

test('emits stable structured output with page metadata and provider details', async ({}) => {
  const opened = await runCli('-s=json-output', 'open', 'data:text/html,<title>Structured</title><h1>Hello</h1>', '--json');
  const openJson = JSON.parse(opened.output);
  expect(openJson).toEqual(expect.objectContaining({
    ok: true,
    title: 'Structured',
    console: [],
    provider: { name: 'patchright', version: '1.61.1' },
    session: 'json-output',
  }));
  expect(openJson.url).toContain('data:text/html');

  const evaluated = await runCli('-s=json-output', 'eval', '() => ({ answer: 42, text: document.body.innerText })', '--json');
  expect(JSON.parse(evaluated.output)).toEqual({
    ok: true,
    url: openJson.url,
    title: 'Structured',
    result: { answer: 42, text: 'Hello' },
    console: [],
    provider: { name: 'patchright', version: '1.61.1' },
    challenge: { type: 'none', blocked: false },
    bodyLength: 5,
    emptyBody: false,
    webdriver: false,
  });

  const snapshot = await runCli('-s=json-output', 'snapshot', '--inline', '--json');
  expect(JSON.parse(snapshot.output)).toEqual(expect.objectContaining({
    ok: true,
    result: { snapshot: expect.stringContaining('heading "Hello"') },
  }));

  await runCli('-s=json-output', 'close');
});

test('writes complete eval results with --output', async ({}) => {
  await runCli('-s=eval-output', 'open', 'data:text/html,<title>Output</title>');
  const outputFile = path.join(test.info().outputPath(), 'evaluation result.txt');
  const expected = 'line1\nline2 with "quotes" and \\ backslash\n' + 'x'.repeat(8192);
  const evaluated = await runCli(
      '-s=eval-output',
      'eval',
      `() => ${JSON.stringify(expected)}`,
      `--output=${outputFile}`,
      '--json');
  expect(evaluated.exitCode).toBe(0);
  expect(JSON.parse(evaluated.output)).toEqual(expect.objectContaining({
    ok: true,
    result: `- [Evaluation result](${outputFile})`,
    provider: { name: 'patchright', version: '1.61.1' },
  }));
  expect(fs.readFileSync(outputFile, 'utf8')).toBe(expected);

  const objectFile = path.join(test.info().outputPath(), 'evaluation-object.json');
  await runCli('-s=eval-output', 'eval', '() => ({ answer: 42 })', `--output=${objectFile}`);
  expect(fs.readFileSync(objectFile, 'utf8')).toBe('{\n  "answer": 42\n}');
  await runCli('-s=eval-output', 'close');
});

test('--raw eval unwraps JSON-encoded string results', async ({}) => {
  await runCli('-s=raw-eval', 'open', 'data:text/html,<title>Raw</title>');
  // Without --raw, JSON.stringify returns a quoted string (double-encoded)
  const withoutRaw = await runCli('-s=raw-eval', 'eval', 'JSON.stringify({a:1})', '--json');
  const withoutPayload = JSON.parse(withoutRaw.output);
  expect(withoutPayload.result).toBe('{"a":1}');

  // With --raw, the string result is unwrapped (no extra quotes)
  const rawStr = await runCli('-s=raw-eval', '--raw', 'eval', 'JSON.stringify({a:1})');
  expect(rawStr.output.trim()).toBe('{"a":1}');

  // Object results are unaffected by --raw unwrapping (they aren't strings)
  const rawObj = await runCli('-s=raw-eval', '--raw', 'eval', '({a:1})');
  expect(rawObj.output.trim()).toBe('{\n  "a": 1\n}');

  // Number results are unaffected
  const rawNum = await runCli('-s=raw-eval', '--raw', 'eval', '42');
  expect(rawNum.output.trim()).toBe('42');
  await runCli('-s=raw-eval', 'close');
});

test('fetch command returns structured HTTP response', async ({}) => {
  await runCli('-s=fetch-test', 'open', 'data:text/html,<title>Fetch</title>');
  const result = await runCli('-s=fetch-test', 'fetch', 'data:text/html,<p>Hello</p>', '--json');
  const payload = JSON.parse(result.output);
  expect(result.exitCode).toBe(0);
  expect(payload.ok).toBe(true);
  expect(payload.result.status).toBe(200);
  expect(payload.result.body).toBe('<p>Hello</p>');
  expect(payload.result.headers).toEqual(expect.objectContaining({ 'content-type': 'text/html' }));
  await runCli('-s=fetch-test', 'close');
});

test('fetch --raw returns just the response body', async ({}) => {
  await runCli('-s=fetch-raw-test', 'open', 'data:text/html,<title>RawFetch</title>');
  const result = await runCli('-s=fetch-raw-test', '--raw', 'fetch', 'data:text/html,<p>BodyOnly</p>');
  expect(result.output.trim()).toBe('<p>BodyOnly</p>');
  await runCli('-s=fetch-raw-test', 'close');
});


test('fetch reports HTTP 4xx/5xx as failure while preserving the body', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-404-test', 'open', 'data:text/html,<title>F</title>');
    const result = await runCli('-s=fetch-404-test', 'fetch', `http://127.0.0.1:${address.port}/missing`, '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('HTTP 404 Not Found');
    expect(payload.result.status).toBe(404);
    expect(payload.result.body).toBe('not found');
    expect(payload.result.failed).toBe(true);
    await runCli('-s=fetch-404-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch supports POST with data and reports redirects', async ({}) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/target' });
      res.end();
      return;
    }
    if (req.url === '/target') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('landed');
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-post-test', 'open', 'data:text/html,<title>FP</title>');
    const base = `http://127.0.0.1:${address.port}`;

    const post = await runCli('-s=fetch-post-test', 'fetch', `${base}/echo`, '--method=POST', '--data={"x":1}', '--json');
    const postPayload = JSON.parse(post.output);
    expect(postPayload.ok).toBe(true);
    expect(postPayload.result.json.method).toBe('POST');
    expect(postPayload.result.json.body).toBe('{"x":1}');

    const redirect = await runCli('-s=fetch-post-test', 'fetch', `${base}/redirect`, '--json');
    const redirectPayload = JSON.parse(redirect.output);
    expect(redirectPayload.result.status).toBe(200);
    expect(redirectPayload.result.redirected).toBe(true);
    expect(redirectPayload.result.url).toBe(`${base}/target`);
    expect(redirectPayload.result.body).toBe('landed');
    await runCli('-s=fetch-post-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch returns base64 for binary responses without corruption', async ({}) => {
  const crypto = require('crypto');
  const server = http.createServer((req, res) => {
    const buf = crypto.randomBytes(1024);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-binary-test', 'open', 'data:text/html,<title>B</title>');
    const result = await runCli('-s=fetch-binary-test', 'fetch', `http://127.0.0.1:${address.port}/`, '--json');
    const payload = JSON.parse(result.output);
    expect(payload.result.binary).toBe(true);
    const decoded = Buffer.from(payload.result.body, 'base64');
    expect(decoded.length).toBe(1024);
    expect(payload.result.headers['content-type']).toBe('application/octet-stream');
    await runCli('-s=fetch-binary-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('fetch detects anti-bot challenge types from status and body', async ({}) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/datadome') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><body>Please enable JS and disable any ad blocker</body></html>');
      return;
    }
    if (req.url === '/akamai') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><title>Access Denied</title><body>You don\'t have permission to access</body></html>');
      return;
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=fetch-challenge-test', 'open', 'data:text/html,<title>CH</title>');
    const base = `http://127.0.0.1:${address.port}`;

    const datadome = await runCli('-s=fetch-challenge-test', 'fetch', `${base}/datadome`, '--json');
    expect(JSON.parse(datadome.output).result.challenge).toEqual({ type: 'datadome', blocked: true });

    const akamai = await runCli('-s=fetch-challenge-test', 'fetch', `${base}/akamai`, '--json');
    expect(JSON.parse(akamai.output).result.challenge).toEqual({ type: 'blocked', blocked: true });

    const plain = await runCli('-s=fetch-challenge-test', 'fetch', `${base}/plain`, '--json');
    expect(JSON.parse(plain.output).result.challenge).toEqual({ type: '403', blocked: true });
    await runCli('-s=fetch-challenge-test', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto reports soft 404 as failure', async ({}) => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><title>Not Found</title><body>Page not found</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-soft404', 'open', 'data:text/html,<title>Start</title>');
    const result = await runCli('-s=goto-soft404', 'goto', `http://127.0.0.1:${address.port}/`, '--timeout=5', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('HTTP 404');
    expect(payload.result.status).toBe(404);
    expect(payload.result.failed).toBe(true);
    await runCli('-s=goto-soft404', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('goto --retry retries transient 5xx and reports attempts', async ({}) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('transient failure');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>recovered</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-retry', 'open', 'data:text/html,<title>Start</title>');
    const result = await runCli('-s=goto-retry', 'goto', `http://127.0.0.1:${address.port}/`, '--timeout=5', '--retry=2', '--json');
    const payload = JSON.parse(result.output);
    expect(payload.ok).toBe(true);
    expect(payload.result.status).toBe(200);
    expect(payload.result.attempts).toBe(2);
    expect(payload.result.retried).toBe(true);
    expect(requests).toBe(2);
    await runCli('-s=goto-retry', 'close');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('fetch without URL reports missing argument', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['fetch'] })).toThrow(/fetch requires a URL/);
});

test('structured success payload always has a provider field', async ({}) => {
  const { successPayload } = require('../cliEnhancements');
  expect(successPayload(undefined, 'done', [], undefined)).toEqual({
    ok: true,
    url: null,
    title: null,
    result: 'done',
    console: [],
    provider: null,
  });

  const fallback = {
    requested: 'cloakbrowser',
    active: 'patchright',
    reason: 'cloakbrowser: executable missing',
  };
  expect(successPayload(undefined, 'done', [], { name: 'patchright', version: '1.61.1' }, fallback)).toEqual({
    ok: true,
    url: null,
    title: null,
    result: 'done',
    console: [],
    provider: { name: 'patchright', version: '1.61.1' },
    fallback,
  });
});

test('goto timeout fails quickly with structured navigation status', async ({}) => {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP server address');

  try {
    await runCli('-s=goto-timeout', 'open', 'data:text/html,<title>Before</title>');
    const startedAt = Date.now();
    const navigation = await runCli('-s=goto-timeout', 'goto', `http://127.0.0.1:${address.port}`, '--timeout=0.2', '--json');
    const elapsed = Date.now() - startedAt;
    const payload = JSON.parse(navigation.output);

    expect(navigation.exitCode).toBe(1);
    expect(elapsed).toBeLessThan(3000);
    expect(payload).toEqual(expect.objectContaining({
      ok: false,
      url: null,
      title: null,
      result: null,
      console: [],
      error: expect.stringContaining('Timeout 200ms exceeded'),
    }));
    expect(payload.error).not.toContain('\u001b');
  } finally {
    await runCli('-s=goto-timeout', 'close');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('invalid navigation timeout returns the structured error contract', async ({}) => {
  await runCli('-s=invalid-timeout', 'open', 'data:text/html,<title>Before</title>');
  const result = await runCli('-s=invalid-timeout', 'goto', 'https://example.com', '--timeout=soon', '--json');
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.output)).toEqual({
    ok: false,
    url: null,
    title: null,
    result: null,
    console: [],
    error: "Invalid navigation timeout 'soon'. Use seconds (for example, --timeout=5).",
  });
  await runCli('-s=invalid-timeout', 'close');
});

test('sub-millisecond navigation timeouts are rejected instead of disabling the timeout', async ({}) => {
  const { parseTimeoutMs } = require('../cliEnhancements');
  // Playwright reads `timeout: 0` as "no timeout", so rounding a tiny value down
  // to zero would turn the most aggressive request into an indefinite wait.
  expect(() => parseTimeoutMs('0.0001')).toThrow(/too small/);
  expect(() => parseTimeoutMs('0.4ms')).toThrow(/too small/);
  expect(parseTimeoutMs('1ms')).toBe(1);
  expect(parseTimeoutMs('5')).toBe(5000);
});

test('goto --timeout without a URL reports the missing argument', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['goto'], timeout: '5' }))
      .toThrow(/goto requires a URL/);
  const prepared = prepareCommandArgs({ _: ['goto', 'https://example.com'], timeout: '5' });
  expect(prepared._[1]).toContain('"https://example.com"');
  expect(prepared._[1]).not.toContain('goto(undefined');
});

test('goto --wait-until without a URL reports the missing argument', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['goto'], 'wait-until': 'load' }))
      .toThrow(/goto requires a URL/);
});

test('invalid --wait-until value is rejected', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  expect(() => prepareCommandArgs({ _: ['goto', 'https://example.com'], 'wait-until': 'never' }))
      .toThrow(/Invalid --wait-until/);
  expect(() => prepareCommandArgs({ _: ['goto', 'https://example.com'], 'wait-until': 'load' }))
      .not.toThrow();
});

test('goto --wait-until generates a run-code snippet with the right strategy', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  const prepared = prepareCommandArgs({ _: ['goto', 'https://example.com'], 'wait-until': 'networkidle' });
  expect(prepared._[0]).toBe('run-code');
  expect(prepared._[1]).toContain("waitUntil: 'networkidle'");
  expect(prepared._[1]).toContain('navigation');
  expect(prepared._[1]).toContain('url: finalUrl');
  expect(prepared._[1]).toContain('status');
  expect(prepared._[1]).toContain('redirected');
  expect(prepared._[1]).toContain('challenge');
  expect(prepared._[1]).toContain('bodyLength');
  expect(prepared._[1]).toContain('emptyBody');
  expect(prepared._[1]).toContain('attempts');
});

test('goto without flags is not intercepted', async ({}) => {
  const { prepareCommandArgs } = require('../cliEnhancements');
  const prepared = prepareCommandArgs({ _: ['goto', 'https://example.com'] });
  expect(prepared._[0]).toBe('goto');
});

test('goto --timeout returns full navigation result with redirect detection', async ({}) => {
  await runCli('-s=goto-result', 'open', 'data:text/html,<title>Start</title>');
  const nav = await runCli('-s=goto-result', 'goto', 'data:text/html,<title>Target</title>', '--timeout=5', '--json');
  const payload = JSON.parse(nav.output);
  expect(nav.exitCode).toBe(0);
  expect(payload.ok).toBe(true);
  // The result from the evaluated snippet
  expect(payload.result.navigation).toBe('succeeded');
  expect(payload.result.url).toContain('data:text/html');
  expect(payload.result.title).toBe('Target');
  expect(payload.result.status === null || typeof payload.result.status === 'number').toBe(true);
  expect(payload.result.redirected).toBe(false);
  await runCli('-s=goto-result', 'close');
});

test('goto --timeout and --wait-until can be combined', async ({}) => {
  await runCli('-s=goto-combined', 'open', 'data:text/html,<title>Before</title>');
  const nav = await runCli('-s=goto-combined', 'goto', 'data:text/html,<title>After</title>', '--timeout=5', '--wait-until=load', '--json');
  const payload = JSON.parse(nav.output);
  expect(nav.exitCode).toBe(0);
  expect(payload.ok).toBe(true);
  expect(payload.result.navigation).toBe('succeeded');
  expect(payload.result.title).toBe('After');
  await runCli('-s=goto-combined', 'close');
});


test('parseTabList structures tab-list text output', async ({}) => {
  // We can't import parseTabList directly (it's not exported), so test via --json
  await runCli('-s=parse-tabs', 'open', 'data:text/html,<title>First</title>');
  await runCli('-s=parse-tabs', 'tab-new', 'data:text/html,<title>Second</title>');
  const result = await runCli('-s=parse-tabs', 'tab-list', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.ok).toBe(true);
  expect(payload.result.tabs).toEqual([
    { index: 0, current: false, title: 'First', url: 'data:text/html,<title>First</title>' },
    { index: 1, current: true, title: 'Second', url: 'data:text/html,<title>Second</title>' },
  ]);
  await runCli('-s=parse-tabs', 'close');
});

test('parseConsoleOutput structures console text output', async ({}) => {
  await runCli('-s=parse-console', 'open', 'data:text/html,<title>C</title>');
  // Empty console
  const empty = await runCli('-s=parse-console', 'console', '--json');
  const emptyPayload = JSON.parse(empty.output);
  expect(emptyPayload.result).toEqual({ messages: [], summary: { total: 0, errors: 0, warnings: 0 } });
  await runCli('-s=parse-console', 'close');
});

test('parseRequestsList structures requests text output', async ({}) => {
  await runCli('-s=parse-reqs', 'open', 'data:text/html,<title>R</title>');
  const result = await runCli('-s=parse-reqs', 'requests', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.ok).toBe(true);
  expect(payload.result.requests).toEqual([]);
  await runCli('-s=parse-reqs', 'close');
});

test('normalizeCommandResult passes through non-string results unchanged', async ({}) => {
  // Non-text commands (eval, snapshot, fetch) should return their structured result as-is
  await runCli('-s=pass-through', 'open', 'data:text/html,<title>PT</title>');
  const result = await runCli('-s=pass-through', 'eval', '() => ({ x: 1 })', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.result).toEqual({ x: 1 });
  await runCli('-s=pass-through', 'close');
});
test('failure payloads survive errors that cannot be serialized', async ({}) => {
  const { failurePayload } = require('../cliEnhancements');
  const circular: any = { a: 1 };
  circular.self = circular;
  expect(() => failurePayload(circular)).not.toThrow();
  expect(failurePayload(circular)).toEqual(expect.objectContaining({
    ok: false,
    error: expect.any(String),
  }));

  const bigint = { size: BigInt(1) };
  expect(() => failurePayload(bigint)).not.toThrow();
});

test('generated provider config directories are removed on exit', async ({}) => {
  const probe = `
    const providers = require(${JSON.stringify(path.join(__dirname, '../browserProviders.js'))});
    const state = providers.createProviderState('open', ['open'], {});
    process.stdout.write(state.configDir);
  `;
  const configDir = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
  expect(configDir).toContain('playwright-cli-browser-');
  expect(fs.existsSync(configDir)).toBe(false);
});
test('challenge detection flags Cloudflare-style pages', async ({}) => {
  const { detectChallengeFromText } = require('../cliEnhancements');
  // detectChallengeFromText is not exported; test via the payload path instead
  await runCli('-s=challenge-test', 'open', 'data:text/html,<title>Just a moment...</title><p>Checking your browser before accessing</p>');
  const result = await runCli('-s=challenge-test', 'eval', '() => document.title', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.challenge).toEqual({ type: 'cloudflare', blocked: true });
  expect(payload.bodyLength).toBeGreaterThan(0);
  expect(payload.emptyBody).toBe(false);
  expect(payload.webdriver).toBe(false);
  await runCli('-s=challenge-test', 'close');
});

test('empty body is reported with emptyBody flag', async ({}) => {
  await runCli('-s=empty-test', 'open', 'data:text/html,');
  const result = await runCli('-s=empty-test', 'eval', '() => document.body.innerText', '--json');
  const payload = JSON.parse(result.output);
  expect(payload.bodyLength).toBe(0);
  expect(payload.emptyBody).toBe(true);
  await runCli('-s=empty-test', 'close');
});

test('cleanup command removes accumulated artifacts', async ({}) => {
  const outputDir = path.join(process.cwd(), '.playwright-cli');
  const probe = `
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(process.cwd(), '.playwright-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page-test-old.yml'), '');
    fs.writeFileSync(path.join(dir, 'console-test-old.log'), '');
  `;
  execFileSync(process.execPath, ['-e', probe]);
  const result = execFileSync(process.execPath, [path.join(__dirname, '../playwright-cli.js'), 'cleanup', '--all', '--json'], { encoding: 'utf8' });
  const payload = JSON.parse(result);
  expect(payload.removed).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(path.join(outputDir, 'page-test-old.yml'))).toBe(false);
  expect(fs.existsSync(path.join(outputDir, 'console-test-old.log'))).toBe(false);
});

test('host-resolver-rules flag is extracted for DNS override', async ({}) => {
  const providers = require('../browserProviders');
  const state = providers.createProviderState('open', ['open', '--host-resolver-rules=MAP example.com 1.2.3.4'], {});
  // Only enabled when provider selection is active; use resolveProviderOrder directly
  const { resolveProviderOrder, flagValue } = providers;
  expect(resolveProviderOrder('patchright')).toEqual(['patchright']);
  // flagValue is internal; verify via a state probe
  const probe = `
    const providers = require(${JSON.stringify(path.join(__dirname, '../browserProviders.js'))});
    const state = providers.createProviderState('open', ['open', '--host-resolver-rules=MAP example.com 1.2.3.4'], {});
    process.stdout.write(JSON.stringify({ rules: state.hostResolverRules }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
  expect(JSON.parse(out)).toEqual({ rules: 'MAP example.com 1.2.3.4' });
});

test('request-headers and response-headers --json return structured headers', async ({}) => {
  const opened = await runCli('-s=headers-test', 'open', 'https://httpbin.org/get');
  expect(opened.exitCode, opened.error).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const responseHeaders = await runCli('-s=headers-test', 'response-headers', '1', '--json');
  const payload = JSON.parse(responseHeaders.output);
  expect(payload.ok, responseHeaders.output).toBe(true);
  expect(typeof payload.result.headers).toBe('object');
  expect(payload.result.headers).toEqual(expect.objectContaining({ 'content-type': 'application/json' }));
  await runCli('-s=headers-test', 'close');
});

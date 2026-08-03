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
import { spawn } from 'child_process';
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

  expect(providers.resolveProviderOrder(undefined)).toEqual(['cloakbrowser', 'patchright', 'camoufox']);
  expect(providers.resolveProviderOrder('camoufox,patchright')).toEqual(['camoufox', 'patchright']);

  expect(providers.hasExplicitBrowserConfig(['open', '--browser=firefox'], {})).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open', '--config', 'cli.json'], {})).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open'], { PLAYWRIGHT_MCP_BROWSER: 'firefox' })).toBe(true);
  expect(providers.hasExplicitBrowserConfig(['open'], {})).toBe(false);

  expect(providers.createProviderState('open', ['open'], {}).enabled).toBe(true);
  expect(providers.createProviderState('open', ['open', '--browser=webkit'], {}).enabled).toBe(false);
  expect(providers.createProviderState('close', ['close'], {}).enabled).toBe(false);
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
  const { configureBrowserProviderFallbacks } = require('../browserProviders');

  const activationEnv: NodeJS.ProcessEnv = {};
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

  const launchEnv: NodeJS.ProcessEnv = {};
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
});

test('reports active provider, re-evaluates it, and lists the provider name', async ({}) => {
  const firstOpen = await runCli('-s=provider-report', 'open', 'data:text/html,<title>First</title>');
  expect(firstOpen).toEqual(expect.objectContaining({
    output: expect.stringContaining('### Browser provider\n- name: patchright\n- version: 1.61.1'),
    exitCode: 0,
  }));

  const list = await runCli('list');
  expect(list.output).toContain('browser-type: patchright');
  expect(list.output).not.toContain('browser-type: chrome-for-testing');

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
  const outputFile = path.join(test.info().outputPath(), 'evaluation.json');
  const evaluated = await runCli('-s=eval-output', 'eval', '() => "x".repeat(8192)', `--output=${outputFile}`, '--json');
  expect(evaluated.exitCode).toBe(0);
  expect(JSON.parse(evaluated.output)).toEqual(expect.objectContaining({ ok: true }));
  expect(JSON.parse(fs.readFileSync(outputFile, 'utf8'))).toBe('x'.repeat(8192));
  await runCli('-s=eval-output', 'close');
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

/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// @ts-check

const fs = require('fs');
const os = require('os');
const path = require('path');

const providerEnvName = 'PLAYWRIGHT_CLI_BROWSER_PROVIDER';
const activeProviderEnvName = 'PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER';
const configEnvName = 'PLAYWRIGHT_MCP_CONFIG';

const defaultProviderOrder = ['cloakbrowser', 'patchright', 'camoufox'];
const validProviders = new Set(defaultProviderOrder);

/**
 * @param {{
 *   argv?: string[],
 *   command?: string,
 *   env?: NodeJS.ProcessEnv,
 *   sessionModule: { Session?: { startDaemon?: Function } },
 *   stderr?: NodeJS.WriteStream,
 * }} options
 */
async function configureBrowserProviderFallbacks(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const command = options.command ?? firstCommand(argv);
  const state = createProviderState(command, argv, env);
  if (!state.enabled)
    return { enabled: false };

  const sessionClass = options.sessionModule.Session;
  if (!sessionClass || typeof sessionClass.startDaemon !== 'function')
    throw new Error('Unable to configure browser providers: Session.startDaemon was not found.');

  const originalStartDaemon = sessionClass.startDaemon;
  if (originalStartDaemon.__browserProviderFallbacks)
    return { enabled: true, providers: state.providers };

  const stderr = options.stderr ?? process.stderr;
  let providerIndex = await activateFirstAvailableProvider(state, env, stderr);

  sessionClass.startDaemon = async function(...args) {
    let lastError;
    while (providerIndex < state.providers.length) {
      const provider = state.providers[providerIndex];
      try {
        return await originalStartDaemon.apply(this, args);
      } catch (error) {
        lastError = error;
        providerIndex++;
        if (providerIndex >= state.providers.length)
          break;
        const nextProvider = state.providers[providerIndex];
        writeProviderNotice(stderr, `Browser provider '${provider}' failed; falling back to '${nextProvider}'.`);
        await activateProvider(state, nextProvider, env);
      }
    }
    throw lastError;
  };
  sessionClass.startDaemon.__browserProviderFallbacks = true;

  return { enabled: true, providers: state.providers };
}

/**
 * @param {string | undefined} command
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function createProviderState(command, argv, env) {
  const providerOverride = env[providerEnvName];
  if (command !== 'open')
    return { enabled: false, providers: [] };
  if (!providerOverride && hasExplicitBrowserConfig(argv, env))
    return { enabled: false, providers: [] };
  const providers = resolveProviderOrder(providerOverride);
  return {
    enabled: providers.length > 0,
    providers,
    originalConfig: env[configEnvName],
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-cli-browser-')),
    configPaths: new Map(),
  };
}

/**
 * @param {string | undefined} providerOverride
 */
function resolveProviderOrder(providerOverride) {
  if (!providerOverride || providerOverride === 'auto')
    return defaultProviderOrder;
  const providers = providerOverride.split(',').map(provider => provider.trim()).filter(Boolean);
  for (const provider of providers) {
    if (!validProviders.has(provider))
      throw new Error(`Unsupported ${providerEnvName}: ${provider}. Expected one of ${[...validProviders].join(', ')}.`);
  }
  return providers;
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.WriteStream} stderr
 */
async function activateFirstAvailableProvider(state, env, stderr) {
  let lastError;
  for (let i = 0; i < state.providers.length; i++) {
    try {
      await activateProvider(state, state.providers[i], env);
      return i;
    } catch (error) {
      lastError = error;
      const nextProvider = state.providers[i + 1];
      if (nextProvider)
        writeProviderNotice(stderr, `Browser provider '${state.providers[i]}' is unavailable; falling back to '${nextProvider}'.`);
    }
  }
  throw lastError;
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {string} provider
 * @param {NodeJS.ProcessEnv} env
 */
async function activateProvider(state, provider, env) {
  env[activeProviderEnvName] = provider;
  env[configEnvName] = await configPathForProvider(state, provider);
}

/**
 * @param {ReturnType<typeof createProviderState>} state
 * @param {string} provider
 */
async function configPathForProvider(state, provider) {
  const existingPath = state.configPaths.get(provider);
  if (existingPath)
    return existingPath;

  const config = await configForProvider(provider);
  const configPath = path.join(state.configDir, `${provider}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  state.configPaths.set(provider, configPath);
  return configPath;
}

/**
 * @param {string} provider
 */
async function configForProvider(provider) {
  if (provider === 'patchright') {
    return {
      browser: {
        browserName: 'chromium',
        launchOptions: {
          channel: 'chrome-for-testing',
        },
      },
    };
  }

  if (provider === 'cloakbrowser') {
    const { buildLaunchOptions } = await import('cloakbrowser');
    return {
      browser: {
        browserName: 'chromium',
        launchOptions: await buildLaunchOptions(),
      },
    };
  }

  if (provider === 'camoufox') {
    const { launchOptions } = await import('camoufox-js');
    return {
      browser: {
        browserName: 'firefox',
        launchOptions: await launchOptions({ headless: true, env: {} }),
      },
    };
  }

  throw new Error(`Provider '${provider}' does not use a generated config.`);
}

/**
 * @param {string[]} argv
 */
function firstCommand(argv) {
  return argv.find(arg => !arg.startsWith('-'));
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
function hasExplicitBrowserConfig(argv, env) {
  if (env[configEnvName] || env.PLAYWRIGHT_MCP_BROWSER || env.PLAYWRIGHT_MCP_EXECUTABLE_PATH)
    return true;
  return hasFlag(argv, 'config') || hasFlag(argv, 'browser');
}

/**
 * @param {string[]} argv
 * @param {string} flag
 */
function hasFlag(argv, flag) {
  return argv.some(arg => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
}

/**
 * @param {NodeJS.WriteStream} stderr
 * @param {string} message
 */
function writeProviderNotice(stderr, message) {
  stderr.write(`[playwright-cli] ${message}\n`);
}

module.exports = {
  configureBrowserProviderFallbacks,
  createProviderState,
  resolveProviderOrder,
  hasExplicitBrowserConfig,
};

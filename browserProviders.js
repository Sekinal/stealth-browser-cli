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
 *   activateProvider?: typeof activateProvider,
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
  const activate = options.activateProvider ?? activateProvider;
  let providerIndex = await activateFirstAvailableProvider(state, env, stderr, activate);

  sessionClass.startDaemon = async function(...args) {
    let lastError;
    while (providerIndex < state.providers.length) {
      const provider = state.providers[providerIndex];
      try {
        const startDaemon = provider === 'camoufox' ? camoufoxStartDaemon() : originalStartDaemon;
        return await startDaemon.apply(this, args);
      } catch (error) {
        lastError = error;
        providerIndex++;
        if (providerIndex >= state.providers.length)
          break;
        const nextProvider = state.providers[providerIndex];
        writeProviderNotice(stderr, `Browser provider '${provider}' failed (${formatProviderError(error)}); falling back to '${nextProvider}'.`);
        await activate(state, nextProvider, env);
      }
    }
    throw lastError;
  };
  sessionClass.startDaemon.__browserProviderFallbacks = true;

  return { enabled: true, providers: state.providers };
}

function camoufoxStartDaemon(modules) {
  let { sessionModule, registryModule } = modules ?? {};
  if (!sessionModule || !registryModule) {
    const playwrightRoot = path.dirname(require.resolve('playwright-core/package.json'));
    sessionModule = require(path.join(playwrightRoot, 'lib/tools/cli-client/session.js'));
    registryModule = require(path.join(playwrightRoot, 'lib/tools/cli-client/registry.js'));
  }
  return async function(clientInfo, cliArgs, mode) {
    const result = await sessionModule.Session.startDaemon(clientInfo, cliArgs, mode);
    const daemonClientInfo = registryModule.createClientInfo();
    if (daemonClientInfo.daemonProfilesDir !== clientInfo.daemonProfilesDir) {
      const source = path.join(daemonClientInfo.daemonProfilesDir, `${result.sessionName}.session`);
      const destination = path.join(clientInfo.daemonProfilesDir, `${result.sessionName}.session`);
      fs.copyFileSync(source, destination);
    }
    return result;
  };
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
 * @param {typeof activateProvider} activate
 */
async function activateFirstAvailableProvider(state, env, stderr, activate = activateProvider) {
  let lastError;
  for (let i = 0; i < state.providers.length; i++) {
    try {
      await activate(state, state.providers[i], env);
      return i;
    } catch (error) {
      lastError = error;
      const nextProvider = state.providers[i + 1];
      if (nextProvider)
        writeProviderNotice(stderr, `Browser provider '${state.providers[i]}' is unavailable (${formatProviderError(error)}); falling back to '${nextProvider}'.`);
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
  // Once provider selection is enabled, do not let ambient upstream browser
  // settings override its generated config inside the daemon.
  delete env.PLAYWRIGHT_MCP_BROWSER;
  delete env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
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
    await ensureCamoufoxInstalled();
    const { launchOptions } = await import('camoufox-js');
    return {
      browser: {
        browserName: 'firefox',
        launchOptions: await camoufoxLaunchOptions(launchOptions),
        // Camoufox rejects Playwright's newer `isMobile` viewport field.
        // Let Camoufox's fingerprint configuration own the viewport instead.
        contextOptions: { viewport: null },
      },
    };
  }

  throw new Error(`Provider '${provider}' does not use a generated config.`);
}

/**
 * @param {Function} launchOptions
 */
async function camoufoxLaunchOptions(launchOptions) {
  try {
    return await launchOptions({ headless: true, env: {} });
  } catch (error) {
    const message = formatProviderError(error);
    if (!/better_sqlite3\.node|Could not locate the bindings file/i.test(message))
      throw error;
    return await launchOptions({
      headless: true,
      env: {},
      block_webgl: true,
      i_know_what_im_doing: true,
    });
  }
}

/**
 * camoufox-js 0.10.x starts its automatic browser download without awaiting
 * it. Await the package's installer ourselves so the first `open` cannot race
 * a partially extracted browser.
 *
 * @param {{ camoufoxPath: Function, CamoufoxFetcher: new () => { install: Function }} | undefined} pkgman
 */
async function ensureCamoufoxInstalled(pkgman) {
  pkgman ??= await import('camoufox-js/dist/pkgman.js');
  try {
    pkgman.camoufoxPath(false);
    return false;
  } catch {
    const fetcher = new pkgman.CamoufoxFetcher();
    await fetcher.install();
    pkgman.camoufoxPath(false);
    return true;
  }
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

/**
 * @param {unknown} error
 */
function formatProviderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim() || 'unknown error';
}

/**
 * @param {string} provider
 */
function providerVersion(provider) {
  const packageName = provider === 'patchright' ? 'patchright-core' : provider === 'camoufox' ? 'camoufox-js' : provider;
  try {
    return require(`${packageName}/package.json`).version;
  } catch {
    return require('./package.json').dependencies[packageName];
  }
}

module.exports = {
  configureBrowserProviderFallbacks,
  camoufoxStartDaemon,
  camoufoxLaunchOptions,
  createProviderState,
  resolveProviderOrder,
  hasExplicitBrowserConfig,
  formatProviderError,
  ensureCamoufoxInstalled,
  providerVersion,
};

/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// @ts-check

const fs = require('fs');
const path = require('path');

const activeProviderEnvName = 'PLAYWRIGHT_CLI_ACTIVE_BROWSER_PROVIDER';
const providerMetadataSuffix = '.provider.json';

/**
 * Adds the small amount of stealth-browser-specific behavior that cannot be
 * expressed through the upstream CLI configuration file.
 *
 * @param {{
 *   argv?: string[],
 *   command?: string,
 *   env?: NodeJS.ProcessEnv,
 *   providerConfig?: { enabled?: boolean, providers?: string[] },
 *   sessionModule: { Session: any },
 *   outputModule: { TextOutput: any, JsonOutput: any },
 *   help: any,
 *   stderr?: NodeJS.WriteStream,
 * }} options
 */
function configureCliEnhancements(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const command = options.command ?? firstCommand(argv);
  const stderr = options.stderr ?? process.stderr;

  extendHelp(options.help);
  patchSession(options.sessionModule.Session, {
    command,
    env,
    providerConfig: options.providerConfig,
    stderr,
  });
  patchOutput(options.outputModule, env);
}

/**
 * @param {any} help
 */
function extendHelp(help) {
  const goto = help.commands?.goto;
  if (goto) {
    goto.flags.timeout = 'string';
    if (!goto.help.includes('--timeout'))
      goto.help += '\n  --timeout                   navigation timeout in seconds';
  }

  const evaluate = help.commands?.eval;
  if (evaluate) {
    evaluate.flags.output = 'string';
    if (!evaluate.help.includes('--output'))
      evaluate.help += '\n  --output                    write the raw evaluation value to a file';
  }

  const snapshot = help.commands?.snapshot;
  if (snapshot) {
    snapshot.flags.inline = 'boolean';
    if (!snapshot.help.includes('--inline'))
      snapshot.help += '\n  --inline                    return the snapshot inline instead of writing a file';
  }
}

/**
 * @param {any} Session
 * @param {{
 *   command?: string,
 *   env: NodeJS.ProcessEnv,
 *   providerConfig?: { enabled?: boolean, providers?: string[] },
 *   stderr: NodeJS.WriteStream,
 * }} options
 */
function patchSession(Session, options) {
  if (!Session || Session.__stealthCliEnhancements)
    return;
  Session.__stealthCliEnhancements = true;

  const originalStartDaemon = Session.startDaemon;
  Session.startDaemon = async function(clientInfo, cliArgs, mode) {
    const result = await originalStartDaemon.apply(this, arguments);
    const provider = options.env[activeProviderEnvName];
    if (provider) {
      writeProviderMetadata(clientInfo.daemonProfilesDir, result.sessionName, {
        provider,
        version: providerVersion(provider),
      });
    }
    return result;
  };

  const originalCanConnect = Session.prototype.canConnect;
  Session.prototype.canConnect = async function() {
    const canConnect = await originalCanConnect.apply(this, arguments);
    if (canConnect) {
      const metadata = readProviderMetadata(this._sessionFile?.daemonDir, this.name);
      if (metadata?.provider && this.config?.browser) {
        this.config.browser.launchOptions ??= {};
        this.config.browser.launchOptions.channel = metadata.provider;
      }
    }
    return canConnect;
  };

  if (options.command === 'open' && options.providerConfig?.enabled) {
    const originalStop = Session.prototype.stop;
    let reportedReevaluation = false;
    Session.prototype.stop = async function() {
      if (!reportedReevaluation && await originalCanConnect.call(this)) {
        reportedReevaluation = true;
        const metadata = readProviderMetadata(this._sessionFile?.daemonDir, this.name);
        const active = metadata?.provider ? ` currently using '${metadata.provider}'` : '';
        const providers = options.providerConfig?.providers?.join(', ') || 'configured providers';
        options.stderr.write(`[playwright-cli] Session '${this.name}' is already running${active}; restarting it to re-evaluate provider order (${providers}).\n`);
      }
      return await originalStop.apply(this, arguments);
    };
  }

  const originalRun = Session.prototype.run;
  Session.prototype.run = async function(clientInfo, args, runOptions) {
    const evalOutputPath = resolveEvalOutputPath(args);
    const preparedArgs = prepareCommandArgs(args);
    try {
      let result = await originalRun.call(this, clientInfo, preparedArgs, runOptions);
      if (result.isError)
        process.exitCode = 1;
      if (!result.isError && evalOutputPath) {
        rewriteEvalOutput(evalOutputPath);
        result = { ...result, text: absoluteEvalOutputLink(result.text, evalOutputPath) };
      }
      if (!runOptions?.json)
        return result;

      const upstreamPayload = parseJsonText(result.text);
      if (result.isError || upstreamPayload?.isError) {
        process.exitCode = 1;
        const payload = failurePayload(
            upstreamPayload?.error ?? result.text,
            undefined,
            [],
            providerDetailsForSession(this, options.env));
        return { ...result, text: JSON.stringify(payload, null, 2) };
      }

      const page = await readPageMetadata(originalRun, this, clientInfo);
      const consoleEntries = await readConsoleEntries(originalRun, this, clientInfo);
      const payload = successPayload(
          page,
          normalizeUpstreamResult(upstreamPayload),
          consoleEntries,
          providerDetailsForSession(this, options.env));
      return { ...result, text: JSON.stringify(payload, null, 2) };
    } catch (error) {
      if (runOptions?.json) {
        const page = await readPageMetadata(originalRun, this, clientInfo);
        const consoleEntries = await readConsoleEntries(originalRun, this, clientInfo);
        if (error && typeof error === 'object')
          error.cliJson = failurePayload(error, page, consoleEntries, providerDetailsForSession(this, options.env));
      }
      throw error;
    }
  };
}

/**
 * @param {{ TextOutput: any, JsonOutput: any }} outputModule
 * @param {NodeJS.ProcessEnv} env
 */
function patchOutput(outputModule, env) {
  const TextOutput = outputModule.TextOutput;
  if (TextOutput && !TextOutput.__stealthCliEnhancements) {
    TextOutput.__stealthCliEnhancements = true;
    const originalOpen = TextOutput.prototype.open;
    TextOutput.prototype.open = function(session, pid, toolResult) {
      originalOpen.apply(this, arguments);
      const provider = providerDetails(env);
      if (provider)
        console.log(`### Browser provider\n- name: ${provider.name}\n- version: ${provider.version}`);
    };
  }

  const JsonOutput = outputModule.JsonOutput;
  if (JsonOutput && !JsonOutput.__stealthCliEnhancements) {
    JsonOutput.__stealthCliEnhancements = true;
    const originalEmit = JsonOutput.prototype._emit;
    JsonOutput.prototype._emit = function(value) {
      let payload;
      if (value?.result?.ok !== undefined && value.session) {
        payload = {
          ...value.result,
          provider: value.result.provider ?? providerDetails(env) ?? null,
          session: value.session,
          pid: value.pid,
        };
      } else if (value?.ok !== undefined) {
        payload = { ...value, provider: value.provider ?? providerDetails(env) ?? null };
      } else if (value?.isError) {
        payload = failurePayload(value.error);
      } else {
        payload = successPayload(undefined, value, [], providerDetails(env));
      }
      return originalEmit.call(this, payload);
    };
  }
}

/**
 * @param {any} args
 */
function prepareCommandArgs(args) {
  const prepared = { ...args, _: [...(args?._ ?? [])] };
  const command = prepared._[0];

  if (command === 'eval' && prepared.output !== undefined) {
    if (prepared.filename !== undefined && prepared.filename !== prepared.output)
      throw new Error('Only one of --filename and --output may be specified.');
    prepared.filename = prepared.output;
    delete prepared.output;
  }

  if (command === 'snapshot' && prepared.inline) {
    if (prepared.filename !== undefined)
      throw new Error('Only one of --filename and --inline may be specified.');
    delete prepared.inline;
  }

  if (command === 'goto' && prepared.timeout !== undefined) {
    const timeoutMs = parseTimeoutMs(prepared.timeout);
    const url = prepared._[1];
    delete prepared.timeout;
    prepared._ = ['run-code', `async (page) => {
  await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: ${timeoutMs} });
  return { navigation: 'succeeded' };
}`];
  }

  return prepared;
}

/**
 * @param {any} args
 */
function resolveEvalOutputPath(args) {
  if (args?._?.[0] !== 'eval' || typeof args.output !== 'string' || !args.output)
    return undefined;
  return path.resolve(process.cwd(), args.output);
}

/**
 * Upstream intentionally stores evaluation results as JSON. `--output` is the
 * stealth CLI's raw-value variant: strings are written literally, while other
 * JSON-compatible values retain their readable JSON representation.
 *
 * @param {string} outputPath
 */
function rewriteEvalOutput(outputPath) {
  const serialized = fs.readFileSync(outputPath, 'utf8');
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    return;
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  fs.writeFileSync(outputPath, raw, 'utf8');
}

/**
 * @param {unknown} text
 * @param {string} outputPath
 */
function absoluteEvalOutputLink(text, outputPath) {
  if (typeof text !== 'string')
    return text;
  const link = `- [Evaluation result](${outputPath})`;
  const payload = parseJsonText(text);
  if (payload && typeof payload === 'object' && typeof payload.result === 'string')
    return JSON.stringify({ ...payload, result: link });
  return text.replace(/- \[Evaluation result\]\([^\r\n]*\)/, link);
}

/**
 * @param {string | number} value
 */
function parseTimeoutMs(value) {
  const input = String(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(input);
  if (!match)
    throw new Error(`Invalid navigation timeout '${value}'. Use seconds (for example, --timeout=5).`);
  const amount = Number(match[1]);
  const timeoutMs = match[2] === 'ms' ? amount : amount * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Navigation timeout must be greater than zero.');
  return Math.round(timeoutMs);
}

/**
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 */
async function readPageMetadata(originalRun, session, clientInfo) {
  try {
    const response = await originalRun.call(session, clientInfo, {
      _: ['eval', '() => ({ url: location.href, title: document.title })'],
    }, { json: true, raw: false });
    const payload = normalizeUpstreamResult(parseJsonText(response.text));
    if (payload && typeof payload === 'object')
      return { url: stringOrNull(payload.url), title: stringOrNull(payload.title) };
  } catch {
  }
  return undefined;
}

/**
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 */
async function readConsoleEntries(originalRun, session, clientInfo) {
  try {
    const response = await originalRun.call(session, clientInfo, { _: ['console'] }, { json: true, raw: false });
    const payload = normalizeUpstreamResult(parseJsonText(response.text));
    return parseConsoleText(typeof payload === 'string' ? payload : '');
  } catch {
    return [];
  }
}

/**
 * @param {unknown} value
 */
function normalizeUpstreamResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'result' in value)
    return parseJsonText(value.result);
  return value;
}

/**
 * @param {unknown} value
 */
function parseJsonText(value) {
  if (typeof value !== 'string')
    return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * @param {string} text
 */
function parseConsoleText(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^Total messages:/i.test(line));
}

/**
 * @param {{ url: string | null, title: string | null } | undefined} page
 * @param {unknown} result
 * @param {string[]} consoleEntries
 * @param {{ name: string, version: string } | undefined} provider
 */
function successPayload(page, result, consoleEntries, provider) {
  return {
    ok: true,
    url: page?.url ?? null,
    title: page?.title ?? null,
    result: result ?? null,
    console: consoleEntries,
    provider: provider ?? null,
  };
}

/**
 * @param {unknown} error
 * @param {{ url: string | null, title: string | null } | undefined} [page]
 * @param {string[]} [consoleEntries]
 * @param {{ name: string, version: string } | undefined} [provider]
 */
function failurePayload(error, page, consoleEntries = [], provider) {
  return {
    ok: false,
    url: page?.url ?? null,
    title: page?.title ?? null,
    result: null,
    console: consoleEntries,
    error: errorMessage(error),
    ...(provider ? { provider } : {}),
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function providerDetails(env) {
  const provider = env[activeProviderEnvName];
  if (!provider)
    return undefined;
  return { name: provider, version: providerVersion(provider) };
}

/**
 * @param {any} session
 * @param {NodeJS.ProcessEnv} env
 */
function providerDetailsForSession(session, env) {
  const active = providerDetails(env);
  if (active)
    return active;
  const metadata = readProviderMetadata(session?._sessionFile?.daemonDir, session?.name);
  return metadata ? { name: metadata.provider, version: metadata.version } : undefined;
}

/**
 * @param {string} provider
 */
function providerVersion(provider) {
  return require('./browserProviders').providerVersion(provider);
}

/**
 * @param {string | undefined} daemonDir
 * @param {string} sessionName
 */
function readProviderMetadata(daemonDir, sessionName) {
  if (!daemonDir)
    return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(providerMetadataPath(daemonDir, sessionName), 'utf8'));
    if (typeof value.provider === 'string' && typeof value.version === 'string')
      return value;
  } catch {
  }
  return undefined;
}

/**
 * @param {string} daemonDir
 * @param {string} sessionName
 * @param {{ provider: string, version: string }} metadata
 */
function writeProviderMetadata(daemonDir, sessionName, metadata) {
  try {
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(providerMetadataPath(daemonDir, sessionName), JSON.stringify(metadata));
  } catch {
  }
}

/**
 * @param {string} daemonDir
 * @param {string} sessionName
 */
function providerMetadataPath(daemonDir, sessionName) {
  return path.join(daemonDir, `${sessionName}${providerMetadataSuffix}`);
}

/**
 * @param {unknown} value
 */
function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * @param {unknown} error
 */
function errorMessage(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  return message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * @param {string[]} argv
 */
function firstCommand(argv) {
  return argv.find(arg => !arg.startsWith('-'));
}

module.exports = {
  configureCliEnhancements,
  failurePayload,
  normalizeUpstreamResult,
  parseConsoleText,
  parseTimeoutMs,
  prepareCommandArgs,
  resolveEvalOutputPath,
  successPayload,
};

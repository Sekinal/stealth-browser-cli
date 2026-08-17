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
    goto.flags['wait-until'] = 'string';
    goto.flags['retry-empty'] = 'boolean';
    goto.flags['retry-empty-delay'] = 'string';
    if (!goto.help.includes('--timeout'))
      goto.help += '\n  --timeout                   navigation timeout in seconds';
    if (!goto.help.includes('--wait-until'))
      goto.help += '\n  --wait-until                navigation wait strategy: load, domcontentloaded, networkidle, commit';
    if (!goto.help.includes('--retry-empty'))
      goto.help += '\n  --retry-empty               wait and reload once if the page body is empty (JS-heavy sites)';
    if (!goto.help.includes('--retry-empty-delay'))
      goto.help += '\n  --retry-empty-delay=<ms>    delay before retrying an empty body (default 1500)';
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

  if (!help.commands.fetch) {
    help.commands.fetch = {
      flags: { method: 'string', data: 'string', header: 'string', timeout: 'string' },
      args: ['url'],
      raw: true,
      help: [
        'playwright-cli fetch <url>               make an HTTP request via the browser network stack',
        '  --method=GET|POST|PUT|PATCH|DELETE|HEAD  HTTP method (default GET)',
        '  --data=<body>                            request body (POST/PUT/PATCH)',
        '  --header="Key: Value"                    request header (comma-separated)',
        '  --timeout=<seconds>                      request timeout (default: no timeout)',
      ].join('\n'),
    };
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
        fallback: fallbackDetails(options.env),
      });
    }
    return result;
  };

  const originalCanConnect = Session.prototype.canConnect;
  Session.prototype.canConnect = async function() {
    const canConnect = await originalCanConnect.apply(this, arguments);
    if (canConnect) {
      const metadata = readProviderMetadata(this._sessionFile?.daemonDir, this.name);
      const provider = metadata ? { name: metadata.provider, version: metadata.version } : inferProviderDetails(this.config);
      this.__stealthProviderDetails = provider;
      if (provider?.name && this.config?.browser) {
        this.config.browser.launchOptions ??= {};
        this.config.browser.launchOptions.channel = provider.name;
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
      if (!result.isError && runOptions?.raw) {
        const cmd = args._?.[0];
        try {
          const parsed = JSON.parse(result.text);
          if (cmd === 'fetch' && parsed && typeof parsed.body === 'string')
            result = { ...result, text: parsed.body };
          else if (cmd === 'eval' && typeof parsed === 'string')
            result = { ...result, text: parsed };
        } catch {}
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
            providerDetailsForSession(this, options.env),
            fallbackDetailsForSession(this, options.env));
        return { ...result, text: JSON.stringify(payload, null, 2) };
      }

      const [page, consoleEntries] = await readSessionContext(originalRun, this, clientInfo);
      const normalizedResult = normalizeCommandResult(args._?.[0], normalizeUpstreamResult(upstreamPayload));
      const cmd = args._?.[0];
      if (cmd === 'fetch' && normalizedResult && typeof normalizedResult === 'object' && !Array.isArray(normalizedResult)) {
        const fetchChallenge = detectChallengeFromText(null, typeof normalizedResult.body === 'string' ? normalizedResult.body : '', typeof normalizedResult.status === 'number' ? normalizedResult.status : null);
        if (fetchChallenge.blocked)
          normalizedResult.challenge = fetchChallenge;
      }
      if ((cmd === 'fetch' || cmd === 'goto') && normalizedResult && typeof normalizedResult === 'object' && normalizedResult.failed) {
        const payload = {
          ...successPayload(page, null, consoleEntries, providerDetailsForSession(this, options.env), fallbackDetailsForSession(this, options.env), proxyDetails(options.env)),
          ok: false,
          result: normalizedResult,
          error: `HTTP ${normalizedResult.status} ${normalizedResult.statusText ?? ''}`.trim(),
        };
        return { ...result, text: JSON.stringify(payload, null, 2) };
      }
      const payload = successPayload(
          page,
          normalizedResult,
          consoleEntries,
          providerDetailsForSession(this, options.env),
          fallbackDetailsForSession(this, options.env),
          proxyDetails(options.env));
      return { ...result, text: JSON.stringify(payload, null, 2) };
    } catch (error) {
      if (runOptions?.json) {
        const [page, consoleEntries] = await readSessionContext(originalRun, this, clientInfo);
        if (error && typeof error === 'object')
          error.cliJson = failurePayload(
              error,
              page,
              consoleEntries,
              providerDetailsForSession(this, options.env),
              fallbackDetailsForSession(this, options.env));
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
        const fallback = value.result.fallback ?? fallbackDetails(env);
        payload = {
          ...value.result,
          provider: value.result.provider ?? providerDetails(env) ?? null,
          ...(fallback ? { fallback } : {}),
          session: value.session,
          pid: value.pid,
        };
      } else if (value?.ok !== undefined) {
        const fallback = value.fallback ?? fallbackDetails(env);
        payload = {
          ...value,
          provider: value.provider ?? providerDetails(env) ?? null,
          ...(fallback ? { fallback } : {}),
        };
      } else if (value?.isError) {
        payload = failurePayload(value.error, undefined, [], providerDetails(env), fallbackDetails(env));
      } else {
        payload = successPayload(undefined, value, [], providerDetails(env), fallbackDetails(env), proxyDetails(env));
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

  if (command === 'goto') {
    const hasTimeout = prepared.timeout !== undefined;
    const hasWaitUntil = prepared['wait-until'] !== undefined;
    const retryEmpty = prepared['retry-empty'] === true;
    const retryDelayMs = prepared['retry-empty-delay'] !== undefined ? parseTimeoutMs(prepared['retry-empty-delay']) : 1500;
    if (hasTimeout || hasWaitUntil || retryEmpty) {
      const url = prepared._[1];
      if (typeof url !== 'string' || !url)
        throw new Error('goto requires a URL (for example, goto https://example.com --timeout=5).');
      const timeoutMs = hasTimeout ? parseTimeoutMs(prepared.timeout) : 60000;
      const waitUntil = hasWaitUntil ? prepared['wait-until'] : 'domcontentloaded';
      if (hasWaitUntil && !['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil))
        throw new Error(`Invalid --wait-until value '${waitUntil}'. Expected one of: load, domcontentloaded, networkidle, commit.`);
      delete prepared.timeout;
      delete prepared['wait-until'];
      delete prepared['retry-empty'];
      delete prepared['retry-empty-delay'];
      prepared._ = ['run-code', `async (page) => {
  const detectChallenge = async (status, title) => {
    const text = (title || '') + ' ' + (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '').catch(() => ''));
    const lower = text.toLowerCase();
    if (status === 403)
      return { type: '403', blocked: true };
    if (status === 429)
      return { type: 'rate-limit', blocked: true };
    if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('enable javascript'))
      return { type: 'cloudflare', blocked: true };
    if (lower.includes('performing security verification') || lower.includes('ray id'))
      return { type: 'cloudflare', blocked: true };
    if (lower.includes('please enable js and disable any ad blocker') || lower.includes('datadome'))
      return { type: 'datadome', blocked: true };
    if (lower.includes('access denied') || lower.includes('you have been blocked') || lower.includes('your access has been') || lower.includes("you don't have permission"))
      return { type: 'blocked', blocked: true };
    if (lower.includes('captcha') || lower.includes('select all squares') || lower.includes('i am not a robot'))
      return { type: 'captcha', blocked: true };
    return { type: 'none', blocked: false };
  };
  const requestedUrl = ${JSON.stringify(url)};
  const response = await page.goto(requestedUrl, { waitUntil: '${waitUntil}', timeout: ${timeoutMs} });
  const finalUrl = page.url();
  const hostOf = (u) => { const m = u.match(/^[a-z][a-z0-9+.-]*:\\/\\/([^\\/?#]*)/i); return m ? m[1].toLowerCase() : u; };
  const redirected = hostOf(requestedUrl) !== hostOf(finalUrl);
  const title = await page.title();
  const status = response ? response.status() : null;
  const challenge = await detectChallenge(status, title);
  let bodyLength = await page.evaluate(() => document.body ? document.body.innerText.length : 0);
  let retried = false;
  if (${retryEmpty} && bodyLength === 0) {
    await page.waitForTimeout(${retryDelayMs});
    bodyLength = await page.evaluate(() => document.body ? document.body.innerText.length : 0);
    if (bodyLength === 0) {
      await page.reload({ waitUntil: '${waitUntil}', timeout: ${timeoutMs} });
      bodyLength = await page.evaluate(() => document.body ? document.body.innerText.length : 0);
      retried = true;
    }
  }
  return {
    navigation: 'succeeded',
    url: page.url(),
    title: await page.title(),
    status,
    redirected,
    challenge,
    bodyLength,
    emptyBody: bodyLength === 0,
    retried,
    failed: status !== null && status >= 400,
  };
}`];
    }
  }

  if (command === 'fetch') {
    const url = prepared._[1];
    if (typeof url !== 'string' || !url)
      throw new Error('fetch requires a URL (for example, fetch https://api.example.com/data).');
    const method = (prepared.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
      throw new Error(`Unsupported fetch method '${prepared.method}'. Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD.`);
    const data = prepared.data;
    const headerArg = prepared.header;
    const timeoutMs = prepared.timeout !== undefined ? parseTimeoutMs(prepared.timeout) : undefined;
    delete prepared.method;
    delete prepared.data;
    delete prepared.header;
    delete prepared.timeout;
    const requestOptions = [
      data !== undefined ? `data: ${JSON.stringify(data)}` : '',
      headerArg !== undefined ? `headers: ${JSON.stringify(parseHeaderArg(headerArg))}` : '',
      timeoutMs !== undefined ? `timeout: ${timeoutMs}` : '',
    ].filter(Boolean).join(', ');
    prepared._ = ['run-code', `async (page) => {
  const url = ${JSON.stringify(url)};
  const isSpecialScheme = /^(data|about|blob):/.test(url);
  if (isSpecialScheme) {
    // APIRequestContext only supports http(s); fall back to in-page fetch for
    // data:/about:/blob: URLs (same-origin, no CORS concern).
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers.entries()), body: await r.text() };
    }, url);
    return { ...res, url, redirected: false, failed: res.status >= 400 };
  }
  const response = await page.request.${method.toLowerCase()}(url${requestOptions ? ', { ' + requestOptions + ' }' : ''});
  const status = response.status();
  const finalUrl = response.url();
  const redirected = url !== finalUrl;
  const headers = {};
  for (const h of response.headersArray())
    headers[h.name.toLowerCase()] = h.value;
  const contentType = headers['content-type'] ?? '';
  const isBinary = /octet-stream|image\\/|application\\/pdf|application\\/zip|application\\/gzip|audio\\/|video\\/|font\\//.test(contentType);
  let body;
  let binary = false;
  if (isBinary) {
    const buf = await response.body();
    body = buf.toString('base64');
    binary = true;
  } else {
    body = await response.text();
  }
  let json = null;
  if (!binary) { try { json = JSON.parse(body); } catch (_) {} }
  return {
    status,
    statusText: response.statusText(),
    url: finalUrl,
    redirected,
    headers,
    body,
    ...(binary ? { binary: true } : {}),
    ...(json !== null ? { json } : {}),
    failed: status >= 400,
  };
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
  // Round before validating: Playwright treats `timeout: 0` as "no timeout", so a
  // sub-millisecond value must be rejected rather than rounded into an infinite wait.
  const timeoutMs = Math.round(match[2] === 'ms' ? amount : amount * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(`Navigation timeout '${value}' is too small; use at least 1ms (for example, --timeout=5).`);
  return timeoutMs;
}

/**
 * Every `--json` invocation needs both the page metadata and the console buffer.
 * The two reads are independent, so issue them together instead of paying two
 * sequential daemon round-trips on top of the caller's own command. Both helpers
 * swallow their own failures, so this never rejects.
 *
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 * @returns {Promise<[{ url: string | null, title: string | null } | undefined, string[]]>}
 */
function readSessionContext(originalRun, session, clientInfo) {
  return Promise.all([
    readPageMetadata(originalRun, session, clientInfo),
    readConsoleEntries(originalRun, session, clientInfo),
  ]);
}

/**
 * @param {Function} originalRun
 * @param {any} session
 * @param {any} clientInfo
 */
async function readPageMetadata(originalRun, session, clientInfo) {
  try {
    const response = await originalRun.call(session, clientInfo, {
      _: ['eval', `() => ({
        url: location.href,
        title: document.title,
        bodyLength: document.body ? document.body.innerText.length : 0,
        bodyText: document.body ? document.body.innerText.slice(0, 2000) : '',
        webdriver: navigator.webdriver,
      })`],
    }, { json: true, raw: false });
    const payload = normalizeUpstreamResult(parseJsonText(response.text));
    if (payload && typeof payload === 'object') {
      const title = stringOrNull(payload.title);
      const bodyText = stringOrNull(payload.bodyText) ?? '';
      const bodyLength = typeof payload.bodyLength === 'number' ? payload.bodyLength : null;
      return {
        url: stringOrNull(payload.url),
        title,
        bodyLength,
        emptyBody: bodyLength === 0,
        webdriver: !!payload.webdriver,
        challenge: detectChallengeFromText(title, bodyText),
      };
    }
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

/**
 * Parse upstream text output into structured data for commands whose daemon
 * responses are plain text, not JSON. This gives agents machine-readable
 * results in --json mode instead of forcing them to regex-parse Markdown.
 *
 * @param {string | undefined} command
 * @param {unknown} upstreamResult
 * @returns {unknown}
 */
function normalizeCommandResult(command, upstreamResult) {
  if (typeof upstreamResult !== 'string')
    return upstreamResult;

  if (command === 'tab-list')
    return parseTabList(upstreamResult);
  if (command === 'console')
    return parseConsoleOutput(upstreamResult);
  if (command === 'requests')
    return parseRequestsList(upstreamResult);
  if (command === 'request')
    return parseRequestDetail(upstreamResult);
  if (command === 'request-headers' || command === 'response-headers')
    return { headers: parseHeaderLines(upstreamResult) };
  if (command === 'request-body' || command === 'response-body')
    return parseBodyText(upstreamResult);

  return upstreamResult;
}

/**
 * Parse header key-value lines into an object.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseHeaderLines(text) {
  const headers = /** @type {Record<string, string>} */ ({});
  for (const line of text.split(/\r?\n/)) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv)
      headers[kv[1].trim()] = kv[2].trim();
  }
  return headers;
}

/**
 * Parse a single `--header="Key: Value"` argument into an object. Multiple
 * comma-separated headers are supported.
 * @param {string} arg
 * @returns {Record<string, string>}
 */
function parseHeaderArg(arg) {
  const headers = /** @type {Record<string, string>} */ ({});
  for (const part of String(arg).split(',')) {
    const kv = part.match(/^([^:]+):\s*(.*)$/);
    if (kv)
      headers[kv[1].trim()] = kv[2].trim();
  }
  return headers;
}

/**
 * Parse a body: return raw text plus a parsed JSON value when applicable.
 * @param {string} text
 */
function parseBodyText(text) {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return json !== null ? { body: text, json } : { body: text };
}

/**
 * Parse tab-list output: "- 0: [Title](url)\n- 1: (current) [Title](url)"
 * @param {string} text
 */
function parseTabList(text) {
  const tabs = [];
  const re = /^- (\d+):( \(current\))? \[([^\]]+)\]\(([^)]+)\)$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    tabs.push({
      index: parseInt(match[1], 10),
      current: !!match[2],
      title: match[3],
      url: match[4],
    });
  }
  return { tabs };
}

/**
 * Parse console output:
 *   "Total messages: N (Errors: X, Warnings: Y)\n[ERROR] msg\n[WARNING] msg"
 * @param {string} text
 */
function parseConsoleOutput(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  const levelMap = /** @type {Record<string, string>} */ ({ '[ERROR]': 'error', '[WARNING]': 'warning', '[INFO]': 'info', '[DEBUG]': 'debug', '[LOG]': 'log' });
  let summary = { total: 0, errors: 0, warnings: 0 };

  const summaryMatch = text.match(/Total messages:\s*(\d+)\s*\(Errors:\s*(\d+),\s*Warnings:\s*(\d+)\)/);
  if (summaryMatch) {
    summary = {
      total: parseInt(summaryMatch[1], 10),
      errors: parseInt(summaryMatch[2], 10),
      warnings: parseInt(summaryMatch[3], 10),
    };
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Total messages:') || trimmed === '### Result')
      continue;
    for (const [prefix, level] of Object.entries(levelMap)) {
      if (trimmed.startsWith(prefix)) {
        messages.push({ level, text: trimmed.slice(prefix.length).trim() });
        break;
      }
    }
  }

  return { messages, summary };
}

/**
 * Parse requests list: "1. [GET] url => [200] \n2. [POST] url => [404] "
 * @param {string} text
 */
function parseRequestsList(text) {
  const requests = [];
  const re = /^(\d+)\.\s+\[(\w+)\]\s+(\S+)\s+=>\s+\[(\d+)\]/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    requests.push({
      index: parseInt(match[1], 10),
      method: match[2],
      url: match[3],
      status: parseInt(match[4], 10),
    });
  }
  return { requests };
}

/**
 * Parse request detail output into structured sections.
 * @param {string} text
 */
function parseRequestDetail(text) {
  const headerMatch = text.match(/^#(\d+)\s+\[(\w+)\]\s+(\S+)/m);
  const result = {
    index: headerMatch ? parseInt(headerMatch[1], 10) : null,
    method: headerMatch?.[2] ?? null,
    url: headerMatch?.[3] ?? null,
    general: /** @type {Record<string, string>} */ ({}),
    requestHeaders: /** @type {Record<string, string>} */ ({}),
    responseHeaders: /** @type {Record<string, string>} */ ({}),
  };

  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'General') { section = 'general'; continue; }
    if (trimmed === 'Request headers') { section = 'requestHeaders'; continue; }
    if (trimmed === 'Response headers') { section = 'responseHeaders'; continue; }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('Run `'))
      continue;
    const kv = trimmed.match(/^(\S[\w\s-]+?):\s+(.*)/);
    if (kv && section) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      result[section][key] = value;
    }
  }

  return result;
}

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

function detectChallengeFromText(title, bodyText, status) {
  const lower = `${title ?? ''} ${bodyText ?? ''}`.toLowerCase();
  if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('enable javascript'))
    return { type: 'cloudflare', blocked: true };
  if (lower.includes('performing security verification') || lower.includes('ray id'))
    return { type: 'cloudflare', blocked: true };
  if (lower.includes('please enable js and disable any ad blocker') || lower.includes('datadome'))
    return { type: 'datadome', blocked: true };
  if (lower.includes('access denied') || lower.includes('you have been blocked') || lower.includes('your access has been') || lower.includes("you don't have permission"))
    return { type: 'blocked', blocked: true };
  if (lower.includes('captcha') || lower.includes('select all squares') || lower.includes('i am not a robot'))
    return { type: 'captcha', blocked: true };
  if (status === 403)
    return { type: '403', blocked: true };
  if (status === 429)
    return { type: 'rate-limit', blocked: true };
  return { type: 'none', blocked: false };
}

/**
 * @param {{ url: string | null, title: string | null } | undefined} page
 * @param {unknown} result
 * @param {string[]} consoleEntries
 * @param {{ name: string, version: string } | undefined} provider
 * @param {{ requested: string, active: string, reason: string } | undefined} fallback
 */
function successPayload(page, result, consoleEntries, provider, fallback, proxy) {
  return {
    ok: true,
    url: page?.url ?? null,
    title: page?.title ?? null,
    result: result ?? null,
    console: consoleEntries,
    provider: provider ?? null,
    ...(page?.challenge ? { challenge: page.challenge } : {}),
    ...(page?.bodyLength !== undefined ? { bodyLength: page.bodyLength, emptyBody: page.emptyBody } : {}),
    ...(page?.webdriver !== undefined ? { webdriver: page.webdriver } : {}),
    ...(proxy ? { proxy } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * @param {unknown} error
 * @param {{ url: string | null, title: string | null } | undefined} [page]
 * @param {string[]} [consoleEntries]
 * @param {{ name: string, version: string } | undefined} [provider]
 * @param {{ requested: string, active: string, reason: string } | undefined} [fallback]
 */
function failurePayload(error, page, consoleEntries = [], provider, fallback) {
  return {
    ok: false,
    url: page?.url ?? null,
    title: page?.title ?? null,
    result: null,
    console: consoleEntries,
    error: errorMessage(error),
    ...(provider ? { provider } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * Surface the effective proxy configuration so agents can tell where traffic
 * is actually going. Reports the resolved proxy server and bypass rules from
 * the upstream env contract (PLAYWRIGHT_MCP_*) plus conventional HTTP(S)_PROXY.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ server: string, bypass: string | undefined } | undefined}
 */
function proxyDetails(env) {
  const server = env.PLAYWRIGHT_MCP_PROXY_SERVER || env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!server)
    return undefined;
  const bypass = env.PLAYWRIGHT_MCP_PROXY_BYPASS || env.NO_PROXY;
  return bypass ? { server, bypass } : { server };
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
  if (session?.__stealthProviderDetails)
    return session.__stealthProviderDetails;
  const metadata = readProviderMetadata(session?._sessionFile?.daemonDir, session?.name);
  if (metadata)
    return { name: metadata.provider, version: metadata.version };
  return inferProviderDetails(session?.config);
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function fallbackDetails(env) {
  return require('./browserProviders').readProviderFallback(env);
}

/**
 * @param {any} session
 * @param {NodeJS.ProcessEnv} env
 */
function fallbackDetailsForSession(session, env) {
  const active = fallbackDetails(env);
  if (active)
    return active;
  return readProviderMetadata(session?._sessionFile?.daemonDir, session?.name)?.fallback;
}

/**
 * Recovers provider identity for sessions created before sidecar metadata was
 * written, or when a sidecar was lost.
 *
 * @param {any} config
 */
function inferProviderDetails(config) {
  const browser = config?.browser;
  const launchOptions = browser?.launchOptions ?? {};
  const executablePath = typeof launchOptions.executablePath === 'string' ? launchOptions.executablePath.toLowerCase() : '';
  const args = Array.isArray(launchOptions.args) ? launchOptions.args : [];
  if (launchOptions.channel === 'chrome-for-testing')
    return { name: 'patchright', version: providerVersion('patchright') };
  if (browser?.browserName === 'firefox' && executablePath.includes('camoufox'))
    return { name: 'camoufox', version: providerVersion('camoufox') };
  if (executablePath.includes('cloakbrowser') || args.some(arg => typeof arg === 'string' && arg.startsWith('--fingerprint=')))
    return { name: 'cloakbrowser', version: providerVersion('cloakbrowser') };
  return undefined;
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
    if (typeof value.provider === 'string' && typeof value.version === 'string') {
      const fallback = validateFallbackDetails(value.fallback);
      return {
        provider: value.provider,
        version: value.version,
        ...(fallback ? { fallback } : {}),
      };
    }
  } catch {
  }
  return undefined;
}

/**
 * @param {unknown} value
 */
function validateFallbackDetails(value) {
  const fallback = /** @type {any} */ (value);
  if (fallback && typeof fallback === 'object' &&
      typeof fallback.requested === 'string' &&
      typeof fallback.active === 'string' &&
      typeof fallback.reason === 'string')
    return { requested: fallback.requested, active: fallback.active, reason: fallback.reason };
  return undefined;
}

/**
 * @param {string} daemonDir
 * @param {string} sessionName
 * @param {{ provider: string, version: string, fallback?: { requested: string, active: string, reason: string } }} metadata
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
/**
 * Runs on the failure path, so it must never throw: `JSON.stringify` raises on
 * circular structures and on BigInt, which would replace the real diagnostic
 * with an unrelated TypeError.
 *
 * @param {unknown} error
 */
function serializeUnknownError(error) {
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    try {
      return String(error);
    } catch {
      return 'Unknown error';
    }
  }
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : serializeUnknownError(error);
  return message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}
/**
 * Remove accumulated snapshot/console artifacts from `.playwright-cli/`.
 * `--all` removes everything; `--days=N` (default 7) removes files older than N
 * days. Long-running agent sessions otherwise grow this directory without bound.
 *
 * @param {string[]} argv
 */
function runCleanup(argv) {
  const fsSync = require('fs');
  const pathSync = require('path');
  const outputDir = pathSync.join(process.cwd(), '.playwright-cli');
  const all = argv.includes('--all');
  const json = argv.includes('--json');
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = daysArg ? parseFloat(daysArg.split('=')[1]) : 7;

  if (!fsSync.existsSync(outputDir)) {
    const empty = { removed: 0, remaining: 0, dir: outputDir };
    if (json)
      process.stdout.write(JSON.stringify(empty, null, 2) + '\n');
    else
      console.log('No .playwright-cli directory to clean.');
    return;
  }

  const cutoff = Date.now() - (isFinite(days) && days >= 0 ? days : 7) * 24 * 60 * 60 * 1000;
  const entries = fsSync.readdirSync(outputDir);
  let removed = 0;
  for (const name of entries) {
    if (!/^(page-.*\.yml|console-.*\.log|snapshot-.*|video-.*)$/.test(name))
      continue;
    const fullPath = pathSync.join(outputDir, name);
    try {
      const stat = fsSync.statSync(fullPath);
      if (all || stat.mtimeMs < cutoff) {
        fsSync.unlinkSync(fullPath);
        removed++;
      }
    } catch {
    }
  }

  const remaining = fsSync.readdirSync(outputDir).length;
  const result = { removed, remaining, dir: outputDir };
  if (json)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else
    console.log(`Removed ${removed} artifact(s); ${remaining} file(s) remain in ${outputDir}`);
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
  inferProviderDetails,
  normalizeUpstreamResult,
  parseConsoleText,
  parseTimeoutMs,
  prepareCommandArgs,
  resolveEvalOutputPath,
  runCleanup,
  successPayload,
};

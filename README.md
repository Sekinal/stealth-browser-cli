# stealth-browser-cli

Stealth Browser CLI with SKILLS

### Stealth Browser CLI vs Playwright MCP

This package provides CLI interface into Playwright. If you are using **coding agents**, that is the best fit.

- **CLI**: Modern **coding agents** increasingly favor CLI–based workflows exposed as SKILLs over MCP because CLI invocations are more token-efficient: they avoid loading large tool schemas and verbose accessibility trees into the model context, allowing agents to act through concise, purpose-built commands. This makes CLI + SKILLs better suited for high-throughput coding agents that must balance browser automation with large codebases, tests, and reasoning within limited context windows.

- **MCP**: MCP remains relevant for specialized agentic loops that benefit from persistent state, rich introspection, and iterative reasoning over page structure, such as exploratory automation, self-healing tests, or long-running autonomous workflows where maintaining continuous browser context outweighs token cost concerns. Learn more about [Playwright MCP](https://github.com/microsoft/playwright-mcp).

### Key Features

- **Token-efficient**. Does not force page data into LLM.

### Requirements
- Node.js 20 or newer
- Claude Code, GitHub Copilot, or any other coding agent.

## Getting Started

## Installation

```bash
npm install -g stealth-browser-cli
stealth-browser-cli --help
```

### Installing skills

Claude Code, GitHub Copilot and others will use the locally installed skills.

```bash
stealth-browser-cli install --skills
```

### Skills-less operation

Point your agent at the CLI and let it cook. It'll read the skill off `stealth-browser-cli --help` on its own:

```
Test the "add todo" flow on https://demo.playwright.dev/todomvc using stealth-browser-cli.
Check stealth-browser-cli --help for available commands.
```

## Demo

```
> Use playwright skills to test https://demo.playwright.dev/todomvc/.
  Take screenshots for all successful and failing scenarios.
```

Your agent will be running commands, but it does not mean you can't play with it manually:

```
stealth-browser-cli open https://demo.playwright.dev/todomvc/ --headed
stealth-browser-cli type "Buy groceries"
stealth-browser-cli press Enter
stealth-browser-cli type "Water flowers"
stealth-browser-cli press Enter
stealth-browser-cli check e21
stealth-browser-cli check e35
stealth-browser-cli screenshot
```

## Headed operation

Stealth Browser CLI is headless by default. If you'd like to see the browser, pass `--headed` to `open`:

```bash
stealth-browser-cli open https://playwright.dev --headed
```

## Sessions

Stealth Browser CLI keeps the browser profile in memory by default. Your cookies and storage state
are preserved between CLI calls within the session, but lost when the browser closes. Use
`--persistent` to save the profile to disk for persistence across browser restarts.

You can use different instances of the browser for different projects with sessions. Pass `-s=` to
the invocation to talk to a specific browser.

```bash
stealth-browser-cli open https://playwright.dev
stealth-browser-cli -s=example open https://example.com --persistent
stealth-browser-cli list
```

You can run your coding agent with the `PLAYWRIGHT_CLI_SESSION` environment variable:

```bash
PLAYWRIGHT_CLI_SESSION=todo-app claude .
```

Or instruct it to prepend `-s=` to the calls.

Manage your sessions as follows:

```bash
stealth-browser-cli list                     # list all sessions
stealth-browser-cli close-all                # close all browsers
stealth-browser-cli kill-all                 # forcefully kill all browser processes
```

## Monitoring

Use `stealth-browser-cli show` to open a visual dashboard that lets you see and control all running
browser sessions. This is useful when your coding agents are running browser automation in the
background and you want to observe their progress or step in to help.

```bash
stealth-browser-cli show
```

<img width="1107" height="729" alt="Image" src="https://github.com/user-attachments/assets/99df739d-106a-4520-b004-bb315db41da7" />

The dashboard opens a window with two views:

- **Session grid** — shows all active sessions grouped by workspace, each with a live screencast
  preview, session name, current URL, and page title. Click any session to zoom in.
- **Session detail** — shows a live view of the selected session with a tab bar, navigation
  controls (back, forward, reload, address bar), and full remote control. Click into the viewport
  to take over mouse and keyboard input; press Escape to release.

From the grid you can also close running sessions or delete data for inactive ones.

## Commands

### Core

```bash
stealth-browser-cli open [url]               # open browser, optionally navigate to url
stealth-browser-cli goto <url>               # navigate to a url
stealth-browser-cli close                    # close the page
stealth-browser-cli type <text>              # type text into editable element
stealth-browser-cli click <ref> [button]     # perform click on a web page
stealth-browser-cli dblclick <ref> [button]  # perform double click on a web page
stealth-browser-cli fill <ref> <text>        # fill text into editable element
stealth-browser-cli fill <ref> <text> --submit # fill and press Enter
stealth-browser-cli drag <startRef> <endRef> # perform drag and drop between two elements
stealth-browser-cli drop <ref> --path=<file> # drop files onto an element (from outside the page)
stealth-browser-cli drop <ref> --data="k=v"  # drop data onto an element
stealth-browser-cli hover <ref>              # hover over element on page
stealth-browser-cli select <ref> <val>       # select an option in a dropdown
stealth-browser-cli upload <file>            # upload one or multiple files
stealth-browser-cli check <ref>              # check a checkbox or radio button
stealth-browser-cli uncheck <ref>            # uncheck a checkbox or radio button
stealth-browser-cli snapshot                 # capture page snapshot to obtain element ref
stealth-browser-cli snapshot --filename=f    # save snapshot to specific file
stealth-browser-cli snapshot <ref>           # snapshot a specific element
stealth-browser-cli snapshot --depth=N       # limit snapshot depth for efficiency
stealth-browser-cli eval <func> [ref]        # evaluate javascript expression on page or element
stealth-browser-cli dialog-accept [prompt]   # accept a dialog
stealth-browser-cli dialog-dismiss           # dismiss a dialog
stealth-browser-cli resize <w> <h>           # resize the browser window
```

### Navigation

```bash
stealth-browser-cli go-back                  # go back to the previous page
stealth-browser-cli go-forward               # go forward to the next page
stealth-browser-cli reload                   # reload the current page
```

### Keyboard

```bash
stealth-browser-cli press <key>              # press a key on the keyboard, `a`, `arrowleft`
stealth-browser-cli keydown <key>            # press a key down on the keyboard
stealth-browser-cli keyup <key>              # press a key up on the keyboard
```

### Mouse

```bash
stealth-browser-cli mousemove <x> <y>        # move mouse to a given position
stealth-browser-cli mousedown [button]       # press mouse down
stealth-browser-cli mouseup [button]         # press mouse up
stealth-browser-cli mousewheel <dx> <dy>     # scroll mouse wheel
```

### Save as

```bash
stealth-browser-cli screenshot [ref]         # screenshot of the current page or element
stealth-browser-cli screenshot --filename=f  # save screenshot with specific filename
stealth-browser-cli pdf                      # save page as pdf
stealth-browser-cli pdf --filename=page.pdf  # save pdf with specific filename
```

### Tabs

```bash
stealth-browser-cli tab-list                 # list all tabs
stealth-browser-cli tab-new [url]            # create a new tab
stealth-browser-cli tab-close [index]        # close a browser tab
stealth-browser-cli tab-select <index>       # select a browser tab
```

### Storage

```bash
stealth-browser-cli state-save [filename]    # save storage state
stealth-browser-cli state-load <filename>    # load storage state

# Cookies
stealth-browser-cli cookie-list [--domain]   # list cookies
stealth-browser-cli cookie-get <name>        # get a cookie
stealth-browser-cli cookie-set <name> <val>  # set a cookie
stealth-browser-cli cookie-delete <name>     # delete a cookie
stealth-browser-cli cookie-clear             # clear all cookies

# LocalStorage
stealth-browser-cli localstorage-list        # list localStorage entries
stealth-browser-cli localstorage-get <key>   # get localStorage value
stealth-browser-cli localstorage-set <k> <v> # set localStorage value
stealth-browser-cli localstorage-delete <k>  # delete localStorage entry
stealth-browser-cli localstorage-clear       # clear all localStorage

# SessionStorage
stealth-browser-cli sessionstorage-list      # list sessionStorage entries
stealth-browser-cli sessionstorage-get <k>   # get sessionStorage value
stealth-browser-cli sessionstorage-set <k> <v> # set sessionStorage value
stealth-browser-cli sessionstorage-delete <k>  # delete sessionStorage entry
stealth-browser-cli sessionstorage-clear     # clear all sessionStorage
```

### Network

```bash
stealth-browser-cli route <pattern> [opts]   # mock network requests
stealth-browser-cli route-list               # list active routes
stealth-browser-cli unroute [pattern]        # remove route(s)
```

### DevTools

```bash
stealth-browser-cli console [min-level]      # list console messages
stealth-browser-cli requests                 # list all network requests since loading the page
stealth-browser-cli request <index>          # show details for a specific request
stealth-browser-cli run-code <code>          # run playwright code snippet
stealth-browser-cli run-code --filename=f    # run playwright code from a file
stealth-browser-cli tracing-start            # start trace recording
stealth-browser-cli tracing-stop             # stop trace recording
stealth-browser-cli video-start [filename]   # start video recording
stealth-browser-cli video-chapter <title>    # add a chapter marker to the video
stealth-browser-cli video-show-actions       # annotate each action with a callout in the video
stealth-browser-cli video-hide-actions       # stop annotating actions in the video
stealth-browser-cli video-stop               # stop video recording
stealth-browser-cli show                     # open the visual dashboard
stealth-browser-cli show --annotate          # launch dashboard for UI review / design feedback
stealth-browser-cli generate-locator <ref>   # generate a playwright locator for an element
stealth-browser-cli highlight <ref>          # show a persistent highlight overlay
stealth-browser-cli highlight <ref> --style= # highlight with a custom CSS style
stealth-browser-cli highlight <ref> --hide   # hide highlight on a specific element
stealth-browser-cli highlight --hide         # hide all page highlights
```

### Open parameters

```bash
stealth-browser-cli open --browser=chrome    # use specific browser
stealth-browser-cli attach --extension=chrome # connect via Playwright Extension
stealth-browser-cli attach --cdp=chrome      # attach to running Chrome/Edge by channel
stealth-browser-cli attach --cdp=<url>       # attach via CDP endpoint
stealth-browser-cli detach                   # detach an attached session, leaves the external browser running
stealth-browser-cli open --persistent        # use persistent profile
stealth-browser-cli open --profile=<path>    # use custom profile directory
stealth-browser-cli open --config=file.json  # use config file
stealth-browser-cli close                    # close the browser
stealth-browser-cli delete-data              # delete user data for default session
```

By default, this fork opens new sessions with CloakBrowser. If CloakBrowser cannot
start, it falls back to Patchright's bundled Chromium and then Camoufox. Set
`PLAYWRIGHT_CLI_BROWSER_PROVIDER=patchright`, `camoufox`, or a comma-separated
order such as `camoufox,patchright` to override the provider order. Explicit
`--browser`, `--config`, `PLAYWRIGHT_MCP_BROWSER`, and `PLAYWRIGHT_MCP_CONFIG`
settings are respected and skip the automatic provider selection.

### Snapshots

After each command, stealth-browser-cli provides a snapshot of the current browser state.

```bash
> stealth-browser-cli goto https://example.com
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

You can also take a snapshot on demand using `stealth-browser-cli snapshot` command. All the options below can be combined as needed.

```bash
# default - save to a file with timestamp-based name
stealth-browser-cli snapshot

# save to file, use when snapshot is a part of the workflow result
stealth-browser-cli snapshot --filename=after-click.yaml

# snapshot an element instead of the whole page
stealth-browser-cli snapshot "#main"

# limit snapshot depth for efficiency, take a partial snapshot afterwards
stealth-browser-cli snapshot --depth=4
stealth-browser-cli snapshot e34

# include each element's bounding box as [box=x,y,width,height]
stealth-browser-cli snapshot --boxes
```

### Targeting elements

By default, use refs from the snapshot to interact with page elements.

```bash
# get snapshot with refs
stealth-browser-cli snapshot

# interact using a ref
stealth-browser-cli click e15
```

You can also use css selectors or Playwright locators.

```bash
# css selector
stealth-browser-cli click "#main > button.submit"

# role locator
stealth-browser-cli click "getByRole('button', { name: 'Submit' })"

# test id
stealth-browser-cli click "getByTestId('submit-button')"
```

### Sessions

```bash
stealth-browser-cli -s=name <cmd>            # run command in named session
stealth-browser-cli -s=name close            # stop a named browser
stealth-browser-cli -s=name delete-data      # delete user data for named browser
stealth-browser-cli list                     # list all sessions
stealth-browser-cli close-all                # close all browsers
stealth-browser-cli kill-all                 # forcefully kill all browser processes
```

### Local installation

If global `stealth-browser-cli` command is not available, try a local version via `npx stealth-browser-cli`:

```bash
npx --no-install stealth-browser-cli --version
```

When local version is available, use `npx stealth-browser-cli` in all commands. Otherwise, install `stealth-browser-cli` as a global command:

```bash
npm install -g stealth-browser-cli
```

## Configuration file

The Stealth Browser CLI can be configured using a JSON configuration file. You can specify the configuration file using the `--config` command line option:

```bash
stealth-browser-cli --config path/to/config.json open example.com
```

Stealth Browser CLI will load config from `.playwright/cli.config.json` by default so that you did not need to specify it every time.

<details>
<summary>Configuration file schema</summary>

```typescript
{
  /**
   * The browser to use.
   */
  browser?: {
    /**
     * The type of browser to use.
     */
    browserName?: 'chromium' | 'firefox' | 'webkit';

    /**
     * Keep the browser profile in memory, do not save it to disk.
     */
    isolated?: boolean;

    /**
     * Path to a user data directory for browser profile persistence.
     * Temporary directory is created by default.
     */
    userDataDir?: string;

    /**
     * Launch options passed to
     * @see https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
     *
     * This is useful for settings options like `channel`, `headless`, `executablePath`, etc.
     */
    launchOptions?: playwright.LaunchOptions;

    /**
     * Context options for the browser context.
     *
     * This is useful for settings options like `viewport`.
     */
    contextOptions?: playwright.BrowserContextOptions;

    /**
     * Chrome DevTools Protocol endpoint to connect to an existing browser instance in case of Chromium family browsers.
     */
    cdpEndpoint?: string;

    /**
     * CDP headers to send with the connect request.
     */
    cdpHeaders?: Record<string, string>;

    /**
     * Timeout in milliseconds for connecting to CDP endpoint. Defaults to 30000 (30 seconds). Pass 0 to disable timeout.
     */
    cdpTimeout?: number;

    /**
     * Remote endpoint to connect to an existing Playwright server.
     */
    remoteEndpoint?: string;

    /**
     * Paths to TypeScript files to add as initialization scripts for Playwright page.
     */
    initPage?: string[];

    /**
     * Paths to JavaScript files to add as initialization scripts.
     * The scripts will be evaluated in every page before any of the page's scripts.
     */
    initScript?: string[];
  },

  /**
   * If specified, saves the Playwright video of the session into the output directory.
   */
  saveVideo?: {
    width: number;
    height: number;
  };

  /**
   * The directory to save output files.
   */
  outputDir?: string;

  /**
   * Whether to save snapshots, console messages, network logs and other session logs to a file or to the standard output. Defaults to "stdout".
   */
  outputMode?: 'file' | 'stdout';

  console?: {
    /**
     * The level of console messages to return. Each level includes the messages of more severe levels. Defaults to "info".
     */
    level?: 'error' | 'warning' | 'info' | 'debug';
  },

  network?: {
    /**
     * List of origins to allow the browser to request. Default is to allow all. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     */
    allowedOrigins?: string[];

    /**
     * List of origins to block the browser to request. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     */
    blockedOrigins?: string[];
  };

  /**
   * Specify the attribute to use for test ids, defaults to "data-testid".
   */
  testIdAttribute?: string;

  timeouts?: {
    /*
     * Configures default action timeout: https://playwright.dev/docs/api/class-page#page-set-default-timeout. Defaults to 5000ms.
     */
    action?: number;

    /*
     * Configures default navigation timeout: https://playwright.dev/docs/api/class-page#page-set-default-navigation-timeout. Defaults to 60000ms.
     */
    navigation?: number;
  };

  /**
   * Whether to allow file uploads from anywhere on the file system.
   * By default (false), file uploads are restricted to paths within the MCP roots only.
   */
  allowUnrestrictedFileAccess?: boolean;

  /**
   * Specify the language to use for code generation.
   */
  codegen?: 'typescript' | 'none';
}
```

</details>

<details>
<summary>Configuration via env</summary>

| Environment |
|-------------|
| `PLAYWRIGHT_MCP_ALLOWED_HOSTS` comma-separated list of hosts this server is allowed to serve from. Defaults to the host the server is bound to. Pass '*' to disable the host check. |
| `PLAYWRIGHT_MCP_ALLOWED_ORIGINS` semicolon-separated list of TRUSTED origins to allow the browser to request. Default is to allow all. Important: *does not* serve as a security boundary and *does not* affect redirects. |
| `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS` allow access to files outside of the workspace roots. Also allows unrestricted access to file:// URLs. By default access to file system is restricted to workspace root directories (or cwd if no roots are configured) only, and navigation to file:// URLs is blocked. |
| `PLAYWRIGHT_MCP_BLOCKED_ORIGINS` semicolon-separated list of origins to block the browser from requesting. Blocklist is evaluated before allowlist. If used without the allowlist, requests not matching the blocklist are still allowed. Important: *does not* serve as a security boundary and *does not* affect redirects. |
| `PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS` block service workers |
| `PLAYWRIGHT_MCP_BROWSER` browser or chrome channel to use, possible values: chrome, firefox, webkit, msedge. |
| `PLAYWRIGHT_MCP_CAPS` comma-separated list of additional capabilities to enable, possible values: vision, pdf. |
| `PLAYWRIGHT_MCP_CDP_ENDPOINT` CDP endpoint to connect to. |
| `PLAYWRIGHT_MCP_CDP_HEADERS` CDP headers to send with the connect request, multiple can be specified. |
| `PLAYWRIGHT_MCP_CDP_TIMEOUT` timeout for the CDP connection. |
| `PLAYWRIGHT_MCP_CONFIG` path to the configuration file. |
| `PLAYWRIGHT_MCP_CONSOLE_LEVEL` level of console messages to return: "error", "warning", "info", "debug". Each level includes the messages of more severe levels. |
| `PLAYWRIGHT_MCP_DEVICE` device to emulate, for example: "iPhone 15" |
| `PLAYWRIGHT_MCP_EXECUTABLE_PATH` path to the browser executable. |
| `PLAYWRIGHT_MCP_EXTENSION` Connect to a running browser instance (Edge/Chrome only). Requires the "Playwright MCP Bridge" browser extension to be installed. |
| `PLAYWRIGHT_MCP_GRANT_PERMISSIONS` List of permissions to grant to the browser context, for example "geolocation", "clipboard-read", "clipboard-write". |
| `PLAYWRIGHT_MCP_HEADLESS` whether to run browser in headless mode, headless by default. |
| `PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS` ignore https errors |
| `PLAYWRIGHT_MCP_INIT_PAGE` path to TypeScript file to evaluate on Playwright page object |
| `PLAYWRIGHT_MCP_INIT_SCRIPT` path to JavaScript file to add as an initialization script. The script will be evaluated in every page before any of the page's scripts. Can be specified multiple times. |
| `PLAYWRIGHT_MCP_ISOLATED` keep the browser profile in memory, do not save it to disk. |
| `PLAYWRIGHT_MCP_SANDBOX` whether to enable the browser sandbox. |
| `PLAYWRIGHT_MCP_OUTPUT_DIR` path to the directory for output files. |
| `PLAYWRIGHT_MCP_PROXY_BYPASS` comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com" |
| `PLAYWRIGHT_MCP_PROXY_SERVER` specify proxy server, for example "http://myproxy:3128" or "socks5://myproxy:8080" |
| `PLAYWRIGHT_MCP_SAVE_TRACE` Whether to save the Playwright Trace of the session into the output directory. |
| `PLAYWRIGHT_MCP_SAVE_VIDEO` Whether to save the video of the session into the output directory. For example "--save-video=800x600" |
| `PLAYWRIGHT_MCP_SECRETS_FILE` path to a file containing secrets in the dotenv format |
| `PLAYWRIGHT_MCP_STORAGE_STATE` path to the storage state file for isolated sessions. |
| `PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE` specify the attribute to use for test ids, defaults to "data-testid" |
| `PLAYWRIGHT_MCP_TIMEOUT_ACTION` specify action timeout in milliseconds, defaults to 5000ms |
| `PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION` specify navigation timeout in milliseconds, defaults to 60000ms |
| `PLAYWRIGHT_MCP_USER_AGENT` specify user agent string |
| `PLAYWRIGHT_MCP_USER_DATA_DIR` path to the user data directory. If not specified, a temporary directory will be created. |
| `PLAYWRIGHT_MCP_VIEWPORT_SIZE` specify browser viewport size in pixels, for example "1280x720" |
</details>

## Specific tasks

The installed skill includes detailed reference guides for common tasks:

* **Running and Debugging Playwright tests** — run, debug and manage Playwright test suites
* **Request mocking** — intercept and mock network requests
* **Running Playwright code** — execute arbitrary Playwright scripts
* **Browser session management** — manage multiple browser sessions
* **Spec-driven testing (plan / generate / heal)** — drive tests from a written spec
* **Storage state (cookies, localStorage)** — persist and restore browser state
* **Test generation** — generate Playwright tests from interactions
* **Tracing** — record and inspect execution traces
* **Video recording** — capture browser session videos
* **Inspecting element attributes** — get element id, class, or any attribute not visible in the snapshot

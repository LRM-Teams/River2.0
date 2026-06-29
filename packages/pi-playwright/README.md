# @lebronj/pi-playwright

Optional Playwright browser automation package for pi.

## Install

```bash
pi install npm:@lebronj/pi-playwright
```

This package depends on `playwright`, but npm package installation alone may not install browser binaries or operating-system libraries. After installing the pi package, run:

```bash
npx playwright install chromium
```

On fresh Linux machines or containers, install the browser system dependencies too:

```bash
npx playwright install --with-deps chromium
```

If your environment already has a compatible browser, you can point Playwright at it with `executablePath` in the `browser_navigate` tool instead of installing bundled browsers.

## Tools

The package registers these pi tools:

- `browser_navigate` - open a URL in a persistent headless Chromium session.
- `browser_snapshot` - get page text, links, buttons, inputs, and forms for deciding what to click or type.
- `browser_click` - click an element by CSS selector or by text.
- `browser_type` - fill an input/textarea/contenteditable element and optionally press Enter.
- `browser_press_key` - press a keyboard key.
- `browser_wait_for` - wait for time, text, text disappearance, or a visible selector.
- `browser_evaluate` - run a JavaScript function on the page.
- `browser_screenshot` - save a screenshot to a temporary file.
- `browser_close` - close the browser session.

## Notes

- The browser is headless by default and shared across tool calls in the same pi process.
- Set `PI_PLAYWRIGHT_HEADFUL=1` to launch a visible browser window.
- Use `browser_close` when you are done, or pi will close the browser on session shutdown.

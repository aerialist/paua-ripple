# PauaRipple

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Z8Z11Z232Z)

**Live: [paua-ripple.shunpy.net](https://paua-ripple.shunpy.net)**

Browser-based voice dictation powered by the [Aqua Voice Avalon API](https://aquavoice.com/avalon-api).

> Unofficial BYOK client — your API keys stay in your browser and are sent directly to Aqua Voice and OpenAI. This site never proxies your keys.

## What it does

- Record your voice with a push-to-talk or toggle button
- Transcribe via the Aqua Voice Avalon API directly from the browser
- Insert dictation at the cursor position in an editable transcript
- Optionally select a span of text and dictate an edit instruction — OpenAI rewrites the selection in place
- Live mic waveform and dB meter while recording
- History pane to restore any previous transcript state

## Getting your API keys

### Aqua Voice Avalon API key (required)

1. Go to [app.aquavoice.com/api-dashboard](https://app.aquavoice.com/api-dashboard)
2. Sign in or create an account
3. Generate an API key

Aqua Voice Avalon API pricing: $0.39 per hour of audio.

### OpenAI API key (optional — for AI edit-on-selection only)

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Sign in or create an account
3. Create a new secret key

OpenAI pricing: the default model (`gpt-4.1-nano`) is very cheap for edit use.

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).  
Click **⚙️ Settings** and enter your API keys.

## Static build

```bash
npm run build
# Output is in out/ — deploy anywhere that can serve static files
```

Suitable for GitHub Pages, nginx, Apache, or any static file host.

## Using the app

1. Open **⚙️ Settings** and enter your Aqua Voice Avalon API key
2. Choose a language (Auto-detect / English / Japanese)
3. Record:
   - **Hold to talk** — hold the blue button while speaking, release to transcribe
   - **Toggle record** — click the teal button to start, click again to stop
4. Transcript appears in the textarea and is automatically copied to clipboard
   - If textarea has a cursor, dictation inserts at that position
   - If textarea is empty or unfocused, dictation replaces the content
5. To AI-edit: select a span of text, then record an edit instruction

## Settings

All settings are stored in your browser only (`localStorage`).

| Setting | Description |
|---|---|
| Aqua Voice Avalon API key | Required for transcription |
| OpenAI API key | Optional — used for selection-based AI edit |
| Language | Auto-detect, English, or Japanese |
| Aqua model | Default: `avalon-v1.5` |
| OpenAI model | Default: `gpt-4.1-nano` |
| Aqua base URL | Default: `https://api.aquavoice.com/api/v1` |
| OpenAI base URL | Default: `https://api.openai.com/v1` |

## Support

If PauaRipple is useful to you, consider buying me a coffee:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Z8Z11Z232Z)

## License

MIT — see [LICENSE](LICENSE).

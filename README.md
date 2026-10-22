# React Detective

![React Detective explaining a SearchBox component, with its props, live values and outline](https://raw.githubusercontent.com/headbranch/react-detective/main/docs/screenshot.png)

Understand a React codebase by pointing at it. Click any part of your running app and get an explanation of the component behind it: what it's for, what its props and state do, and where it's used, alongside the live values from the page you're looking at.

Useful when you're new to a codebase, or when the code was written by AI and nobody has read it closely.

Works with **Vite** and **Next.js**. Runs only in development.

## Setup

### Automatic

Run this in your project:

```bash
npx react-detective init
```

It installs the package, adds it to your Vite or Next.js config, and offers to save your API key. You'll see every change before it's made.

### Manual

```bash
npm i -D react-detective
```

**Vite**

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import detective from "react-detective/vite";

export default defineConfig({
  plugins: [detective(), react()],
});
```

**Next.js**

```js
// next.config.mjs
import { withDetective } from "react-detective/next";

export default withDetective({
  /* your config */
});
```

```tsx
// app/layout.tsx
import { Detective } from "react-detective/react";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Detective />
      </body>
    </html>
  );
}
```

Start your dev server as usual. A **Detective** badge appears in the corner of the page.

### Options

```ts
detective({ model: "opus" });              // Vite
withDetective(config, { model: "opus" });  // Next.js
```

| Option | Default | |
| --- | --- | --- |
| `model` | `"sonnet"` | Model for explanations and follow-up questions: `"haiku"`, `"sonnet"`, `"opus"` or a full model ID. |
| `storeDir` | `".react-detective"` | Where explanations are saved. |
| `showLauncher` | `true` | Show the **Detective** badge. You can still press **Alt** without it. |
| `port` (Next.js) | `5899` | Port for the local server. `<Detective />` picks it up automatically. |

### API key

Explanations are written by Claude, using your own [Anthropic API key](https://console.anthropic.com/settings/keys). You can add it any time: without one, everything works except writing new explanations and answers. Add it to `.env.local` in your project (make sure that file is in `.gitignore`):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

An `ANTHROPIC_API_KEY` set in your environment works too. No restart needed.

## Usage

1. Press **Alt** (or click the badge) to start inspecting.
2. Hover to see each component's name and file.
3. Click one to open its explanation.

Then:

- Expand items in the outline to see what they do and their current values.
- Hover a highlighted name or type to preview it; click to jump to it.
- Click a file or line to open it in your editor.
- Use the breadcrumbs at the top to move to a parent component.
- Ask follow-up questions in the box at the bottom.
- Press **Esc** to stop inspecting or close the panel.

## What it costs

You'll see an outline of the component immediately, read straight from your code at no cost. The full explanation follows within about 20 seconds and typically costs a few cents.

You only pay once per explanation. They're saved in a `.react-detective/` folder in your project and opened instantly next time, until the code changes. **Commit this folder** so your team gets them for free too.

## Privacy and safety

- The AI can read files in your project but can't change anything or run commands.
- Your API key stays in the local dev server. It's never sent to the browser or saved with the explanations.
- Code is sent to Anthropic only when a new explanation or answer is generated; saved ones are served from disk.
- Nothing is added to production builds.

## Limitations

- Works with Vite and Next.js. Frameworks built on Vite, like React Router, use the Vite setup. Using something else? Open an issue.
- Components that render no HTML of their own (wrappers, providers) can't be clicked directly. Reach them through the breadcrumbs.
- Live values are available for client components only.

## Contributing

```bash
npm install
npm run build      # build the library
npm test           # run tests
npm run dev:vite   # Vite demo on http://localhost:5173
npm run dev:next   # Next.js demo on http://localhost:3000
```

The library is in `packages/react-detective`; demo apps are in `examples/`.

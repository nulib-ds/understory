# Understory admin UI

The admin app for Understory: a Next.js 15 App Router app, rendered in the browser behind Cognito and hosted on Amplify Hosting's managed server.

## Run it

1. Copy `.env.local.example` to `.env.local` and fill it in from your stack's outputs.
2. Run `npm install`.
3. Run `npm run dev`, and open http://localhost:3000.

| Command | Does |
|---|---|
| `npm run dev` | Starts the dev server on port 3000 |
| `npm run build` | Runs the production build, the one Amplify runs |
| `npm run lint` | Runs ESLint |

## Layout

| Path | Contents |
|---|---|
| `src/app/` | Routes: one folder per route, the layouts, and not-found |
| `src/screens/` | The screen each route renders |
| `src/components/` | Everything the screens share |
| `src/lib/` | API access, the session, and IIIF helpers |

Only `src/app/layout.jsx` imports global CSS, in cascade order. [AGENTS.md](../AGENTS.md) explains this and the UI's other conventions.

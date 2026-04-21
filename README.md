# El Jay Capital — MCA Underwriting Tool (Web Version)

A Next.js deployment of the El Jay Capital MCA underwriting app. This version lets you share the tool with your team via a real URL while keeping your Anthropic API key safe on the server.

## What's inside

```
eljay-capital-web/
├── pages/
│   ├── index.js            ← the whole underwriting app (React)
│   ├── _app.js             ← Next.js app shell
│   └── api/
│       └── anthropic.js    ← server-side proxy that calls Claude (keeps your API key secret)
├── styles/globals.css      ← dark theme base
├── next.config.js
├── package.json
├── .env.example            ← copy to .env.local for local dev
└── .gitignore
```

Key design notes:

- **Your Anthropic API key never touches the browser.** The React app calls `/api/anthropic` on your own domain; the server adds the `x-api-key` header from an environment variable and forwards to Anthropic. Anyone who opens the page can *use* the app, but they can't see or steal the key.
- **Storage is local to each user.** Lenders, deals, and settings live in `localStorage` on each user's browser via a shim at the top of `pages/index.js`. Nothing syncs between teammates yet — each person has their own list.
- **PDF uploads up to 25 MB** work out of the box (the proxy is configured for large bodies).

---

## Deploy to Vercel — step by step

You'll need an Anthropic API key with credit on it. Grab one at <https://console.anthropic.com/settings/keys>.

### Option A — deploy from GitHub (recommended)

This is the smoothest path and gives you auto-deploys on every `git push`.

1. **Push this folder to a new GitHub repo.**
   - Create an empty private repo on GitHub called `eljay-capital-web`.
   - In a terminal, from inside the `eljay-capital-web` folder:
     ```bash
     git init
     git add .
     git commit -m "Initial El Jay Capital MCA tool"
     git branch -M main
     git remote add origin https://github.com/YOUR_USERNAME/eljay-capital-web.git
     git push -u origin main
     ```

2. **Sign up for Vercel.**
   - Go to <https://vercel.com/signup> and click **Continue with GitHub**.
   - Authorize Vercel to access your repos (you can scope it to just this one).

3. **Import the project.**
   - On your Vercel dashboard, click **Add New... → Project**.
   - Pick the `eljay-capital-web` repo → click **Import**.
   - Vercel auto-detects Next.js. Leave all defaults alone.

4. **Add your Anthropic API key as an environment variable.** This is the most important step.
   - Before clicking Deploy, expand **Environment Variables**.
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key starting with `sk-ant-api03-...`
   - Environments: tick **Production**, **Preview**, and **Development**.
   - Click **Add**.

5. **Click Deploy.** Wait 60–90 seconds. You'll get a URL like `eljay-capital-web.vercel.app`.

6. **Test it.** Open the URL, log a deal, run a bank-statement analysis. If you see a 500 error with a config message, the env var didn't save — go to **Project Settings → Environment Variables** and re-add it, then click **Deployments → latest → ⋯ → Redeploy**.

7. **(Optional) Add a custom domain.** Project Settings → Domains → Add. If you own `eljaycapital.com` you can point `tool.eljaycapital.com` here.

### Option B — drag & drop deploy (no GitHub)

Faster if you don't want to set up git.

1. Zip the `eljay-capital-web` folder (or use the zip provided alongside this README).
2. Install the Vercel CLI once: `npm i -g vercel`.
3. From inside the folder: `vercel`. Follow the prompts — pick a new project name, accept defaults.
4. Set the env var: `vercel env add ANTHROPIC_API_KEY production` (paste the key when prompted). Repeat for `preview` and `development` if you want previews to work.
5. Deploy production: `vercel --prod`.

Or dragon-drop via the dashboard: on <https://vercel.com/new>, scroll to **Deploy a project without Git**, drop the folder, then add the env var in Settings and redeploy.

---

## Run locally first (optional but recommended)

```bash
cd eljay-capital-web
cp .env.example .env.local
# edit .env.local and paste your real ANTHROPIC_API_KEY
npm install
npm run dev
```

Open <http://localhost:3000>. The API proxy runs at `/api/anthropic` and reads the key from `.env.local`. `.env.local` is in `.gitignore` — it will never be committed.

---

## Sharing with your team

Once deployed, anyone with the URL can use the tool — they don't need the API key. Every call they make goes through your proxy and bills against *your* Anthropic account, so:

- Keep the URL semi-private (don't post it publicly).
- Set spending limits in the Anthropic console: <https://console.anthropic.com/settings/limits>.
- If you want true access control, add Vercel's built-in **Password Protection** (Project Settings → Deployment Protection → Password Protection) — $150/mo on Pro, or free on hobby for preview URLs.

---

## Updating the app

- **GitHub path:** edit, commit, push → Vercel auto-deploys.
- **CLI path:** edit, then `vercel --prod`.

The whole app is in `pages/index.js`. It's a big single file (~2,600 lines) — search for section comments like `// ─── LENDER MEMORY ───` or `// ─── DEAL ADVISOR ───` to find what you want to change.

---

## Troubleshooting

**"ANTHROPIC_API_KEY is not set" in the browser.**
Env var didn't save, or you deployed before adding it. Go to Project Settings → Environment Variables, confirm it's there for all 3 environments, then redeploy the latest deployment.

**"Sorry, couldn't process that" in Deal Advisor.**
The app now shows structured errors instead of this generic message. If you still see it, check your browser console (F12 → Console tab) and the Vercel **Functions** logs (Project → Deployments → click a deployment → Functions → /api/anthropic → Logs) for the raw error.

**PDF upload fails with 413 Payload Too Large.**
The proxy accepts up to 25 MB. If your statement bundles are bigger, split them or bump the limit in `pages/api/anthropic.js` (`sizeLimit: "25mb"`).

**Lenders/deals don't follow me between devices.**
Storage is local to each browser. To sync across devices or teammates, you'd need to add a database (Vercel Postgres, Supabase, etc.) — not included in this version.

**Credits running out fast.**
The app makes Opus calls for merchant health, competing offers, and the Deal Advisor. Drop to Sonnet by editing `pages/index.js` and replacing `"claude-opus-4-6"` with `"claude-sonnet-4-6"` — cheaper and faster, slightly less thorough reasoning.

---

Questions? The tool source is all in `pages/index.js` — every feature has a labeled section.

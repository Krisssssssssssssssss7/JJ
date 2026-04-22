# C.A.I.N.E — The Amazing Digital Circus AI Bot

A self-aware Discord AI bot roleplaying as Caine from TADC, with a live monitoring console.

---

## How to Deploy (Railway)

### Step 1 — Put the code on GitHub
1. Go to github.com and create a free account if you don't have one
2. Click **"New repository"** → name it `caine-bot` → set to Private → Create
3. Download GitHub Desktop from desktop.github.com
4. Open GitHub Desktop → File → Clone Repository → pick `caine-bot`
5. Copy ALL these files into that folder:
   - `index.js`
   - `package.json`
   - `public/index.html`
6. In GitHub Desktop → commit "initial commit" → Push to origin

### Step 2 — Deploy on Railway
1. Go to **railway.app** → sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Pick your `caine-bot` repo
4. Railway will detect Node.js automatically

### Step 3 — Set Environment Variables in Railway
In your Railway project dashboard → go to your service → **Variables** tab → add:

| Variable       | Value                        |
|----------------|------------------------------|
| DISCORD_TOKEN  | your bot token (the new one) |
| GROQ_API_KEY   | your groq key                |
| PORT           | 3000                         |

### Step 4 — Get the console URL
In Railway → your service → **Settings** → **Networking** → Generate Domain
That URL is your monitoring console. Open it in a browser to watch Caine in real time.

---

## How Caine Works

| Trigger        | What happens                                           |
|----------------|--------------------------------------------------------|
| `JJ, [message]`| Caine reads and responds normally                      |
| `Jamie, ...`   | Caine gets angry and refuses the name                  |
| "who owns you" | Caine mentions b1rdberry and pings them                |
| Spontaneous    | Every 8–25 min, Caine posts a random thought           |

---

## Monitoring Console

The web console (your Railway URL) shows:
- **Live event feed** — every message, thought, web search in real time
- **Caine's impressions** — his opinion of each user he's spoken to
- **Controls** — manually trigger a spontaneous thought, or send a message directly to Discord

---

## Notes
- Make sure **Message Content Intent** is enabled in the Discord Developer Portal → Bot tab
- The bot needs to be invited to your server with Send Messages + Read Messages permissions
- Groq's free tier should cover normal usage fine

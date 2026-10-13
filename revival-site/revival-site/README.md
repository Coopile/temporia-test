# Revival site starter

A small, dependency-free website for a game platform: signup/login, avatar pick, profile, launcher download page, support page, and a launcher API.

## Run it

Needs Node 22.13 or newer. No `npm install` required.

    node server.js

Then open http://localhost:3000.

## Make it yours

Edit `config.js`:

- `siteName`: use your OWN name (not Roblox's, and nothing that could be mistaken for it).
- `theme`: `theme-2016`, `theme-2017` or `theme-dark`. Themes live in `public/css/`.
- `discordInvite`, `launcherUrl`: your links.
- `requireDiscordVerification`: when true, signup needs a one-time code.
- `serverApiKey`: change it, or set the `SERVER_API_KEY` environment variable.

Put your own logo in `public/` and reference it from `views/layout.html`.

## Pages

`/` home, `/signup`, `/login`, `/profile`, `/download`, `/help`.

## API (for your launcher, game servers and Discord bot)

- `POST /api/launcher/login` with `{username, password}` returns a 5-minute one-time `ticket`.
- `POST /api/launcher/redeem` with header `x-api-key` and `{ticket}` returns the verified user (ticket is consumed).
- `POST /api/discord/code` with header `x-api-key` and `{discordId}` returns a signup code for your bot to DM.

## Before going public

- Serve it over HTTPS (a reverse proxy like Caddy or nginx) and add the `Secure` flag to the session cookie in `server.js`.
- Back up `data.db`.
- Add email or Discord-based password reset, and a terms/privacy page.
- Only host software you have the right to distribute. Roblox's client and server files are copyrighted and they send takedowns.

## What is not included

The launcher app and the game servers. The API above is the hook the launcher will call.

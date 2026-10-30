# Battle Table

> **Supabase edition.** Live play now runs over Supabase Realtime and saves go to the `game_states` table.
> Setup: run `supabase-setup.sql` in the Supabase SQL Editor, then set `DM_KEY` at the top of `public/shim.js`.
> DM link: `http://localhost:3000/?dm=YOUR_DM_KEY`. Rooms still work with `?room=friday`.
> `server.js` now only serves the page; the old WebSocket sync and `DM_KEY` environment variable are no longer used.

A multiplayer D&D battle map with circle tokens, a paintable or pasteable map, and an initiative tracker.
Friends join with a plain link. No accounts.

## Run it on your computer (2 minutes)

    npm install
    npm start

The terminal prints a **DM link** such as `http://localhost:3000/?dm=AbC123...`.
Open it once. Your browser remembers you as the DM.
Friends on the same Wi-Fi open `http://YOUR-COMPUTER-IP:3000/`.

To play with friends elsewhere tonight, run a tunnel next to it, for example
`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`,
and send friends the https address it prints.

## Put it online (free tier hosts)

1. Create a GitHub repository and upload this folder (without `node_modules`).
2. On render.com choose New, then Web Service, and connect the repository.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `DM_KEY` = a long secret you invent, for example `purple-owlbear-4471-tavern`
3. When it is live, open `https://YOUR-APP.onrender.com/?dm=YOUR_DM_KEY` once. That is your DM link.
4. Send friends `https://YOUR-APP.onrender.com/`. The Map tab shows the player link.

Railway, Fly.io and any host that runs Node 18 or newer work the same way.
Free plans may put the app to sleep after a while without visitors, so the first visit then takes a short time to wake it.
Free plans may also clear saved tables when the app restarts. Use "Copy current map" in the Map tab to keep your maps as text.

## Rooms

Add `?room=friday` to the link for a separate table. Each room has its own map, tokens and battle.
The same DM key works in every room.

## What the server enforces

- Only the DM can change the map, add or move foes and allies, hide tokens, and run the battle.
- Players can add player-character tokens, move and edit only their own, and end their own turn.
- Hidden tokens are not sent to players at all.

Anyone with your DM link is the DM, so keep it private. Change `DM_KEY` to lock out an old link.

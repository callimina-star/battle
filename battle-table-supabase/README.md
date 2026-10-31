# Battle Table (Supabase + Vercel edition)

A multiplayer D&D battle map with circle tokens, initiative and turn tracking, saved maps, and tables that are remembered between sessions.

- **Vercel** hosts the web pages.
- **Supabase** stores everything (tables, tokens, maps, battles) and sends live updates to every player.
- **GitHub** holds the code. Every time you change it, Vercel republishes automatically.

Friends need no account. They open a link and play.

```
public/            the website (lobby, game page, connection code, config.js)
supabase/          the database setup (schema.sql, plus the same file as a migration)
vercel.json        tells Vercel to serve the public/ folder
```

You do these three things once, in this order: **A. GitHub, B. Supabase, C. Vercel.**

---

## A. Put the code on GitHub

1. Unzip this folder on your computer.
2. On github.com click **+**, then **New repository**. Name it `battle-table`, leave it empty, click **Create repository**.
3. Click **uploading an existing file**. Open the unzipped folder, select everything inside it (`public`, `supabase`, `vercel.json`, `README.md`, `.gitignore`) and drag it onto the page. Drag the contents, not the folder itself.
4. Click **Commit changes**.

## B. Set up Supabase (what to add or edit)

1. Go to supabase.com, sign in, and click **New project**. Pick a name, a database password (save it somewhere), and the region nearest your players. Wait a minute or two while it sets up.
2. **Add the database tables.** In the left menu open **SQL Editor**, then **New query**. On GitHub open `supabase/schema.sql`, copy all of it, paste it into the query box, and click **Run**. You should see "Success. No rows returned".
3. **Turn on anonymous sign-in.** Open **Authentication**, then **Sign In / Providers**, and switch on **Allow anonymous sign-ins**. This lets friends join without an account. Each browser gets a private identity behind the scenes.
4. **Copy your two connection values.** Open **Project Settings**, then **API** (or click the **Connect** button at the top). Copy:
   - the **Project URL**, which looks like `https://abcdefgh.supabase.co`
   - the **anon** key, or the key labelled **publishable**. Use only that one, never a `service_role` or `secret` key.
5. **Paste them into the repository.** On GitHub open `public/config.js`, click the pencil icon, replace `YOUR-PROJECT-ID.supabase.co` and `YOUR-ANON-OR-PUBLISHABLE-KEY` with your values, and click **Commit changes**. These two values are safe to be public. The rules in `schema.sql` are what protect your tables.

That is the whole sync. The website reads `config.js` to find your Supabase project, and `schema.sql` is the one-time setup of the project. Nothing else needs connecting.

Optional extras:
- Supabase has a GitHub integration (Project Settings, Integrations) that applies the files in `supabase/migrations` whenever you push. It may need a paid plan, and you don't need it. Pasting `schema.sql` once does the same job.
- Under Authentication, Attack Protection, you can switch on a CAPTCHA if strangers start creating junk tables.
- Free Supabase projects pause after about a week with no visitors. Your data is kept. Open the project dashboard and press **Restore** to wake it. Check Supabase's current terms for details.

## C. Launch on Vercel

1. Go to vercel.com and sign up with your GitHub account (the free Hobby plan is for personal, non-commercial use).
2. Click **Add New**, then **Project**, and **Import** your `battle-table` repository.
3. Leave **Framework Preset** as **Other**. Leave the build command empty and leave Root Directory as it is. `vercel.json` already points at the `public` folder. No environment variables are needed.
4. Click **Deploy**. After about 30 seconds you get an address like `https://battle-table.vercel.app`.
5. Open it, type a table name, and click **Create table**.

## Playing

- **DM:** after creating a table you are the Dungeon Master. Open the **Map** tab and copy your two links. The **player link** goes to friends. The **DM link** is private. Bookmark it, because it is how you get DM powers back on another device or after clearing your browser.
- **Players:** open the player link, go to the **Tokens** tab, add their character, and roll initiative when the DM asks.
- **Saved maps:** in the Map tab, press **Save current map** to keep it in that table's library. **Load** brings it back later. You can also paste a map as text, paint terrain, or upload a picture.
- **Come back next week:** open the same links. The table, map, tokens and battle are all still there.

## Who can do what

The database enforces these rules, not just the screen:

- Only the DM can change the map or picture, add or move allies and foes, hide tokens, and start or end a battle.
- Players can add player-character tokens, move and edit only their own, and end their own turn.
- Hidden tokens are never sent to players.
- Anyone with your DM link is the DM, so keep it private.

## Changing things later

Edit any file on GitHub and commit. Vercel redeploys within a minute. If you change the database, add a new `.sql` file to `supabase/migrations` and run it in the SQL Editor.

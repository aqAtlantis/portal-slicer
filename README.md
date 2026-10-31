# Portal slicer bot

everything below is ai

Mineflayer bot that slices configured Nether portal layouts. Set your own server and layout details locally before running.

## Setup
1. Node.js 22+ (already installed for the cleric bot).
2. In this folder: `npm install` (or just run `.\Start-Slicer.ps1`, which installs on first run).
3. Copy `config.example.json` to `config.json`, then set your server address, bot username, owner usernames, hub coordinates, and portal layout. `config.json` is ignored by Git.
4. Set `hub.stand` to the block the bot stands on at the material hub. Optionally pin chest positions in `hub.chests`; otherwise it searches every chest/barrel/shulker within `hub.searchRadius`.

## Login (EasyAuth)
- Manual: when the server asks, type `/login PASSWORD` (or `/l PASSWORD`) in the bot's terminal.
- Automatic (needed for unattended reconnects): set the password once per PowerShell window before starting:
  `$env:SLICER_AUTH_PASSWORD = 'yourpassword'`
  The password is never written to the logs.

## Run
- `npm start` / `.\Start-Slicer.ps1` — logs in, equips the totem, then waits for an owner to say `!slicer start` or `!slicer once`.
- `npm run plan` / `.\Start-Slicer.ps1 -Plan` — prints the slicing coordinates (no Minecraft needed).
  - `node src/plan.js --row 2 --unit 1` — every portal in one unit
  - `node src/plan.js --csv plan.csv` — all 9000 portals to a spreadsheet

## What it does for each portal
All from one spot: 3 blocks east of the portal, at the configured stand position.
1. Fire charge on the inside face of the south frame obsidian → portal lights
2. Trapdoor A and B: clicks the east face of the portal, low on the face → bottom half, facing east
3. Redstone block between them → both trapdoors open
4. Mines the redstone block → checks both trapdoors are STILL open (suppression worked)
   - if they closed, it re-places and re-mines the redstone up to 2 more times, then pauses
5–6. Mines the south, then the north middle frame obsidian (only if step 4 was confirmed)
7. Mines both trapdoors
8. Checks a piece of portal is left, saves progress, moves 1 block east

Every step checks the world first, so after a disconnect it carries on where it stopped and never redoes a finished step. A portal whose frame is already sliced is skipped.

## Commands
In game: `!slicer` or `/msg Slicer !slicer ...` — replies are whispered to whoever asked.
- Anyone: `!slicer` / `!slicer status`, `!slicer inv`, `!slicer where`, `!slicer help`
- Owners:
  - `!slicer once` — slice ONE portal, then stop (use this for the first test)
  - `!slicer start` — slice continuously (also resumes automatically after a reconnect)
  - `!slicer pause` — stop before the next step; progress is saved
  - `!slicer restock` — go to the hub before the next portal
  - `!slicer skip` — (while paused) mark the current portal as done and move on
  - `!slicer jump ROW UNIT PORTAL` — (while paused) set the next portal, 1-based
  - `!slicer quit` — log off

In the terminal: the same commands without `!slicer` (e.g. `once`, `status`), plus `/login PASSWORD`, `say MESSAGE`, or any `/command`.

## Files it writes
- `data/state.json` — which portal and step it is on (saved after every step; resume point)
- `data/LOCKOUT` — exists after a totem pop or death; the bot refuses to log in until `npm run clear-lockout`
- `logs/bot.log` — everything
- `logs/TOTEM_POP_<time>.md` — what happened when the totem popped (damage, nearby entities, last log lines)
- `logs/last_disconnect.txt` — last disconnect reason + position in the job

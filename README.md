# Pixelled — Phase 4 delete me

A local 10-player campus RPG prototype using Python, FastAPI, WebSockets, and native
HTML Canvas. Requires Python 3.10 or newer. No frontend build needed.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python main.py
```

Open **http://localhost:8000** in two browser tabs. Enter a name, choose a
character, and click **Enter campus** in each tab. Use WASD or arrow keys; the white ground marker identifies your player.
Move in one tab and switch to the other to see the updated position. Both tabs
show the player count. Closing a tab removes that player and frees their place.
Switching tabs or windows releases movement keys. Click Reconnect after a
disconnect or when a full session has a free place again.

For another computer on the same LAN, open `http://SERVER_LAN_IP:8000` using the
host computer's LAN address. Allow port 8000 through the host firewall if needed.
This is an in-memory local development game: run **one server process / worker**.
Restarting the server clears the session. Do not open index.html as a local file.

## Player names and character selection

The join screen accepts a display name up to 20 characters and one of ten
outfits. You can choose a ponytail/skirt or short-hair/trousers style, four skin
tones, and four hair colors independently of the outfit. The default is the
yellow girl. A live preview supports **Turn** and **Walk / Stop** before joining.
The server shares the chosen appearance with everyone, and reconnecting from
the same tab preserves these choices. Names appear above
characters, in chat, and beside the active teacher's lecture. Names are labels;
players still have unique server-generated IDs, so matching names do not share
control. Names are rendered as text, not HTML.

A tab takes a place only after you click Enter campus. Full sessions show an
error and let you retry. Reconnect uses your previous name and character in that
tab, but puzzle progress still resets. Reloading the page shows the join form
again; there are no accounts or saved profiles.

`POST /join` accepts optional `name`, `character` (0–9), `skin` (0–3),
`hair` (0–3), and `style` (`short` or `ponytail`) query parameters.
Names containing control characters and out-of-range selections are rejected.
Profile data is tied to the single-use ticket and expires with its reservation.
Clients omitting these parameters receive a default Student name and slot color.
Restart an older running Python server before testing names and outfit selection.

## Campus graphics

The client draws pixel-art students with directional faces, selected hair and skin
colors, colored shirts, ID lanyards, and backpacks. Walking animates their arms
and feet; sitting keeps a stationary pose. A gold badge identifies the teacher,
and a white marker at the feet identifies your player. Characters draw in order
of their vertical position so nearer characters appear in front.

The campus includes textured floors and paving, wall windows, flowers, layered
trees, detailed computers and chairs, and a connected animated fountain.
Everything is drawn locally with Canvas; no image assets or external downloads
are needed to play. These visual details preserve the existing tile layout,
24-pixel collision body, and server-controlled interactions.

Nearby usable furniture gets a highlighted outline and an **E · Sit** or
**E · Code** prompt. Occupied furniture shows **In use**. The teacher sees
**E · Teach** at the podium. These cues use the same approach-from-below range
as server interactions. Prompts hide while a dialog is open. A location label
above the map identifies the courtyard, classroom, or computer lab.

The client interpolates walking positions over one server tick (40 ms) to reduce
visible stepping. It never predicts movement beyond the last received position.
Spawning, sitting, standing, and large position changes snap immediately, and
removed players are removed from the animation state as well. Collision and
interaction decisions remain on the server.

## Multiplayer behavior

- `GET /status`: online players, reserved places, available slots, and tick rate.
- `POST /join`: reserves one of 10 places for 15 seconds and returns a single-use
  WebSocket path. Full sessions return HTTP 409. Unused reservations expire.
- `/ws?token=...`: consumes the join ticket and assigns a server-generated ID.
  The `init` message supplies world dimensions, player size, and session limits.
- Clients send `{"type":"input","input":{"right":true}}` (up/down/left/right).
  Missing directions are false. Clients cannot set their own positions or IDs.
- The server moves players and broadcasts position, facing, color, and idle/walking
  state at 25 ticks per second. Diagonal speed is normalized. Player bodies stay
  on walkable campus tiles. Inputs expire after one second without a heartbeat.
- Each connection has a one-frame outgoing queue, so slow clients do not block
  everyone else's simulation. Disconnected players are removed.

## Campus map and collisions

The library/computer lab is at the top left, the classroom at the top right,
and the courtyard below. Enter either building through its two-tile opening
on the south wall. All ten spawn positions are on clear courtyard paths.

The map is defined in `main.py` by `build_campus()`. Each character is a 32-pixel
tile. The server sends this same map in the WebSocket `init` message, and the
client paints it with native Canvas shapes. No image downloads are needed.

| Tile | Meaning | Blocks movement |
| --- | --- | --- |
| `g` | Grass | No |
| `.` / `,` | Lab / classroom floor | No |
| `=` | Courtyard path or doorway | No |
| `#` | Wall | Yes |
| `P` | Computer desk | Yes |
| `S` | Bookshelf | Yes |
| `D` | Student desk | Yes |
| `L` | Lecture podium | Yes |
| `B` | Bench | Yes |
| `T` | Tree | Yes |
| `F` | Fountain | Yes |

`can_stand()` checks all tiles touched by the player's 24 × 24 pixel body.
`move_player()` splits movement into steps of at most four pixels and checks
horizontal and vertical movement separately. This prevents crossing obstacles
and allows sliding along walls. A fully blocked player reports `idle`; facing
still follows the attempted movement direction. The server enforces collisions;
clients only send directional input and render the resulting positions.

Movement is continuous, and players can still overlap each other on open ground.
Classroom desks, computer chairs, and courtyard benches support sitting.

## Pick and give lilies

Three white lilies grow along the lower courtyard. Walk close and press **F**
to pick one. Your character holds the flower visibly, and the HUD shows
**Lily: 1 / 1**. Walk within 48 pixels of another player and press **G** to give
it to them. The nearest player's name appears in the prompt. Both players
receive a message. If that player already holds a lily, the gift is declined
and you keep yours. Chat/blackboard typing does not activate these shortcuts.

Each lily has one server-owned holder. A player can hold only one at a time;
repeated presses cannot duplicate flowers. Walls block pickup/giving. Stand up
before picking; giving while seated is allowed. A held lily returns to its
original courtyard spot when its holder disconnects. There is no persistence
or growth timer. Existing contextual E pickup/giving remains available when
no furniture interaction takes priority; F/G are the dedicated shortcuts.

## Chairs and courtyard benches

Stand just below a chair or bench seat and press **E** to sit. Classroom and
computer desks have visible chairs; computer chairs still open their coding puzzle.
Each of the two courtyard benches has two independently reserved seats, for four
bench seats total. Bench sitters face outward and appear on the bench itself.

Press **E** again, **Esc** in the game, or **Stand up / End lecture** to leave a
bench or classroom chair. If an overlay is open, Esc closes it first and keeps
you seated. Movement is locked while seated; chat and the blackboard remain
available. Standing from a bench returns you to the clear tile immediately below
it. Occupied seats show a yellow indicator and cannot be claimed by another
player. Disconnecting releases the seat. Chairs are walkable floor decorations;
benches remain solid obstacles for walking players.

## Computer lab and puzzles

Enter the top-left building, stand just below a computer, and press **E**.
Your player sits facing its monitor and a puzzle dialog opens. Fill the blank
with an integer and click **Check answer** (or press Enter). Wrong answers show
hints; correct answers mark that terminal completed for your current connection.
Press **Escape** or click **Leave computer** to stand up.

The eight terminals rotate between three beginner tasks: loop bounds, list
indexing, and addition. Answers are checked against server-held values; user
code is never executed. These are fill-in-the-blank tasks, not a Python runner.
Completion is counted once per terminal and resets when you disconnect or the
server restarts. Reopening a completed terminal shows it as already solved.

A yellow monitor indicator and **IN USE** label identify occupied computers.
The server checks proximity below the keyboard and claims the terminal without
an intervening await, so two clients cannot claim it simultaneously. While
seated, movement inputs have no effect. Leaving clears movement input; a closed
or lost connection releases its terminal when the server removes that player.
A stale connection is detected through the WebSocket heartbeat/timeout, so a
network interruption may take a short time to release the terminal.

WebSocket actions are `interact`, `leave_terminal`, and
`submit_answer` with a string `answer`. The server chooses the nearby terminal;
clients cannot reserve one by supplying a remote terminal ID. Public snapshots
include terminal occupants and seated player state. Each connection receives
its own `you` object with puzzle text, feedback, and completion count. Answers
are not included in the puzzle payload.

## Campus chat and teacher lectures

Chat and the blackboard are hidden until opened, keeping the campus view clear.

| Key | Action |
| --- | --- |
| `/` | Open chat and focus the message box |
| `B` | Open/close the blackboard when not typing |
| `Esc` | Close the current overlay; in the game, leave the seat or podium |
| `E` | Interact with a computer, desk, or podium |

Opening an overlay releases held movement keys. Closing it returns keyboard
focus to the campus. While entering chat or notes, `/`, `B`, and movement keys
are ordinary text. Closing the blackboard keeps your seat or lecture active;
close it first, then press Esc again if you want to stand up/end the lecture.
Teacher notes and chat continue to synchronize while the overlays are hidden.


**Campus chat** reaches every connected player, including players outside the
classroom. Press **/** to open chat and focus the message box, then click
**Send message** or press Enter. Press **Esc** or click Close to return to the game. Typing in chat or the lecture editor does not move your character.
Messages carry the sender's server-assigned player ID and role. The server keeps
the latest 50 messages for this run and limits each player to two messages per
second, with a maximum of 240 characters per message. New arrivals receive the
current history. Text is rendered literally, including HTML-like strings.

To host a lecture:

1. Click **Become teacher**. Only one connected player can hold this role.
2. Enter the classroom through its courtyard doorway. The podium is the single
   wooden stand at the front (top) of the room. Approach it from below and press
   **E**. A gold marker distinguishes the teacher on the map.
3. The blackboard overlay opens automatically when you start at the podium.
   Write up to 600 characters / 10 lines in its lecture editor, then click
   **Publish notes**. Publishing replaces the shared board contents.
4. Click a published line on your blackboard to highlight it for everyone. Click
   it again to remove the highlight. Publishing new notes clears the highlight.
5. Close the overlay with **Esc** first. Back in the game, press **Esc**, press
   **E** again, or click **Stand up / End lecture** to end.
   Ending clears the board but retains your teacher role. **Give up teacher role**
   releases the role, or it is released automatically when you disconnect.

Students approach a classroom desk from below and press **E** to sit. Each desk
holds one player. Seated students cannot move until they press **E**, **Esc**, or
click **Stand up / End lecture**. Press **B** to toggle the blackboard overlay,
which displays the same notes and highlighted line on all clients; a compact preview also appears on
the classroom wall. Students can chat while seated. Notes are visible campus-wide,
so players can also follow without sitting down.

Roles are voluntary for this local game; there are no teacher accounts or
passwords. The server still enforces exclusive ownership and requires both the
teacher role and active podium use before accepting notes or highlights.
Player IDs, roles, desk occupancy, and lecturer state come from the server.
Leaving or disconnecting releases the occupied desk/podium. All chat, roles,
notes, puzzle progress, and player positions are in memory and reset on restart.

Additional WebSocket actions: `chat` with `text`, `claim_teacher`,
`release_teacher`, `publish_notes` with `text`, `highlight_line` with a zero-based
`line` (`-1` clears it), and `leave_activity`. Existing `interact` also handles
classroom desks and the podium. State snapshots include bounded `chat` history,
`desks` with occupants, and `lecture` with teacher ID, active lecturer ID, notes,
and highlighted line. Incoming WebSocket messages are capped at 4096 bytes.

## Verification

```bash
python -m unittest discover -s tests -v
```

The six map tests cover safe spawns, reachable walkable tiles, full-body collision,
wall sliding, large movement steps, room entrances, desks, and corner movement.
Two-tab Chromium checks also verified synchronized keyboard movement and wall
blocking, blur handling, disconnect cleanup, reconnect, and no JavaScript errors.
Phase 3 two-tab Chromium checks verified puzzle entry, wrong/correct answers,
seated movement blocking, occupied-terminal rejection, disconnect release,
second-player claiming, and Escape release, with no JavaScript errors.

Four additional terminal tests cover exclusive ownership, release, remote-use
rejection, answer feedback, personal completion, and valid seat positions.
Five classroom/chat tests also verify teacher exclusivity, podium authorization,
notes and highlight validation, desk ownership, disconnect cleanup, and bounded
chat with input validation and rate limiting. All **24 automated tests passed**, including two join-profile tests and three bench tests for independent
seat ownership, safe exit positions, disconnect release, and remote-use rejection.
Phase 4 two-tab Chromium checks used temporary classroom spawn positions to
exercise chat, typing isolation, literal HTML rendering, role claiming, podium
interaction, desk seating, notes/highlight synchronization, blocked unauthorized
publishing, Escape, and teacher disconnect/reassignment. The computer-lab
browser checks also passed again. Cross-device LAN play remains untested.

For a manual check, walk upward from the starting position into the lab wall,
then move right to its doorway and enter. Try walking into a computer desk.
Repeat in the classroom and view the same player from a second browser tab.

The original files are preserved in `backups/before-phase1/`.

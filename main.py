"""Pixelled Phase 4. Start one server process with: python main.py."""
import asyncio
from collections import deque
from contextlib import asynccontextmanager, suppress
import json
import math
from pathlib import Path
import secrets
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse

MAX_PLAYERS = 10
TICK_RATE = 25
WIDTH, HEIGHT = 800, 576
TILE_SIZE = 32
PLAYER_SIZE = 24
SPEED = 160  # Pixels per second; positions are calculated only by the server.
JOIN_TIMEOUT = 15
INPUT_TIMEOUT = 1.0
COLORS = ['#f4ce58', '#78bfff', '#ffcc77', '#eb91c8', '#a99aff',
          '#66d9cc', '#fa9380', '#d3db83', '#d6b297', '#b6c8e0']

# These stores belong to one asyncio event loop. Admission and removal contain
# no awaits, so capacity checks cannot interleave with another request.
players = {}
reservations = {}
join_profiles = {}
chat = deque(maxlen=50)
lecture = {'notes': '', 'highlight': -1}
chat_sequence = 0


def build_campus():
    """One map is used for both server collision and client drawing."""
    tiles = [['g'] * (WIDTH // TILE_SIZE) for _ in range(HEIGHT // TILE_SIZE)]
    for row in range(18):
        for col in range(25):
            if row in (0, 17) or col in (0, 24):
                tiles[row][col] = '#'
    # Two buildings, each with a two-tile entrance facing the courtyard.
    for left, right, floor in ((1, 11, '.'), (13, 23, ',')):
        for row in range(1, 10):
            for col in range(left, right + 1):
                tiles[row][col] = '#' if row in (1, 9) or col in (left, right) else floor
    for col in (5, 6, 18, 19):
        tiles[9][col] = '='
    for row in (10, 11, 16):
        for col in range(1, 24):
            tiles[row][col] = '='
    for row in range(10, 17):
        for col in (5, 6, 18, 19):
            tiles[row][col] = '='
    for col in (3, 5, 7, 9):
        tiles[4][col] = 'P'  # Computer desks.
        tiles[7][col] = 'P'
    for col in (3, 4, 8, 9):
        tiles[2][col] = 'S'  # Library bookshelves.
    for row in (5, 7):
        for col in (15, 17, 19, 21):
            tiles[row][col] = 'D'  # Student desks.
    tiles[3][18] = 'L'  # Lecture podium.
    for row, col in ((13, 3), (13, 4), (13, 20), (13, 21)):
        tiles[row][col] = 'B'
    for row, col in ((12, 1), (15, 2), (12, 23), (15, 22), (14, 8), (14, 16)):
        tiles[row][col] = 'T'
    for row in (13, 14):
        for col in (11, 12, 13):
            tiles[row][col] = 'F'
    return [''.join(row) for row in tiles]


CAMPUS = build_campus()
SOLID_TILES = '#PDSLBTF'
SPAWNS = [((col + .5) * TILE_SIZE, (row + .5) * TILE_SIZE)
          for row in (11, 16) for col in (4, 8, 12, 16, 20)]


TERMINALS = [{'id': f'pc-{col}-{row}', 'x': col * 32 + 16, 'y': row * 32 + 16}
             for row, line in enumerate(CAMPUS) for col, tile in enumerate(line) if tile == 'P']
DESKS = [{'id': f'desk-{col}-{row}', 'x': col * 32 + 16, 'y': row * 32 + 16}
         for row, line in enumerate(CAMPUS) for col, tile in enumerate(line) if tile == 'D']
BENCHES = [{'id': f'bench-{col}-{row}', 'x': col * 32 + 16, 'y': row * 32 + 16}
           for row, line in enumerate(CAMPUS) for col, tile in enumerate(line) if tile == 'B']
PODIUM = {'x': 592, 'y': 112}
LILIES = [
    {'id': 'lily-1', 'x': 144, 'y': 496},
    {'id': 'lily-2', 'x': 208, 'y': 496},
    {'id': 'lily-3', 'x': 272, 'y': 496},
]


def teacher_id():
    return next((p['id'] for p in players.values() if p.get('role') == 'teacher'), None)


def lecturer_id():
    return next((p['id'] for p in players.values() if p['state'] == 'lecturing'), None)


def near_front(player, item):
    return abs(player['x'] - item['x']) <= 20 and 28 <= player['y'] - item['y'] <= 56


def near_item(player, item):
    if math.hypot(player['x'] - item['x'], player['y'] - item['y']) > 48:
        return False
    # A nearby object across a wall is not reachable.
    for step in range(9):
        x = player['x'] + (item['x'] - player['x']) * step / 8
        y = player['y'] + (item['y'] - player['y']) * step / 8
        if CAMPUS[int(y // TILE_SIZE)][int(x // TILE_SIZE)] == '#':
            return False
    return True


def nearest_recipient(player):
    nearby = [p for p in players.values() if p['id'] != player['id'] and near_item(player, p)]
    return min(nearby, key=lambda p: (math.hypot(p['x'] - player['x'], p['y'] - player['y']), p['id']), default=None)


def flower_action(player, action):
    if action == 'pick_lily':
        if player['state'] in ('seated', 'lecturing'):
            player['feedback'] = 'Stand up before picking a lily.'
        elif held_lily(player):
            player['feedback'] = 'You already have a lily. Give it to someone first.'
        else:
            available = [l for l in LILIES if not lily_holder(l['id']) and near_item(player, l)]
            lily = min(available, key=lambda l: math.hypot(l['x'] - player['x'], l['y'] - player['y']), default=None)
            if not lily:
                player['feedback'] = 'Walk closer to a courtyard lily and press F.'
            else:
                player['lily_id'] = lily['id']
                player['feedback'] = 'You picked up a lily! Go near a player and press G to give it.'
    elif action == 'give_lily':
        held = held_lily(player)
        recipient = nearest_recipient(player)
        if not held:
            player['feedback'] = 'Pick a lily first with F.'
        elif not recipient:
            player['feedback'] = 'Move closer to the player you want to give your lily to.'
        elif recipient.get('lily_id'):
            player['feedback'] = f"{recipient.get('name', recipient['id'])} is already holding a lily."
        else:
            recipient['lily_id'] = held['id']
            player['lily_id'] = None
            player['feedback'] = f"You gave a lily to {recipient.get('name', recipient['id'])}."
            recipient['feedback'] = f"{player.get('name', player['id'])} gave you a lily!"


def lily_holder(lily_id):
    return next((player['id'] for player in players.values() if player.get('lily_id') == lily_id), None)


def held_lily(player):
    lily_id = player.get('lily_id')
    return next((lily for lily in LILIES if lily['id'] == lily_id), None) if lily_id else None


def leave_activity(player):
    if player['state'] == 'lecturing':
        lecture.update(notes='', highlight=-1)
    if player.get('bench_id'):
        bench = next(b for b in BENCHES if b['id'] == player['bench_id'])
        player['x'], player['y'] = bench['x'], bench['y'] + 32
    player['bench_id'] = None
    player['desk_id'] = None
    release_terminal(player)


def remove_player(player_id):
    player = players.pop(player_id, None)
    if player and player['state'] == 'lecturing':
        lecture.update(notes='', highlight=-1)


def classroom_action(player, message):
    """Server-owned role, podium and desk checks; called without awaits."""
    global chat_sequence
    action = message.get('type')
    if action == 'chat':
        text = message.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 240:
            player['feedback'] = 'Chat messages must contain 1–240 characters.'
        elif time.monotonic() - player.get('last_chat', -10) < .5:
            player['feedback'] = 'Wait a moment before sending another message.'
        else:
            chat_sequence += 1
            chat.append({'id': chat_sequence, 'player_id': player['id'], 'name': player.get('name', player['id']),
                         'role': player.get('role', 'student'), 'text': text.strip()})
            player['last_chat'] = time.monotonic()
            player['feedback'] = ''
    elif action == 'claim_teacher':
        if teacher_id() and teacher_id() != player['id']:
            player['feedback'] = 'Another player is already the teacher.'
        else:
            player['role'] = 'teacher'
            player['feedback'] = 'You are the teacher. Stand below the classroom podium and press E.'
    elif action == 'release_teacher':
        if player.get('role') == 'teacher':
            leave_activity(player)
            player['role'] = 'student'
    elif action == 'leave_activity':
        leave_activity(player)
    elif action == 'publish_notes':
        if player.get('role') != 'teacher' or player['state'] != 'lecturing' or not near_front(player, PODIUM):
            player['feedback'] = 'Only the teacher at the podium can publish notes.'
        else:
            notes = message.get('text')
            if not isinstance(notes, str) or not notes.strip() or len(notes) > 600 or len(notes.splitlines()) > 10:
                player['feedback'] = 'Use 1–600 characters and at most 10 lines.'
            else:
                lecture.update(notes=notes.strip(), highlight=-1)
                player['feedback'] = 'Lecture notes published.'
    elif action == 'highlight_line':
        line = message.get('line')
        if player.get('role') == 'teacher' and player['state'] == 'lecturing' and near_front(player, PODIUM):
            if type(line) is int and -1 <= line < len(lecture['notes'].splitlines()):
                lecture['highlight'] = line
    elif action == 'interact':
        if player['state'] in ('seated', 'lecturing'):
            leave_activity(player)
        elif near_front(player, PODIUM):
            if player.get('role') != 'teacher':
                player['feedback'] = 'Choose Become teacher before using the podium.'
            else:
                player.update(x=PODIUM['x'], y=PODIUM['y'] + 32, state='lecturing', facing='up', input={}, feedback='')
                lecture.update(notes='', highlight=-1)
        else:
            desk = next((d for d in DESKS if near_front(player, d)), None)
            if not desk:
                bench = next((b for b in BENCHES if near_front(player, b)), None)
                if not bench:
                    return False  # Let the computer-lab interaction handle it.
                if any(p.get('bench_id') == bench['id'] for p in players.values()):
                    player['feedback'] = 'That bench seat is occupied. Try the next seat.'
                else:
                    player.update(bench_id=bench['id'], x=bench['x'], y=bench['y'],
                                  state='seated', facing='down', input={},
                                  feedback='Relaxing on the bench. Press E or Esc to stand up.')
                return True
            if any(p.get('desk_id') == desk['id'] for p in players.values()):
                player['feedback'] = 'That classroom desk is occupied.'
            else:
                player.update(desk_id=desk['id'], x=desk['x'], y=desk['y'] + 32,
                              state='seated', facing='up', input={}, feedback='Seated in class. Follow the shared blackboard below.')
    else:
        return False
    return True

PUZZLES = [
    {'title': 'Fix the loop', 'prompt': 'Print the numbers 1, 2, and 3. Fill in the missing integer.',
     'code': 'for number in range(1, ____):\n    print(number)', 'answer': '4',
     'hint': 'range stops before its second argument.', 'explanation': 'Correct! range(1, 4) produces 1, 2, 3.'},
    {'title': 'List indexing', 'prompt': 'Print "Python". Fill in the missing integer.',
     'code': 'languages = ["Java", "Python", "PHP"]\nprint(languages[____])', 'answer': '1',
     'hint': 'Python list indexes start at zero.', 'explanation': 'Correct! Index 1 selects the second item: Python.'},
    {'title': 'Add to the total', 'prompt': 'Make the final total equal 10. Fill in the missing integer.',
     'code': 'total = 6\ntotal += ____\nprint(total)', 'answer': '4',
     'hint': 'What number added to 6 makes 10?', 'explanation': 'Correct! 6 + 4 = 10.'},
]


def terminal_owner(terminal_id):
    return next((p['id'] for p in players.values() if p.get('terminal_id') == terminal_id), None)


def release_terminal(player):
    player['terminal_id'] = None
    player['state'] = 'idle'
    player['input'] = {}
    player['feedback'] = ''


def handle_action(player, message):
    """No awaits: checking a terminal and claiming it is one atomic operation."""
    action = message.get('type')
    if action in ('pick_lily', 'give_lily'):
        flower_action(player, action)
        return
    if classroom_action(player, message):
        return
    if action == 'leave_terminal':
        leave_activity(player)
    elif action == 'interact':
        if player['state'] in ('seated', 'lecturing'):
            leave_activity(player)
            return
        if held_lily(player) and nearest_recipient(player):
            flower_action(player, 'give_lily')
            return
        if not held_lily(player) and any(not lily_holder(l['id']) and near_item(player, l) for l in LILIES):
            flower_action(player, 'pick_lily')
            return
        if player['terminal_id']:
            return
        # Approach the keyboard from below. This also prevents use through walls.
        nearby = [terminal for terminal in TERMINALS if abs(player['x'] - terminal['x']) <= 20
              and 28 <= player['y'] - terminal['y'] <= 56]
        if not nearby:
            player['feedback'] = 'Stand below a computer, chair, bench, or podium and press E.'
            return
        terminal = min(nearby, key=lambda t: abs(player['x'] - t['x']))
        if terminal_owner(terminal['id']):
            player['feedback'] = 'That computer is in use. Try another terminal.'
            return
        player['terminal_id'] = terminal['id']
        player['x'], player['y'] = terminal['x'], terminal['y'] + 32
        player['state'], player['facing'] = 'seated', 'up'
        player['input'] = {}
        player['feedback'] = ''
    elif action == 'submit_answer' and player['terminal_id']:
        terminal_id = player['terminal_id']
        puzzle = PUZZLES[next(i for i, t in enumerate(TERMINALS) if t['id'] == terminal_id) % len(PUZZLES)]
        answer = message.get('answer')
        if not isinstance(answer, str) or len(answer) > 40:
            player['feedback'] = 'Enter a short integer answer.'
        elif terminal_id in player['solved']:
            player['feedback'] = 'You already solved this terminal during this session.'
        elif answer.strip() == puzzle['answer']:
            player['solved'].add(terminal_id)
            player['feedback'] = puzzle['explanation']
        else:
            player['feedback'] = 'Try again. ' + puzzle['hint']


def private_state(player):
    terminal_id = player['terminal_id']
    puzzle = None
    if terminal_id:
        task = PUZZLES[next(i for i, t in enumerate(TERMINALS) if t['id'] == terminal_id) % len(PUZZLES)]
        puzzle = {key: task[key] for key in ('title', 'prompt', 'code')}
    return {'terminal_id': terminal_id, 'puzzle': puzzle, 'feedback': player['feedback'],
            'solved': terminal_id in player['solved'], 'completed': len(player['solved']), 'role': player.get('role', 'student'),
            'desk_id': player.get('desk_id'), 'bench_id': player.get('bench_id'), 'lily_id': player.get('lily_id')}


def can_stand(x, y):
    """Check the entire square player body, not just its center tile."""
    half = PLAYER_SIZE / 2
    if x - half < 0 or y - half < 0 or x + half > WIDTH or y + half > HEIGHT:
        return False
    left, right = int((x - half) // TILE_SIZE), math.ceil((x + half) / TILE_SIZE) - 1
    top, bottom = int((y - half) // TILE_SIZE), math.ceil((y + half) / TILE_SIZE) - 1
    return all(CAMPUS[row][col] not in SOLID_TILES
               for row in range(top, bottom + 1) for col in range(left, right + 1))


def move_player(player, dx, dy):
    # Small substeps prevent tunneling. Separate axes let players slide along
    # a wall when holding a diagonal direction, without cutting its corner.
    steps = max(1, math.ceil(max(abs(dx), abs(dy)) / 4))
    for _ in range(steps):
        if can_stand(player['x'] + dx / steps, player['y']):
            player['x'] += dx / steps
        if can_stand(player['x'], player['y'] + dy / steps):
            player['y'] += dy / steps


def expire_reservations():
    now = time.monotonic()
    for token, deadline in list(reservations.items()):
        if deadline <= now:
            del reservations[token]
            join_profiles.pop(token, None)


def snapshot():
    fields = ('id', 'name', 'x', 'y', 'facing', 'state', 'color', 'terminal_id', 'role', 'desk_id', 'bench_id', 'lily_id')
    return {'type': 'state', 'players': [
        dict({key: player[key] for key in fields}, appearance=player.get('appearance')) for player in players.values()
    ], 'terminals': [dict(t, occupant=terminal_owner(t['id'])) for t in TERMINALS],
        'lilies': [dict(lily, holder=lily_holder(lily['id'])) for lily in LILIES],
        'desks': [dict(d, occupant=next((p['id'] for p in players.values() if p.get('desk_id') == d['id']), None)) for d in DESKS],
        'benches': [dict(b, occupant=next((p['id'] for p in players.values() if p.get('bench_id') == b['id']), None)) for b in BENCHES],
        'lecture': dict(lecture, teacher_id=teacher_id(), active=lecturer_id()), 'chat': list(chat)}


async def tick_loop():
    interval = 1 / TICK_RATE
    while True:
        started = time.monotonic()
        expire_reservations()
        for player in players.values():
            if player['state'] in ('seated', 'lecturing'):
                continue
            keys = player['input'] if started - player['last_input'] < INPUT_TIMEOUT else {}
            dx = int(keys.get('right', False)) - int(keys.get('left', False))
            dy = int(keys.get('down', False)) - int(keys.get('up', False))
            old_x, old_y = player['x'], player['y']
            if dx or dy:
                distance = SPEED * interval / math.hypot(dx, dy)
                move_player(player, dx * distance, dy * distance)
                player['facing'] = ('down' if dy > 0 else 'up') if dy else ('right' if dx > 0 else 'left')
            player['state'] = 'walking' if (old_x, old_y) != (player['x'], player['y']) else 'idle'
        message = snapshot()
        for player in players.values():
            # Retain only the latest snapshot for slow clients.
            queue = player['queue']
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)
        await asyncio.sleep(max(0, interval - (time.monotonic() - started)))


@asynccontextmanager
async def lifespan(app):
    loop = asyncio.create_task(tick_loop())
    try:
        yield
    finally:
        loop.cancel()
        with suppress(asyncio.CancelledError):
            await loop
        players.clear()
        reservations.clear()
        join_profiles.clear()
        chat.clear()
        lecture.update(notes='', highlight=-1)


app = FastAPI(title='Pixelled — Phase 4', lifespan=lifespan)


@app.get('/')
async def index():
    return FileResponse(Path(__file__).with_name('index.html'))


@app.get('/status')
async def status():
    expire_reservations()
    return {'status': 'ok', 'players': len(players), 'reserved': len(reservations),
            'max_players': MAX_PLAYERS, 'available_slots': MAX_PLAYERS - len(players) - len(reservations),
            'tick_rate': TICK_RATE}


@app.post('/join')
async def join(name: str = Query(default='', max_length=20),
               character: int | None = Query(default=None, ge=0, le=9),
               skin: int | None = Query(default=None, ge=0, le=3),
               hair: int | None = Query(default=None, ge=0, le=3),
               style: str | None = Query(default=None, pattern='^(short|ponytail)$')):
    if any(not char.isprintable() for char in name):
        raise HTTPException(422, 'Use a name without control characters.')
    name = ' '.join(name.split())
    expire_reservations()
    if len(players) + len(reservations) >= MAX_PLAYERS:
        raise HTTPException(409, 'Session full. All 10 places are occupied or reserved.')
    token = secrets.token_urlsafe(24)
    reservations[token] = time.monotonic() + JOIN_TIMEOUT
    join_profiles[token] = {'name': name, 'character': character, 'skin': skin, 'hair': hair, 'style': style}
    return {'ws_path': f'/ws?token={token}', 'expires_in': JOIN_TIMEOUT}


async def send_states(websocket, player):
    try:
        while True:
            message = await player['queue'].get()
            await asyncio.wait_for(websocket.send_json(dict(message, you=private_state(player))), timeout=2)
    except (TimeoutError, RuntimeError, WebSocketDisconnect, OSError):
        remove_player(player['id'])
        with suppress(RuntimeError, OSError):
            await websocket.close(code=1011, reason='Connection too slow or lost')


@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    expire_reservations()
    token = websocket.query_params.get('token', '')
    if token not in reservations:
        await websocket.close(code=1008, reason='Join through POST /join first; ticket may have expired')
        return
    del reservations[token]
    profile = join_profiles.pop(token, {'name': '', 'character': None})
    slot = next(slot for slot in range(MAX_PLAYERS)
                if all(player['slot'] != slot for player in players.values()))
    player_id = secrets.token_hex(4)
    spawn_x, spawn_y = SPAWNS[slot]
    choice = slot if profile['character'] is None else profile['character']
    seed = int(player_id[:6], 16)
    appearance = {'skin': profile.get('skin') if profile.get('skin') is not None else seed % 4,
                  'hair': profile.get('hair') if profile.get('hair') is not None else (seed // 4) % 4,
                  'style': profile.get('style') or ('ponytail' if choice == 0 else 'short')}
    player = {'id': player_id, 'name': profile['name'] or f'Student {slot + 1}', 'slot': slot, 'x': spawn_x,
              'y': spawn_y, 'facing': 'down', 'state': 'idle',
              'color': COLORS[choice], 'appearance': appearance, 'input': {}, 'last_input': time.monotonic(),
              'queue': asyncio.Queue(maxsize=1), 'terminal_id': None, 'solved': set(), 'feedback': '',
              'role': 'student', 'desk_id': None, 'bench_id': None, 'lily_id': None}
    players[player_id] = player
    sender = None
    try:
        await asyncio.wait_for(websocket.send_json({
            'type': 'init', 'id': player_id, 'name': player['name'], 'width': WIDTH, 'height': HEIGHT,
            'player_size': PLAYER_SIZE, 'tick_rate': TICK_RATE, 'max_players': MAX_PLAYERS,
            'map': {'tiles': CAMPUS, 'tile_size': TILE_SIZE, 'solid_tiles': SOLID_TILES},
        }), timeout=2)
        sender = asyncio.create_task(send_states(websocket, player))
        while True:
            raw = await websocket.receive_text()
            if len(raw) > 4096:
                await websocket.close(code=1009, reason='Input message too large')
                break
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            if message.get('type') != 'input':
                handle_action(player, message)
                continue
            keys = message.get('input')
            if not isinstance(keys, dict):
                continue
            player['input'] = {key: keys.get(key) is True for key in ('up', 'down', 'left', 'right')}
            player['last_input'] = time.monotonic()
    except (WebSocketDisconnect, RuntimeError, OSError, TimeoutError, KeyError):
        pass
    finally:
        remove_player(player_id)
        if sender:
            sender.cancel()
            with suppress(asyncio.CancelledError):
                await sender


if __name__ == '__main__':
    import uvicorn
    # Single worker is required for this in-memory session. Also accepts LAN clients.
    uvicorn.run(app, host='0.0.0.0', port=8000, ws_max_size=4096)

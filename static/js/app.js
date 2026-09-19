const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusLabel = document.getElementById('status');
const count = document.getElementById('count');
const reconnect = document.getElementById('reconnect');
const joinDialog = document.getElementById('joinDialog');
const joinButton = document.getElementById('joinButton');
const joinError = document.getElementById('joinError');
let connecting = false;
let identity = null;
joinDialog.addEventListener('cancel', event => event.preventDefault());
document.getElementById('joinForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = document.getElementById('playerName').value.trim();
  if (!name) { joinError.textContent = 'Please enter your name.'; return; }
  identity = {name, character: document.getElementById('characterChoice').value,
    skin: document.getElementById('skinChoice').value, hair: document.getElementById('hairChoice').value,
    style: document.getElementById('styleChoice').value};
  connect();
});
const pressed = new Set();
const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
let socket = null;
let myId = null;
let players = [];
let motion = new Map();
let frameInterval = 40;
function renderedPlayers(now) {
  return players.map(player => {
    const track = motion.get(player.id);
    if (!track) return player;
    const progress = Math.min(1, Math.max(0, (now - track.time) / frameInterval));
    return {...player, x: track.x + (player.x - track.x) * progress,
      y: track.y + (player.y - track.y) * progress};
  });
}
function receivePlayers(incoming) {
  const now = performance.now();
  const previous = new Map(renderedPlayers(now).map(p => [p.id, p]));
  motion = new Map(incoming.map(player => {
    const old = previous.get(player.id);
    // Snap interactions and spawns; only interpolate ordinary walking.
    const smooth = old && old.state !== 'seated' && player.state !== 'seated'
      && old.state !== 'lecturing' && player.state !== 'lecturing'
      && Math.hypot(player.x - old.x, player.y - old.y) < 40;
    return [player.id, {x: smooth ? old.x : player.x, y: smooth ? old.y : player.y, time: now}];
  }));
  players = incoming;
}
let playerSize = 24;
let maxPlayers = 10;
const mapCanvas = document.createElement('canvas');
let campus = null;
let terminals = [];
let completedTerminals = new Set();
let journalVersion = '';
function updateJournal(you = null) {
  completedTerminals = new Set(you?.completed_terminals || []);
  const total = terminals.length || 8;
  const completed = you?.completed || 0;
  const version = JSON.stringify([myId, you?.terminal_id, completed, [...completedTerminals], terminals.map(t => [t.id, t.occupant])]);
  if (version === journalVersion) return;
  journalVersion = version;
  document.getElementById('journalCount').textContent = `${completed} / ${total} solved`;
  const progress = document.getElementById('labProgress');
  progress.max = total;
  progress.value = completed;
  const list = document.getElementById('labChecklist');
  list.replaceChildren();
  terminals.forEach((terminal, index) => {
    const item = document.createElement('li');
    const done = completedTerminals.has(terminal.id);
    const state = done ? 'Solved ✓' : terminal.occupant === myId ? 'You are here' : terminal.occupant ? 'In use' : 'Ready';
    item.textContent = `Computer ${index + 1} · ${state}`;
    item.classList.toggle('is-complete', done);
    list.append(item);
  });
  const next = terminals.findIndex(t => !completedTerminals.has(t.id) && (!t.occupant || t.occupant === myId));
  const goal = !you ? 'Join campus to start your lab challenges.'
    : !Array.isArray(you.completed_terminals) ? 'Restart the Python server to enable the personal checklist.'
    : completed === total ? 'All lab puzzles solved! Take a break in the courtyard or help a classmate.'
    : next < 0 ? 'The remaining computers are in use. Explore campus while you wait.'
    : `Next challenge: Computer ${next + 1} in the upper-left lab. Approach from below and interact.`;
  const label = document.getElementById('labGoal');
  if (label.textContent !== goal) label.textContent = goal;
}
let lilies = [];
let activeTerminal = null;
let desks = [];
let benches = [];
let lecture = {notes: '', highlight: -1, teacher_id: null, active: null};
let boardVersion = '';
const speechBubbles = new Map();
let lastChatId = null;
const openChat = document.getElementById('openChat');
const openBoard = document.getElementById('openBoard');
openChat.addEventListener('click', focusChat);
openBoard.addEventListener('click', () => togglePopup(boardDialog));
document.querySelectorAll('input[name="outfit"]').forEach(radio => {
  radio.addEventListener('change', () => { document.getElementById('characterChoice').value = radio.value; });
});
const chatText = document.getElementById('chatText');
const boardDialog = document.getElementById('boardDialog');
function focusChat() {
  if (dialog.open || joinDialog.open || boardDialog.open || !myId) return;
  clearInput();
  chatText.focus();
}
chatText.addEventListener('focus', clearInput);
function returnToGame() {
  clearInput();
  canvas.focus({preventScroll: true});
}
function closePopup(popup) {
  popup.close();
  returnToGame();
}
function togglePopup(popup) {
  if (dialog.open || !myId) return;
  if (popup.open) { closePopup(popup); return; }
  clearInput();
  popup.showModal();
}
boardDialog.addEventListener('cancel', event => { event.preventDefault(); closePopup(boardDialog); });
document.getElementById('closeBoard').addEventListener('click', () => closePopup(boardDialog));
canvas.addEventListener('click', () => canvas.focus({preventScroll: true}));
const teacherRole = document.getElementById('teacherRole');
const leaveActivity = document.getElementById('leaveActivity');
const lectureForm = document.getElementById('lectureForm');
teacherRole.addEventListener('click', () => {
  clearInput(); action(lecture.teacher_id === myId ? 'release_teacher' : 'claim_teacher');
});
leaveActivity.addEventListener('click', () => { clearInput(); action('leave_activity'); });
document.getElementById('chatForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!myId || socket?.readyState !== WebSocket.OPEN || !chatText.value.trim()) return;
  action('chat', {text: chatText.value});
  chatText.value = '';
  returnToGame();
});
lectureForm.addEventListener('submit', event => {
  event.preventDefault(); action('publish_notes', {text: document.getElementById('notes').value});
});
document.addEventListener('focusin', event => {
  if (event.target.matches('input, textarea, button, select, summary')) clearInput();
});
function updateClassroom(message) {
  desks = message.desks;
  // An older running server may serve this new HTML before it is restarted.
  benches = Array.isArray(message.benches) ? message.benches : [];
  lecture = message.lecture;
  const me = players.find(p => p.id === myId);
  const teaching = lecture.active === myId;
  teacherRole.disabled = Boolean(lecture.teacher_id && lecture.teacher_id !== myId);
  teacherRole.textContent = lecture.teacher_id === myId ? 'Give up teacher role' : 'Become teacher';
  document.getElementById('roleLabel').textContent = message.you.role === 'teacher' ? 'Teacher' : 'Student';
  leaveActivity.hidden = !me || !['seated', 'lecturing'].includes(me.state);
  if (teaching && lectureForm.hidden) {
    document.getElementById('notes').value = lecture.notes;
    if (!boardDialog.open) togglePopup(boardDialog);
  }
  lectureForm.hidden = !teaching;
  document.getElementById('sendChat').disabled = false;
  document.getElementById('lectureStatus').textContent = lecture.active
    ? `Teacher ${players.find(p => p.id === lecture.teacher_id)?.name || lecture.teacher_id} · ${players.filter(p => p.desk_id).length} students seated`
    : (lecture.teacher_id ? 'Teacher ready. Go to the podium and press E to start.' : 'No teacher yet. Choose Become teacher to host a lecture.');
  const version = JSON.stringify([lecture, teaching]);
  if (version !== boardVersion) {
    boardVersion = version;
    const board = document.getElementById('blackboard');
    board.replaceChildren();
    if (!lecture.notes) board.textContent = lecture.active ? 'Lecture started. Waiting for notes…' : 'Waiting for the teacher.';
    else lecture.notes.split('\n').forEach((line, index) => {
      const element = document.createElement(teaching ? 'button' : 'div');
      element.className = 'board-line' + (lecture.highlight === index ? ' highlight' : '');
      element.textContent = line || ' ';
      if (teaching) {
        element.type = 'button';
        element.setAttribute('aria-pressed', String(lecture.highlight === index));
        element.addEventListener('click', () => action('highlight_line', {line: lecture.highlight === index ? -1 : index}));
      }
      board.append(element);
    });
  }
  receiveSpeech(message.chat);

}
const dialog = document.getElementById('puzzleDialog');
const answer = document.getElementById('answer');
const hint = document.getElementById('hint');
function action(type, extra = {}) {
  if (socket?.readyState === WebSocket.OPEN && myId) socket.send(JSON.stringify({type, ...extra}));
}
function updateLab(you) {
  updateJournal(you);
  if (you.terminal_id && you.puzzle) {
    if (activeTerminal !== you.terminal_id) {
      activeTerminal = you.terminal_id;
      clearInput();
      answer.value = '';
      answer.disabled = false;
      document.getElementById('puzzleTitle').textContent = you.puzzle.title;
      document.getElementById('puzzlePrompt').textContent = you.puzzle.prompt;
      document.getElementById('puzzleCode').textContent = you.puzzle.code;
      if (!dialog.open) dialog.showModal();
      answer.focus();
    }
    answer.disabled = you.solved;
    document.getElementById('checkAnswer').disabled = you.solved;
    document.getElementById('feedback').textContent = you.feedback;
  } else {
    activeTerminal = null;
    if (dialog.open) { dialog.close(); clearInput(); }
  }
  const me = players.find(p => p.id === myId);
  document.getElementById('flowerCount').textContent = `Lily: ${you.lily_id ? 1 : 0} / 1`;
  document.getElementById('puzzleProgress').textContent = `Puzzles: ${you.completed} / ${terminals.length || 8}`;
  const target = interactionTarget();
  const prompt = me && ['seated', 'lecturing'].includes(me.state)
    ? (me.state === 'lecturing' ? 'B · Open blackboard · E / Esc · End lecture' : 'E / Esc · Stand up')
    : target ? (target.occupant ? 'In use · Try another seat or computer' : target.label)
    : you.lily_id ? 'G · Give your lily when near another player' : 'Explore campus · Approach a computer, chair, or flower';
  hint.textContent = you.feedback || prompt;
}
document.getElementById('answerForm').addEventListener('submit', event => {
  event.preventDefault(); action('submit_answer', {answer: answer.value});
});
document.getElementById('leaveTerminal').addEventListener('click', () => action('leave_terminal'));
dialog.addEventListener('cancel', event => { event.preventDefault(); action('leave_terminal'); });

const touchControls = document.getElementById('touchControls');
const toggleTouchControls = document.getElementById('toggleTouchControls');
const touchPointers = new Map();
const directionButtons = [...touchControls.querySelectorAll('[data-direction]')];
function refreshTouchDirections() {
  for (const button of directionButtons) {
    button.classList.toggle('is-held', [...touchPointers.values()].includes(button.dataset.direction));
  }
}
function setTouchVisibility(visible) {
  clearInput();
  touchControls.hidden = !visible;
  toggleTouchControls.setAttribute('aria-expanded', String(visible));
  toggleTouchControls.textContent = `${visible ? 'Hide' : 'Show'} on-screen controls`;
}
function setTouchEnabled(enabled) {
  touchControls.querySelectorAll('button').forEach(button => { button.disabled = !enabled; });
}
toggleTouchControls.addEventListener('click', () => setTouchVisibility(touchControls.hidden));
for (const button of directionButtons) {
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || button.disabled || !myId || dialog.open || boardDialog.open || joinDialog.open) return;
    event.preventDefault();
    canvas.focus({preventScroll: true});
    button.setPointerCapture(event.pointerId);
    touchPointers.set(event.pointerId, button.dataset.direction);
    refreshTouchDirections();
    sendInput();
  });
  const release = event => {
    if (!touchPointers.delete(event.pointerId)) return;
    refreshTouchDirections();
    sendInput();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
  button.addEventListener('contextmenu', event => event.preventDefault());
}
touchControls.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => {
    if (!myId || dialog.open || boardDialog.open || joinDialog.open) return;
    returnToGame();
    action(button.dataset.action);
  });
});

function sendInput() {
  if (socket?.readyState !== WebSocket.OPEN || !myId) return;
  const touching = new Set(touchPointers.values());
  socket.send(JSON.stringify({type: 'input', input: {
    up: pressed.has('KeyW') || pressed.has('ArrowUp') || touching.has('up'),
    down: pressed.has('KeyS') || pressed.has('ArrowDown') || touching.has('down'),
    left: pressed.has('KeyA') || pressed.has('ArrowLeft') || touching.has('left'),
    right: pressed.has('KeyD') || pressed.has('ArrowRight') || touching.has('right')
  }}));
}
function clearInput() {
  pressed.clear();
  touchPointers.clear();
  refreshTouchDirections();
  sendInput();
}
setTouchVisibility(window.matchMedia('(any-pointer: coarse)').matches);

async function connect() {
  if (connecting || !identity) return;
  connecting = true;
  joinButton.disabled = true;
  joinError.textContent = '';
  reconnect.hidden = true;
  reconnect.disabled = true;
  myId = null;
  players = [];
  motion.clear();
  clearInput();
  setTouchEnabled(false);
  statusLabel.textContent = 'Joining the local session…';
  try {
    if (!['http:', 'https:'].includes(location.protocol)) {
      throw new Error('Start main.py and open http://localhost:8000 to play.');
    }
    const response = await fetch('/join?' + new URLSearchParams(identity), {method: 'POST', signal: AbortSignal.timeout(5000)});
    const ticket = await response.json();
    if (!response.ok) throw new Error(typeof ticket.detail === 'string' ? ticket.detail : 'Check your name and character, then try again.');
    const url = new URL(ticket.ws_path, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'init') {
        myId = message.id;
        setTouchEnabled(true);
        lastChatId = null;
        speechBubbles.clear();
        openChat.disabled = false;
        chatText.disabled = false;
        openBoard.disabled = false;
        connecting = false;
        joinButton.disabled = false;
        if (joinDialog.open) joinDialog.close();
        canvas.focus({preventScroll: true});
        canvas.width = message.width;
        canvas.height = message.height;
        playerSize = message.player_size;
        frameInterval = 1000 / message.tick_rate;
        maxPlayers = message.max_players;
        campus = message.map;
        paintCampus();
        statusLabel.textContent = `Connected · You: ${message.name || myId}`;
        sendInput();
      } else if (message.type === 'state') {
        receivePlayers(message.players);
        terminals = message.terminals;
        lilies = Array.isArray(message.lilies) ? message.lilies : [];
        updateClassroom(message);
        updateLab(message.you);
        const me = players.find(p => p.id === myId);
        document.getElementById('locationLabel').textContent = !me ? 'Campus'
          : me.y < 288 && me.x < 352 ? 'Library / Computer lab'
          : me.y < 288 && me.x > 416 ? 'Classroom' : 'Courtyard';
        count.textContent = `${players.length} / ${maxPlayers} online`;
        if (me && typeof me.name !== 'string') {
          statusLabel.textContent = 'Older server detected: restart the root main.py to enable names and character selection.';
        } else if (!Array.isArray(message.benches)) {
          statusLabel.textContent = 'Connected · Restart the Python server to enable bench seating.';
        }
      }
    });
    socket.addEventListener('close', event => {
      clearInput();
      connecting = false;
      joinButton.disabled = false;
      if (joinDialog.open) joinError.textContent = event.reason || 'Connection lost. Try joining again.';
      myId = null;
      setTouchEnabled(false);
      openChat.disabled = true;
      chatText.disabled = true;
      openBoard.disabled = true;
      speechBubbles.clear();
      lastChatId = null;
      document.getElementById('puzzleProgress').textContent = 'Puzzles: 0 / 8';
      document.getElementById('roleLabel').textContent = 'Student';
      teacherRole.textContent = 'Become teacher';
      players = [];
      motion.clear();
      lilies = [];
      document.getElementById('flowerCount').textContent = 'Lily: 0 / 1';
      document.getElementById('locationLabel').textContent = 'Offline';
      activeTerminal = null;
      terminals = [];
      updateJournal();
      desks = [];
      benches = [];
      lecture = {notes: '', highlight: -1, teacher_id: null, active: null};
      teacherRole.disabled = true;
      leaveActivity.hidden = true;
      lectureForm.hidden = true;
      document.getElementById('sendChat').disabled = true;
      document.getElementById('lectureStatus').textContent = 'Disconnected. Reconnect to follow the lecture.';
      if (dialog.open) dialog.close();
      if (boardDialog.open) boardDialog.close();
      hint.textContent = 'Reconnect to return to the lab.';
      count.textContent = 'Offline';
      statusLabel.textContent = event.reason || 'Disconnected. Check the server, then reconnect.';
      reconnect.hidden = false;
      reconnect.disabled = false;
    });
    socket.addEventListener('error', () => {
      statusLabel.textContent = 'Connection failed. Make sure the Python server is running.';
    });
  } catch (error) {
    connecting = false;
    joinButton.disabled = false;
    joinError.textContent = error.message;
    statusLabel.textContent = error.message;
    count.textContent = 'Offline';
    reconnect.hidden = false;
    reconnect.disabled = false;
  }
}

window.addEventListener('keydown', event => {
  // Let native dialogs handle Escape, without also leaving the seat/podium.
  if (dialog.open || joinDialog.open) return;
  const typing = event.target.matches('input, textarea, select') || event.target.isContentEditable;
  if (boardDialog.open) {
    if (!typing && !event.repeat && event.code === 'KeyB') {
      event.preventDefault(); togglePopup(boardDialog);
    }
    return;
  }
  if (event.code === 'Escape' && document.getElementById('chatForm').contains(event.target)) {
    event.preventDefault();
    returnToGame();
    return;
  }
  if (typing) return;
  if (event.key === '/' || event.code === 'KeyB') {
    event.preventDefault();
    if (!event.repeat) {
      if (event.key === '/') focusChat();
      else togglePopup(boardDialog);
    }
    return;
  }
  if (event.code === 'Escape') {
    clearInput(); action('leave_activity'); event.target.blur?.(); return;
  }
  if (event.code === 'KeyF' || event.code === 'KeyG') {
    event.preventDefault();
    if (!event.repeat) { clearInput(); action(event.code === 'KeyF' ? 'pick_lily' : 'give_lily'); }
    return;
  }
  if (event.code === 'KeyE') {
    event.preventDefault();
    if (!event.repeat) { clearInput(); action('interact'); }
    return;
  }
  if (!movementKeys.includes(event.code)) return;
  event.preventDefault();
  pressed.add(event.code);
  if (!event.repeat) sendInput();
});
window.addEventListener('keyup', event => {
  if (!movementKeys.includes(event.code)) return;
  if (!event.target.matches('input, textarea, select')) event.preventDefault();
  pressed.delete(event.code);
  sendInput();
});
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
window.addEventListener('pagehide', () => { clearInput(); socket?.close(); });
reconnect.addEventListener('click', connect);
setInterval(sendInput, 200); // Server stops movement if heartbeats go missing.

// Draw the server's tilemap once. All art is local Canvas pixel art.
function paintCampus() {
  mapCanvas.width = canvas.width;
  mapCanvas.height = canvas.height;
  const c = mapCanvas.getContext('2d');
  const size = campus.tile_size;
  function rect(x, y, w, h, color) {
    c.fillStyle = color; c.fillRect(x, y, w, h);
  }
  for (let row = 0; row < campus.tiles.length; row++) {
    for (let col = 0; col < campus.tiles[row].length; col++) {
      const tile = campus.tiles[row][col];
      const x = col * size, y = row * size;
      const inside = row < 10 && col > 0 && col < 24 && col !== 12;
      const floor = inside ? (col < 12 ? '#c5c6ac' : '#bd986e') : ((row + col) % 3 ? '#628c50' : '#668f53');
      rect(x, y, size, size, floor);
      if (inside) {
        rect(x, y + 31, 32, 1, '#00000018');
        rect(x + 31, y, 1, 32, '#00000012');
        if (col > 12) {
          rect(x, y + 15, 32, 1, '#9a79564a');
          rect(x + (row % 2 ? 8 : 24), y, 1, 15, '#9a795640');
        }
      } else {
        rect(x + 5 + (col % 3) * 3, y + 9, 2, 4, '#648b53');
        rect(x + 23, y + 24, 3, 2, '#45693e');
        if (tile === 'g' && (col * 7 + row * 11) % 9 === 0) {
          rect(x + 15, y + 18, 2, 6, '#416b3c');
          rect(x + 13, y + 16, 6, 3, (col % 2) ? '#e7c36d' : '#e8a9a0');
          rect(x + 15, y + 15, 2, 5, '#f1dbac');
        }
      }
      if (tile === '=') {
        rect(x, y, 32, 32, '#a9a38a');
        rect(x, y + 30, 32, 2, '#938e77');
        rect(x + 30, y, 2, 30, '#b8b29b');
        rect(x + 2, y + 2, 27, 1, '#c9c3a5');
        rect(x, y + 15, 30, 1, '#96927c');
        rect(x + (row % 2 ? 10 : 21), y + 16, 1, 14, '#96927c');
      } else if (tile === '#') {
        rect(x, y, 32, 32, '#43535b');
        rect(x, y, 32, 5, '#91a09a');
        rect(x + 1, y + 7, 30, 9, '#687974');
        rect(x + 1, y + 18, 14, 9, '#5b6d68');
        rect(x + 17, y + 18, 14, 9, '#5b6d68');
        rect(x, y + 29, 32, 3, '#344740');
        if ((col === 1 || col === 23) && [3, 6].includes(row)) {
          rect(x + 5, y + 6, 22, 20, '#2b4548');
          rect(x + 7, y + 8, 18, 16, '#80b5ba');
          rect(x + 9, y + 9, 6, 3, '#c2e0d5');
          rect(x + 15, y + 8, 2, 16, '#d1d2ba');
          rect(x + 7, y + 15, 18, 2, '#d1d2ba');
        }
      } else if (['P', 'D', 'L', 'B'].includes(tile)) {
        rect(x, y, 32, 32, '#574231');
        rect(x + 2, y + 2, 28, 24, '#ac7548');
        rect(x + 2, y + 2, 28, 3, '#c9925f');
        rect(x + 3, y + 28, 4, 4, '#3d302a');
        rect(x + 25, y + 28, 4, 4, '#3d302a');
        if (tile === 'P') {
          rect(x + 5, y + 3, 22, 15, '#283942');
          rect(x + 7, y + 5, 18, 10, '#70bbb0');
          rect(x + 10, y + 7, 7, 2, '#c5f2c1');
          rect(x + 14, y + 18, 4, 3, '#263b41');
          rect(x + 6, y + 22, 20, 3, '#dbd9c4');
          rect(x + 10, y + 11, 11, 1, '#c5f2c1');
          for (let key = 0; key < 5; key++) rect(x + 7 + key * 3, y + 23, 1, 1, '#677d78');
        } else if (tile === 'D') {
          rect(x + 7, y + 6, 13, 15, '#eee2b9');
          rect(x + 9, y + 9, 8, 1, '#89958c');
          rect(x + 23, y + 7, 2, 12, '#efca6c');
        } else if (tile === 'B') {
          rect(x + 2, y + 9, 28, 2, '#715235');
          rect(x + 2, y + 19, 28, 2, '#715235');
        } else {
          rect(x + 6, y + 5, 20, 14, '#ded4ad');
          rect(x + 15, y + 5, 1, 14, '#967e58');
        }
      } else if (tile === 'S') {
        rect(x, y, 32, 32, '#554130');
        for (let shelf = 0; shelf < 2; shelf++) {
          for (let book = 0; book < 5; book++) {
            rect(x + 3 + book * 5, y + 3 + shelf * 15, 4, 11,
              ['#a8bb8d', '#bf7964', '#769cae', '#e0c786', '#978db0'][book]);
          }
          rect(x + 1, y + 14 + shelf * 15, 30, 2, '#ba9060');
        }
      } else if (tile === 'T') {
        rect(x, y, 32, 32, '#425d38');
        rect(x + 3, y + 24, 26, 6, '#365136');
        rect(x + 12, y + 17, 8, 15, '#76502f');
        rect(x + 14, y + 21, 3, 10, '#ab7a46');
        rect(x + 5, y + 2, 22, 23, '#284c38');
        rect(x + 1, y + 7, 30, 13, '#315c3c');
        rect(x + 5, y + 3, 21, 15, '#477944');
        rect(x + 9, y + 1, 13, 7, '#63934f');
        rect(x + 4, y + 9, 8, 5, '#598a48');
        rect(x + 19, y + 16, 8, 4, '#3a6940');
        rect(x + 12, y + 6, 4, 2, '#81a660');
      } else if (tile === 'F') {
        rect(x, y, 32, 32, '#438b9b');
        // Connected pool: only its outer edge is stone, not every tile.
        if (campus.tiles[row - 1]?.[col] !== 'F') {
          rect(x, y, 32, 5, '#c2c7b3'); rect(x, y + 5, 32, 2, '#627e79');
        }
        if (campus.tiles[row + 1]?.[col] !== 'F') {
          rect(x, y + 26, 32, 6, '#7e9389'); rect(x, y + 26, 32, 2, '#c2c7b3');
        }
        if (campus.tiles[row][col - 1] !== 'F') rect(x, y, 5, 32, '#aab6a3');
        if (campus.tiles[row][col + 1] !== 'F') rect(x + 27, y, 5, 32, '#7e9389');
        rect(x + 9, y + 14, 12, 2, '#6bb4bd');

      }
    }
  }
  // Chairs sit on walkable floor; E reserves the associated desk or PC.
  for (let row = 0; row < campus.tiles.length; row++) {
    for (let col = 0; col < campus.tiles[row].length; col++) {
      if (!['P', 'D'].includes(campus.tiles[row][col])) continue;
      const x = col * size + 16, y = (row + 1) * size + 16;
      rect(x - 11, y - 7, 22, 18, '#684d37');
      rect(x - 9, y - 5, 18, 12, '#ba9363');
      rect(x - 12, y + 7, 24, 5, '#8f6747');
      rect(x - 10, y + 12, 4, 3, '#493d30');
      rect(x + 6, y + 12, 4, 3, '#493d30');
    }
  }
  // Signs and the blackboard decorate existing solid wall tiles.
  function sign(text, x, y, width) {
    rect(x - width / 2, y, width, 20, '#203b35');
    c.font = 'bold 11px monospace'; c.textAlign = 'center'; c.fillStyle = '#e7dfb9';
    c.fillText(text, x, y + 14);
  }
  sign('LIBRARY / COMPUTER LAB', 208, 37, 216);
  sign('CLASSROOM', 592, 37, 180);
  sign('COURTYARD · TAMBAY', 400, 544, 190);
}

function drawStudent(player, now, ctx = canvas.getContext('2d')) {
  const x = Math.round(player.x), y = Math.round(player.y);
  const seated = player.state === 'seated';
  const step = player.state === 'walking' ? Math.sin(now / 95) : 0;
  const stride = Math.round(step * 2);
  const bob = player.state === 'walking' ? Math.round(Math.abs(step)) : 0;
  // Stable appearance in every tab, derived from the server-assigned identity.
  const seed = parseInt(player.id.slice(0, 6), 16) || 0;
  // Recognize the old green color too, so an already-running server updates visually.
  const isGirl = player.appearance ? player.appearance.style === 'ponytail' : ['#89d185', '#f4ce58'].includes(player.color);
  const outfit = player.color === '#89d185' ? '#f4ce58' : player.color;
  const skin = ['#efc39b', '#cd956c', '#9f6b50', '#e0ae85'][player.appearance?.skin ?? seed % 4];
  const hair = ['#342d31', '#62432d', '#292f3e', '#875c38'][player.appearance?.hair ?? Math.floor(seed / 4) % 4];
  function pixel(dx, dy, w, h, color) {
    ctx.fillStyle = color; ctx.fillRect(x + dx, y + dy - bob, w, h);
  }
  ctx.fillStyle = '#172c2855';
  ctx.fillRect(x - 11, y + 9, 22, 4);
  if (player.id === myId) {
    ctx.strokeStyle = '#f5f2d6'; ctx.lineWidth = 1;
    ctx.strokeRect(x - 13, y + 9, 26, 5);
  }
  const footY = seated ? 6 : 7;
  pixel(-7, 3, 6, seated ? 6 : 8, '#354556');
  pixel(1, 3, 6, seated ? 6 : 8, '#354556');
  pixel(-8, footY + (seated ? 0 : stride), 7, 4, '#222b36');
  pixel(1, footY - (seated ? 0 : stride), 7, 4, '#222b36');
  if (isGirl) {
    const side = player.facing === 'left' ? 7 : -12;
    pixel(side, -21, 6, 16, hair); // Ponytail, behind the shoulder.
    pixel(side, -19, 6, 3, outfit);
  }
  pixel(-8, -7, 16, 13, '#263c42');
  pixel(-7, -7, 14, 11, outfit);
  pixel(-11, -5 + stride, 4, 9, outfit);
  pixel(7, -5 - stride, 4, 9, outfit);
  pixel(-10, 2 + stride, 3, 3, skin);
  pixel(7, 2 - stride, 3, 3, skin);
  if (isGirl) {
    pixel(-9, 2, 18, seated ? 4 : 6, outfit);
    pixel(-9, seated ? 5 : 7, 18, 1, '#263c4260');
  }
  pixel(-3, -10, 6, 5, skin);
  pixel(-8, -23, 16, 14, hair);
  pixel(-7, -20, 14, 11, skin);
  pixel(-8, -24, 16, 5, hair);
  pixel(-9, -21, 3, 7, hair);
  if (player.facing === 'up') {
    pixel(-7, -20, 14, 11, hair);
    pixel(-5, -5, 10, 10, '#66755a'); // Backpack when facing away.
    pixel(-3, -3, 6, 2, '#9ca77e');
  } else {
    const eye = player.facing === 'left' ? -5 : player.facing === 'right' ? 4 : -4;
    pixel(eye, -16, 2, 2, '#30333d');
    if (player.facing === 'down') pixel(3, -16, 2, 2, '#30333d');
    pixel(-1, -11, 3, 1, '#a96d55');
    pixel(-1, -6, 2, 7, '#e6e7ce'); // College ID lanyard.
    pixel(-2, 0, 4, 4, '#f1ebcc');
  }
  if (!isGirl && !player.appearance && seed % 3 === 0) pixel(4, -23, 5, 4, hair);
  if (player.role === 'teacher') {
    pixel(7, -7, 4, 4, '#f5d476');
    pixel(-7, -27, 14, 3, '#efcd70');
  }
  if (player.lily_id) {
    const handX = player.facing === 'left' ? -12 : 8;
    const handY = player.facing === 'up' ? -13 : -5;
    pixel(handX, handY, 4, 7, '#78c56c');
    pixel(handX - 2, handY - 2, 8, 5, '#f4f1dc');
    pixel(handX + 1, handY - 4, 1, 10, '#e7c463');
  }

}

let previewDirection = 0;
let previewWalking = false;
document.getElementById('turnPreview').addEventListener('click', () => { previewDirection = (previewDirection + 1) % 4; });
document.getElementById('walkPreview').addEventListener('click', event => {
  previewWalking = !previewWalking;
  event.currentTarget.setAttribute('aria-pressed', String(previewWalking));
  event.currentTarget.textContent = previewWalking ? 'Stop' : 'Walk';
});
function paintCharacterPreview() {
  if (!joinDialog.open) return;
  const preview = document.getElementById('characterPreview');
  const context = preview.getContext('2d');
  context.fillStyle = '#293d31'; context.fillRect(0, 0, 56, 64);
  const colors = ['#f4ce58','#78bfff','#ffcc77','#eb91c8','#a99aff','#66d9cc','#fa9380','#d3db83','#d6b297','#b6c8e0'];
  drawStudent({id:'preview', x:28, y:42, state:previewWalking?'walking':'idle',
    facing:['down','left','up','right'][previewDirection], color:colors[Number(document.getElementById('characterChoice').value)],
    appearance:{skin:Number(document.getElementById('skinChoice').value),hair:Number(document.getElementById('hairChoice').value),style:document.getElementById('styleChoice').value}}, performance.now(), context);
}

function withinFlowerReach(me, item) {
  if (!campus || Math.hypot(me.x - item.x, me.y - item.y) > 48) return false;
  for (let step = 0; step <= 8; step++) {
    const x = me.x + (item.x - me.x) * step / 8;
    const y = me.y + (item.y - me.y) * step / 8;
    if (campus.tiles[Math.floor(y / campus.tile_size)]?.[Math.floor(x / campus.tile_size)] === '#') return false;
  }
  return true;
}
function giftRecipient(me) {
  return players.filter(p => p.id !== myId && withinFlowerReach(me, p))
    .sort((a,b) => Math.hypot(a.x-me.x,a.y-me.y)-Math.hypot(b.x-me.x,b.y-me.y) || a.id.localeCompare(b.id))[0];
}

function interactionTarget() {
  const me = players.find(p => p.id === myId);
  if (!me || ['seated', 'lecturing'].includes(me.state)) return null;
  const nearItem = item => withinFlowerReach(me, item);
  const objects = [];
  if (me.lily_id) {
    const recipient = giftRecipient(me);
    if (recipient) objects.push({x: recipient.x, y: recipient.y, kind: 'player', label: recipient.lily_id ? 'Already holding a lily' : `G · Give to ${recipient.name || recipient.id}`});
  }
  objects.push(...lilies.filter(lily => !me.lily_id && !lily.holder && nearItem(lily))
    .map(lily => ({...lily, kind: 'lily', label: 'F · Pick lily'})));
  objects.push(
    {x: 592, y: 112, kind: 'podium', occupant: lecture.active, label: me.role === 'teacher' ? 'E · Teach' : 'Teacher podium'},
    ...desks.map(t => ({...t, kind: 'desk', label: 'E · Sit'})),
    ...benches.map(t => ({...t, kind: 'bench', label: 'E · Sit'})),
    ...terminals.map((t, index) => ({...t, kind: 'terminal', label: `E · Computer ${index + 1}${completedTerminals.has(t.id) ? ' · Solved' : ' · Code'}`}))
  );
  return objects.find(t => ['lily', 'player'].includes(t.kind) ? nearItem(t) : Math.abs(me.x - t.x) <= 20 && me.y - t.y >= 28 && me.y - t.y <= 56);
}
// Only fresh server messages create bubbles; snapshots must not restart timers.
function receiveSpeech(messages) {
  const now = performance.now();
  const announcements = document.getElementById('chatAnnouncements');
  if (lastChatId !== null) {
    for (const item of messages) {
      if (item.id <= lastChatId) continue;
      speechBubbles.set(item.player_id, {
        text: item.text,
        expires: now + Math.min(16000, Math.max(8000, item.text.length * 75)),
      });
      const line = document.createElement('p');
      line.textContent = `${item.name || item.player_id}: ${item.text}`;
      announcements.append(line);
      while (announcements.children.length > 50) announcements.firstElementChild.remove();
    }
  }
  lastChatId = Math.max(lastChatId ?? 0, ...messages.map(item => item.id));
  for (const [id, bubble] of speechBubbles) {
    if (bubble.expires <= now || !players.some(player => player.id === id)) speechBubbles.delete(id);
  }
}
function wrapSpeech(text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.trim().split(/\s+/u)) {
    if (line && ctx.measureText(`${line} ${word}`).width <= maxWidth) {
      line += ` ${word}`;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    // Split even a long unbroken word without overflowing the bubble.
    for (const character of word) {
      if (line && ctx.measureText(line + character).width > maxWidth) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function drawSpeechBubble(player, now) {
  const bubble = speechBubbles.get(player.id);
  if (!bubble) return;
  if (bubble.expires <= now) { speechBubbles.delete(player.id); return; }
  ctx.save();
  ctx.font = '13px system-ui, sans-serif';
  const lines = wrapSpeech(bubble.text, 200);
  const width = Math.max(52, ...lines.map(line => ctx.measureText(line).width + 24));
  const height = lines.length * 18 + 20;
  const x = Math.max(6, Math.min(canvas.width - width - 6, player.x - width / 2));
  const above = player.y - 56 - height;
  // Near the top edge, place the cloud below its speaker instead.
  const below = above < 6;
  const y = Math.max(6, Math.min(canvas.height - height - 6, below ? player.y + 40 : above));
  const tailX = Math.max(x + 14, Math.min(x + width - 14, player.x));
  ctx.globalAlpha = Math.min(1, (bubble.expires - now) / 500);
  ctx.fillStyle = '#fffdf3';
  ctx.strokeStyle = '#687d67';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 16);
  ctx.fill();
  ctx.stroke();
  // Two little puffs connect the cloud to the character.
  for (const [offset, radius] of [[4, 5], [12, 3]]) {
    ctx.beginPath();
    ctx.arc(tailX, below ? y - offset : y + height + offset, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#203225';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((line, index) => ctx.fillText(line, x + width / 2, y + 10 + index * 18));
  ctx.restore();
}

function drawInteractionPrompt() {
  if (dialog.open || boardDialog.open || document.activeElement === chatText) return;
  const target = interactionTarget();
  if (!target) return;
  const label = target.occupant ? 'In use' : target.label;
  ctx.strokeStyle = target.occupant ? '#edb56b' : '#e1efb0';
  ctx.lineWidth = 2;
  ctx.strokeRect(target.x - 17, target.y - 17, 34, 34);
  ctx.font = 'bold 11px monospace';
  const width = Math.ceil(ctx.measureText(label).width) + 16;
  ctx.fillStyle = '#172a24';
  ctx.fillRect(target.x - width / 2, target.y - 39, width, 17);
  ctx.fillStyle = '#eff2d4';
  ctx.textAlign = 'center';
  ctx.fillText(label, target.x, target.y - 27);
}

function draw() {
  ctx.fillStyle = '#202927';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (campus) {
    ctx.drawImage(mapCanvas, 0, 0);
    const ripple = Math.floor(performance.now() / 180) % 8;
    ctx.strokeStyle = '#a0ddd080'; ctx.lineWidth = 1;
    ctx.strokeRect(390 - ripple, 440 - ripple / 2, 20 + ripple * 2, 9 + ripple);
    ctx.fillStyle = '#c3d0bc'; ctx.fillRect(395, 432, 10, 12);
    ctx.fillStyle = '#e0f5df'; ctx.fillRect(398, 421, 4, 13);
    ctx.fillStyle = '#9cdbd7'; ctx.fillRect(394, 421, 12, 3);
    for (const lily of lilies) {
      if (lily.holder) continue;
      const x = lily.x, y = lily.y;
      ctx.fillStyle = '#44643f';
      ctx.fillRect(x - 1, y - 7, 2, 10);
      ctx.fillStyle = '#f4f1dc';
      ctx.fillRect(x - 4, y - 11, 8, 8);
      ctx.fillStyle = '#e9c65f';
      ctx.fillRect(x - 1, y - 8, 2, 2);
      ctx.fillStyle = '#7bc56d';
      ctx.fillRect(x - 6, y - 4, 4, 2);
      ctx.fillRect(x + 2, y - 4, 4, 2);
    }
  }
  ctx.textAlign = 'center';
  ctx.font = '11px monospace';
  for (const terminal of terminals) {
    const done = completedTerminals.has(terminal.id);
    ctx.fillStyle = '#202a24';
    ctx.fillRect(terminal.x - 21, terminal.y - 27, 42, 12);
    ctx.fillStyle = done ? '#d1edbd' : '#e6eae5';
    ctx.font = '9px monospace';
    ctx.fillText(`${terminals.indexOf(terminal) + 1}${done ? ' ✓' : ''}`, terminal.x, terminal.y - 18);
    ctx.fillStyle = terminal.occupant ? '#ffd178' : '#a3e3a1';
    ctx.fillRect(terminal.x + 9, terminal.y - 12, 4, 4);
    if (terminal.occupant) {
      ctx.fillStyle = '#202a24';
      ctx.fillRect(terminal.x - 27, terminal.y - 40, 54, 12);
      ctx.fillStyle = '#ffd178';
      ctx.font = '9px monospace';
      ctx.fillText('IN USE', terminal.x, terminal.y - 31);
    }
  }
  // Shared board preview is painted on the classroom wall.
  ctx.fillStyle = '#14382d';
  ctx.fillRect(500, 33, 200, 28);
  ctx.fillStyle = lecture.highlight >= 0 ? '#ffe28d' : '#e8ead8';
  ctx.font = '10px monospace';
  const preview = lecture.notes ? lecture.notes.split('\n')[Math.max(0, lecture.highlight)] : 'CLASSROOM';
  ctx.fillText(preview, 600, 51, 190);
  for (const desk of [...desks, ...benches]) {
    if (desk.occupant) { ctx.fillStyle = '#ffd178'; ctx.fillRect(desk.x + 9, desk.y - 12, 4, 4); }
  }
  ctx.font = '11px monospace';
  const now = performance.now();
  for (const player of renderedPlayers(now).sort((a, b) => a.y - b.y)) {
    const x = Math.round(player.x), y = Math.round(player.y);
    drawStudent(player, now);
    const labelY = y < 48 ? y + 29 : y - 32;
    const displayName = player.name || player.id;
    const label = player.id === myId ? `${displayName} · YOU` : displayName;
    const labelWidth = Math.ceil(ctx.measureText(label).width) + 12;
    const labelX = Math.max(labelWidth / 2, Math.min(canvas.width - labelWidth / 2, x));
    ctx.fillStyle = '#111916';
    ctx.fillRect(labelX - labelWidth / 2, labelY - 11, labelWidth, 15);
    ctx.fillStyle = '#f0f4ed';
    ctx.fillText(label, labelX, labelY);
  }
  drawInteractionPrompt();
  for (const player of renderedPlayers(now)) drawSpeechBubble(player, now);
  paintCharacterPreview();
  requestAnimationFrame(draw);
}
draw();
joinDialog.showModal();

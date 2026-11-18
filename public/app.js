const CATEGORY_LABELS = {
  all: '全部华语',
  classic: '经典怀旧',
  chart: '流行热歌',
  folk_rock: '民谣摇滚',
  cantonese_ost: '粤语影视'
};

function resolveApiOrigin() {
  const params = new URLSearchParams(location.search);
  const queryApi = params.get('api');
  if (queryApi && /^https?:\/\//i.test(queryApi)) {
    const cleaned = queryApi.replace(/\/+$/, '');
    sessionStorage.setItem('kugou_guess_api_origin', cleaned);
    return cleaned;
  }
  const saved = sessionStorage.getItem('kugou_guess_api_origin');
  if (saved) return saved;
  if (typeof window.GUESS_SONG_API_ORIGIN === 'string' && window.GUESS_SONG_API_ORIGIN) {
    return window.GUESS_SONG_API_ORIGIN.replace(/\/+$/, '');
  }
  return '';
}

const API_ORIGIN = resolveApiOrigin();

function apiUrl(pathname) {
  return `${API_ORIGIN}${pathname}`;
}

function resolveWsUrl() {
  if (API_ORIGIN) {
    return `${API_ORIGIN.replace(/^http/i, 'ws')}/ws`;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function getSessionClientId() {
  let id = sessionStorage.getItem('kugou_guess_client_id');
  if (!id) {
    id =
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    sessionStorage.setItem('kugou_guess_client_id', id);
  }
  return id;
}

function formatSeconds(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function formatDurationMs(ms) {
  if (!ms || ms <= 0) return '0.0 秒';
  return `${(ms / 1000).toFixed(1)} 秒`;
}

// ==================== PROGRESSIVE DIALOG FALLBACKS ====================
function setupNativeDialogEnhancements() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      dialog.returnValue = '';
    });
  }

  // Fallback for closedby="any" (e.g. Safari)
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const isOutside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = isOutside(e, dialog);
      });
      dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && isOutside(e, dialog)) dialog.close();
      });
    }
  }

  // Fallback when Invoker Commands (command / commandfor) are unavailable
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    for (const btn of document.querySelectorAll('button[command][commandfor]')) {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.getAttribute('commandfor'));
        const cmd = btn.getAttribute('command');
        if (!target || typeof target.showModal !== 'function') return;
        if (cmd === 'show-modal' && !target.open) target.showModal();
        else if (cmd === 'close' && target.open) target.close();
      });
    }
  }
}

// ==================== APP STATE ====================
const state = {
  clientId: getSessionClientId(),
  ws: null,
  room: null,
  vipAuth: null, // { authTicket, nickname, userid }
  qrKey: '',
  qrPollTimer: null,
  currentAudioKey: null,
  audioMuted: false,
  audioUnlocked: false,
  timerRaf: null,
  toastTimer: null,
  scoreNodeMap: new Map(),
  lastRankSignature: ''
};

// DOM Elements
const els = {
  connPill: document.getElementById('conn-pill'),
  poolBadge: document.getElementById('pool-badge'),
  openVipBtn: document.getElementById('open-vip-btn'),
  toastBanner: document.getElementById('toast-banner'),
  viewHome: document.getElementById('view-home'),
  viewLobby: document.getElementById('view-lobby'),
  viewGame: document.getElementById('view-game'),
  viewResult: document.getElementById('view-result'),

  createForm: document.getElementById('create-room-form'),
  nicknameInput: document.getElementById('nickname-input'),
  nicknameError: document.getElementById('nickname-error'),
  roomNameInput: document.getElementById('room-name-input'),

  joinForm: document.getElementById('join-room-form'),
  roomCodeInput: document.getElementById('room-code-input'),
  roomCodeError: document.getElementById('room-code-error'),
  refreshRoomsBtn: document.getElementById('refresh-rooms-btn'),
  publicRoomsList: document.getElementById('public-rooms-list'),

  lobbyRoomCode: document.getElementById('lobby-room-code'),
  lobbyRoomName: document.getElementById('lobby-room-name'),
  lobbyRoomDesc: document.getElementById('lobby-room-desc'),
  copyCodeBtn: document.getElementById('copy-code-btn'),
  leaveLobbyBtn: document.getElementById('leave-lobby-btn'),
  readyBanner: document.getElementById('ready-banner'),
  readyStatusText: document.getElementById('ready-status-text'),
  countdownPill: document.getElementById('countdown-pill'),
  lobbyVipBar: document.getElementById('lobby-vip-bar'),
  lobbyVipText: document.getElementById('lobby-vip-text'),
  lobbyVipBtn: document.getElementById('lobby-vip-btn'),
  unbindVipBtn: document.getElementById('unbind-vip-btn'),
  lobbyPlayerCount: document.getElementById('lobby-player-count'),
  lobbyPlayersList: document.getElementById('lobby-players-list'),
  addBotBtn: document.getElementById('add-bot-btn'),
  removeBotBtn: document.getElementById('remove-bot-btn'),
  readyToggleBtn: document.getElementById('ready-toggle-btn'),
  soloStartBtn: document.getElementById('solo-start-btn'),

  gameRoundNum: document.getElementById('game-round-num'),
  gameSourceTag: document.getElementById('game-source-tag'),
  roundTimerText: document.getElementById('round-timer-text'),
  muteBtn: document.getElementById('mute-btn'),
  skipVoteBtn: document.getElementById('skip-vote-btn'),
  leaveGameBtn: document.getElementById('leave-game-btn'),
  playingDot: document.getElementById('playing-dot'),
  revealCoverImg: document.getElementById('reveal-cover-img'),
  playingStatusTitle: document.getElementById('playing-status-title'),
  songHintText: document.getElementById('song-hint-text'),
  manualPlayBtn: document.getElementById('manual-play-btn'),
  startNodeBadge: document.getElementById('start-node-badge'),
  durationTotalText: document.getElementById('duration-total-text'),
  timelineStartPin: document.getElementById('timeline-start-pin'),
  timelinePlayhead: document.getElementById('timeline-playhead'),
  roundRevealBox: document.getElementById('round-reveal-box'),
  revealBadgeText: document.getElementById('reveal-badge-text'),
  revealSongTitle: document.getElementById('reveal-song-title'),
  revealSingerText: document.getElementById('reveal-singer-text'),
  revealNextHint: document.getElementById('reveal-next-hint'),

  scoreboardStatus: document.getElementById('scoreboard-status'),
  liveScoreboard: document.getElementById('live-scoreboard'),
  guessFeed: document.getElementById('guess-feed'),
  guessForm: document.getElementById('guess-form'),
  guessInput: document.getElementById('guess-input'),
  guessSubmitBtn: document.getElementById('guess-submit-btn'),

  resultChampionTitle: document.getElementById('result-champion-title'),
  podiumGrid: document.getElementById('podium-grid'),
  finalRankingTbody: document.getElementById('final-ranking-tbody'),
  playAgainBtn: document.getElementById('play-again-btn'),
  resultLeaveBtn: document.getElementById('result-leave-btn'),
  roundHistoryList: document.getElementById('round-history-list'),

  vipDialog: document.getElementById('vip-dialog'),
  vipActiveBox: document.getElementById('vip-active-box'),
  vipActiveName: document.getElementById('vip-active-name'),
  logoutVipBtn: document.getElementById('logout-vip-btn'),
  qrCodeImg: document.getElementById('qr-code-img'),
  qrPlaceholder: document.getElementById('qr-placeholder'),
  qrStatusText: document.getElementById('qr-status-text'),
  refreshQrBtn: document.getElementById('refresh-qr-btn'),
  manualVipForm: document.getElementById('manual-vip-form'),
  vipCookieInput: document.getElementById('vip-cookie-input'),
  vipUseridInput: document.getElementById('vip-userid-input'),
  vipTokenInput: document.getElementById('vip-token-input'),
  vipFormError: document.getElementById('vip-form-error'),

  audioEl: document.getElementById('game-audio')
};

function showToast(msg) {
  if (!msg) return;
  els.toastBanner.textContent = msg;
  els.toastBanner.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toastBanner.hidden = true;
  }, 3000);
}

function getValidatedNickname() {
  const nick = els.nicknameInput.value.trim();
  if (!nick) {
    els.nicknameInput.setCustomValidity('请先输入你的昵称（1-16 个字）');
    els.nicknameInput.setAttribute('aria-invalid', 'true');
    els.nicknameError.textContent = '请先输入你的昵称（1-16 个字）';
    els.nicknameInput.focus();
    return null;
  }
  els.nicknameInput.setCustomValidity('');
  els.nicknameInput.removeAttribute('aria-invalid');
  els.nicknameError.textContent = '';
  sessionStorage.setItem('kugou_guess_nickname', nick);
  return nick;
}

// ==================== AUDIO UNLOCK & PLAYBACK ====================
function unlockAudioElement() {
  if (state.audioUnlocked) return;
  try {
    // Play a tiny silent WAV data URI inside user gesture to unlock autoplay
    const silentWav =
      'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    els.audioEl.src = silentWav;
    const p = els.audioEl.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        els.audioEl.pause();
        els.audioEl.removeAttribute('src');
        state.audioUnlocked = true;
      }).catch(() => {});
    }
  } catch {
    // Fallback handled by manualPlayBtn
  }
}

function stopRoundAudio() {
  state.currentAudioKey = null;
  els.audioEl.onloadedmetadata = null;
  els.audioEl.oncanplay = null;
  els.audioEl.pause();
  if (els.audioEl.hasAttribute('src')) {
    els.audioEl.removeAttribute('src');
    els.audioEl.load();
  }
  els.playingDot.classList.remove('is-active');
  els.manualPlayBtn.hidden = true;
}

function startRoundAudio(round) {
  if (!round || !round.audioUrl) return;
  const audioKey = `${state.room?.code}:${round.roundNumber}`;
  if (state.currentAudioKey === audioKey) return;
  state.currentAudioKey = audioKey;

  const targetOffset = Number(round.startOffset || 0);
  let seekApplied = false;
  els.audioEl.muted = state.audioMuted;

  const seekAndPlay = () => {
    if (state.currentAudioKey !== audioKey) return;
    if (!seekApplied) {
      try {
        const safeTarget = Math.min(
          targetOffset,
          Math.max(0, (els.audioEl.duration || round.duration || 60) * 0.5 - 0.1)
        );
        if (Math.abs(els.audioEl.currentTime - safeTarget) > 0.6) {
          els.audioEl.currentTime = safeTarget;
        }
        seekApplied = true;
      } catch {
        // Seek will retry on canplay
      }
    }

    const playPromise = els.audioEl.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          els.manualPlayBtn.hidden = true;
          els.playingDot.classList.add('is-active');
        })
        .catch(() => {
          els.manualPlayBtn.hidden = false;
        });
    }
  };

  els.audioEl.onloadedmetadata = seekAndPlay;
  els.audioEl.oncanplay = () => {
    if (els.audioEl.paused && state.currentAudioKey === audioKey) {
      seekAndPlay();
    }
  };
  els.audioEl.src = apiUrl(round.audioUrl);
}

els.audioEl.addEventListener('timeupdate', () => {
  const dur = els.audioEl.duration || state.room?.activeRound?.duration || 0;
  if (dur > 0) {
    const pct = Math.min(100, Math.max(0, (els.audioEl.currentTime / dur) * 100));
    els.timelinePlayhead.style.left = `${pct.toFixed(1)}%`;
  }
});

els.manualPlayBtn.addEventListener('click', () => {
  const round = state.room?.activeRound;
  if (round && els.audioEl.currentTime < round.startOffset) {
    try {
      els.audioEl.currentTime = round.startOffset;
    } catch {
      // Ignore seek error
    }
  }
  els.audioEl
    .play()
    .then(() => {
      els.manualPlayBtn.hidden = true;
      els.playingDot.classList.add('is-active');
    })
    .catch(() => showToast('浏览器阻止了音频播放，请检查音量或权限'));
});

els.muteBtn.addEventListener('click', () => {
  state.audioMuted = !state.audioMuted;
  els.audioEl.muted = state.audioMuted;
  els.muteBtn.setAttribute('aria-pressed', String(state.audioMuted));
  els.muteBtn.textContent = state.audioMuted ? '已静音' : '声音开启';
});

// ==================== WEBSOCKET CLIENT ====================
function setConnStatus(status) {
  els.connPill.classList.remove('conn-online', 'conn-connecting', 'conn-offline');
  if (status === 'online') {
    els.connPill.classList.add('conn-online');
    els.connPill.textContent = '实时在线';
  } else if (status === 'connecting') {
    els.connPill.classList.add('conn-connecting');
    els.connPill.textContent = '连接中';
  } else {
    els.connPill.classList.add('conn-offline');
    els.connPill.textContent = '已断开';
  }
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('正在重连服务器，请稍候…');
    return false;
  }
  state.ws.send(JSON.stringify(payload));
  return true;
}

function connectWebSocket() {
  setConnStatus('connecting');
  const ws = new WebSocket(resolveWsUrl());
  state.ws = ws;

  ws.addEventListener('open', () => {
    setConnStatus('online');
    // Rejoin room if disconnected mid-match
    if (state.room?.code) {
      const nick = els.nicknameInput.value.trim() || sessionStorage.getItem('kugou_guess_nickname') || '歌友';
      sendWs({
        type: 'join_room',
        code: state.room.code,
        clientId: state.clientId,
        nickname: nick
      });
    }
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    setConnStatus('offline');
    setTimeout(connectWebSocket, 2000);
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'joined_room':
    case 'room_state':
    case 'vip_updated':
    case 'round_start':
    case 'round_reveal':
    case 'game_finished':
      if (msg.room) {
        state.room = msg.room;
        renderCurrentRoom();
      }
      if (
        msg.type === 'joined_room' &&
        state.vipAuth?.authTicket &&
        !msg.room?.vipStatus?.unlocked
      ) {
        sendWs({ type: 'bind_vip', authTicket: state.vipAuth.authTicket });
      }
      if (msg.type === 'round_reveal' && msg.room?.activeRound?.revealedSong) {
        const rev = msg.room.activeRound.revealedSong;
        if (rev.winnerNickname) {
          showToast(`🎯 ${rev.winnerNickname} 猜中《${rev.canonicalTitle}》 +1分！`);
        }
      }
      break;

    case 'left_room':
      stopRoundAudio();
      state.room = null;
      state.scoreNodeMap.clear();
      state.lastRankSignature = '';
      showView('home');
      refreshPublicRooms();
      break;

    case 'feed_item':
      if (msg.item && state.room) {
        state.room.feed = [...(state.room.feed || []), msg.item].slice(-30);
        renderFeed(state.room.feed);
      }
      break;

    case 'guess_result':
      if (msg.correct) {
        els.guessInput.value = '';
      } else {
        els.guessInput.value = '';
      }
      break;

    case 'error':
      showToast(msg.message || '操作失败');
      break;
  }
}

// ==================== VIEW RENDERING ====================
function showView(name) {
  els.viewHome.hidden = name !== 'home';
  els.viewLobby.hidden = name !== 'lobby';
  els.viewGame.hidden = name !== 'game';
  els.viewResult.hidden = name !== 'result';
}

function renderCurrentRoom() {
  const room = state.room;
  if (!room) {
    showView('home');
    return;
  }

  if (room.status === 'waiting' || room.status === 'countdown') {
    stopRoundAudio();
    showView('lobby');
    renderLobby(room);
  } else if (room.status === 'finished') {
    stopRoundAudio();
    showView('result');
    renderResult(room);
  } else {
    showView('game');
    renderGame(room);
  }
  startGlobalTick();
}

function renderLobby(room) {
  els.lobbyRoomCode.textContent = room.code;
  els.lobbyRoomName.textContent = room.name;
  els.lobbyRoomDesc.textContent = `${CATEGORY_LABELS[room.category] || '全部华语'} · ${room.totalRounds} 轮 · ${room.roundDurationSec} 秒/轮`;

  const players = room.players || [];
  els.lobbyPlayerCount.textContent = String(players.length);

  const readyCount = players.filter((p) => p.ready).length;
  const self = players.find((p) => p.clientId === state.clientId);
  const hasBot = players.some((p) => p.isBot);

  els.removeBotBtn.hidden = !hasBot;
  els.addBotBtn.disabled = players.length >= 8;

  if (room.status === 'countdown') {
    els.readyBanner.classList.add('is-countdown');
    els.readyStatusText.textContent = '所有人准备就绪，即将开局';
    els.countdownPill.hidden = false;
  } else {
    els.readyBanner.classList.remove('is-countdown');
    els.countdownPill.hidden = true;
    if (players.length < 2) {
      els.readyStatusText.textContent = `当前 1 人（${readyCount}/${players.length} 已准备），可邀请好友或添加 AI 歌友`;
    } else {
      els.readyStatusText.textContent = `已准备 ${readyCount}/${players.length} 人 · 全员准备后自动开始`;
    }
  }

  // Render Room VIP Unlock Status
  const vipStatus = room.vipStatus;
  if (vipStatus?.unlocked) {
    els.lobbyVipBar.classList.add('is-unlocked');
    const who = vipStatus.isEnvDefault
      ? '系统默认会员'
      : `${vipStatus.kugouNickname || '酷狗会员'}（由 ${vipStatus.boundByNickname || '房主'} 共享）`;
    els.lobbyVipText.textContent = `✓ 已开启会员实时拉取：${who}`;
    els.lobbyVipBtn.textContent = '切换账号';
    const canUnbind =
      !vipStatus.isEnvDefault &&
      (vipStatus.boundByClientId === state.clientId || room.hostClientId === state.clientId);
    els.unbindVipBtn.hidden = !canUnbind;
  } else {
    els.lobbyVipBar.classList.remove('is-unlocked');
    els.lobbyVipText.textContent = '曲库：免费华语曲库（登录会员可解锁 VIP 原版全曲库）';
    els.lobbyVipBtn.textContent = '登录会员解锁全曲库';
    els.unbindVipBtn.hidden = true;
  }

  els.lobbyPlayersList.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.className = `player-seat${p.ready ? ' is-ready' : ''}`;

    const left = document.createElement('div');
    left.className = 'seat-left';

    const avatar = document.createElement('div');
    avatar.className = 'avatar-circle';
    avatar.textContent = p.nickname.slice(0, 1);

    const nameEl = document.createElement('div');
    nameEl.className = 'seat-name';
    nameEl.textContent = p.clientId === state.clientId ? `${p.nickname} (我)` : p.nickname;

    left.append(avatar, nameEl);

    const badges = document.createElement('div');
    badges.className = 'seat-badges';

    if (p.clientId === room.hostClientId) {
      const hostTag = document.createElement('span');
      hostTag.className = 'tag-host';
      hostTag.textContent = '房主';
      badges.append(hostTag);
    }
    if (p.isBot) {
      const botTag = document.createElement('span');
      botTag.className = 'tag-bot';
      botTag.textContent = 'AI';
      badges.append(botTag);
    }

    const readyTag = document.createElement('span');
    readyTag.className = p.ready ? 'tag-ready' : 'tag-waiting';
    readyTag.textContent = p.ready ? '✓ 已准备' : '准备中';
    badges.append(readyTag);

    li.append(left, badges);
    els.lobbyPlayersList.append(li);
  }

  if (self) {
    els.readyToggleBtn.textContent = self.ready ? '取消准备' : '准备就绪';
    els.readyToggleBtn.className = self.ready ? 'btn btn-outline btn-block' : 'btn btn-primary btn-block';
    els.soloStartBtn.hidden = !(players.length === 1 && self.ready && room.status === 'waiting');
  }
}

function renderGame(room) {
  const round = room.activeRound;
  els.gameRoundNum.textContent = String(room.currentRound || 1);
  els.gameSourceTag.textContent = round?.sourceTag || '酷狗华语';

  const self = room.players.find((p) => p.clientId === state.clientId);
  els.skipVoteBtn.textContent = `${self?.skipVoted ? '已投跳过' : '跳过'} (${room.skipVotes}/${room.skipNeeded})`;
  els.skipVoteBtn.disabled = room.status !== 'playing';

  if (room.status === 'loading_round') {
    stopRoundAudio();
    els.playingStatusTitle.textContent = '正在抽取华语歌曲…';
    els.songHintText.textContent = '加载中';
    els.roundRevealBox.hidden = true;
    els.revealCoverImg.hidden = true;
  } else if (room.status === 'playing' && round) {
    els.playingStatusTitle.textContent = '正在播放片段';
    els.songHintText.textContent = `歌名 ${round.titleLengthHint} 个字`;
    els.roundRevealBox.hidden = true;
    els.revealCoverImg.hidden = true;

    const totalDur = round.duration || 0;
    els.durationTotalText.textContent = formatSeconds(totalDur);
    els.startNodeBadge.textContent = `起点 ${formatSeconds(round.startOffset)}（前 50% · ${round.startPercent}%）`;
    els.timelineStartPin.style.left = `${Math.min(49.9, round.startPercent || 0)}%`;

    startRoundAudio(round);
  } else if (room.status === 'round_reveal' && round?.revealedSong) {
    els.audioEl.pause();
    els.playingDot.classList.remove('is-active');

    const rev = round.revealedSong;
    els.playingStatusTitle.textContent = rev.winnerNickname
      ? `${rev.winnerNickname} 猜中`
      : '本轮已结束';
    els.songHintText.textContent = `起点 ${formatSeconds(round.startOffset)}（${round.startPercent}%）`;

    if (rev.albumImg) {
      els.revealCoverImg.src = rev.albumImg;
      els.revealCoverImg.alt = `${rev.canonicalTitle} 封面`;
      els.revealCoverImg.hidden = false;
    }

    els.roundRevealBox.hidden = false;
    els.roundRevealBox.classList.toggle('is-miss', !rev.winnerNickname);

    if (rev.winnerNickname) {
      els.revealBadgeText.textContent = `${rev.winnerNickname} 猜中 +1 分（${formatDurationMs(rev.winTimeMs)}）`;
    } else if (rev.reason === 'skipped') {
      els.revealBadgeText.textContent = '已跳过本轮';
    } else {
      els.revealBadgeText.textContent = '时间到，无人猜中';
    }

    els.revealSongTitle.textContent = `《${rev.canonicalTitle}》`;
    els.revealSingerText.textContent = rev.singerName;
    els.revealNextHint.textContent =
      room.currentRound < room.totalRounds
        ? `即将进入第 ${room.currentRound + 1} / ${room.totalRounds} 轮`
        : '10 轮已结束，正在生成排名';
  }

  updateLiveScoreboard(room.rankings || []);
  renderFeed(room.feed || []);
}

// ==================== DYNAMIC-SORT SCOREBOARD (moveBefore + ViewTransition) ====================
function createScoreNode(player) {
  const row = document.createElement('div');
  row.className = 'score-chip';
  row.dataset.clientId = player.clientId;

  const rankSpan = document.createElement('span');
  rankSpan.className = 'rank-num';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'score-name';

  const ptsSpan = document.createElement('span');
  ptsSpan.className = 'score-pts';

  row.append(rankSpan, nameSpan, ptsSpan);
  return row;
}

function reorderContainerNodes(container, orderedNodes) {
  const canMoveBefore = Object.hasOwn(Element.prototype, 'moveBefore');
  for (const node of orderedNodes) {
    if (canMoveBefore && node.parentNode === container) {
      container.moveBefore(node, null);
    } else {
      container.append(node);
    }
  }
}

function updateLiveScoreboard(rankings) {
  const container = els.liveScoreboard;
  const activeIds = new Set(rankings.map((r) => r.clientId));

  // Remove stale nodes for players who left
  for (const [id, node] of state.scoreNodeMap.entries()) {
    if (!activeIds.has(id)) {
      node.remove();
      state.scoreNodeMap.delete(id);
    }
  }

  let allMounted = true;
  const orderedNodes = [];
  for (const r of rankings) {
    let node = state.scoreNodeMap.get(r.clientId);
    if (!node) {
      node = createScoreNode(r);
      state.scoreNodeMap.set(r.clientId, node);
    }
    if (node.parentNode !== container) {
      allMounted = false;
    }
    node.classList.toggle('is-self', r.clientId === state.clientId);
    const rankEl = node.querySelector('.rank-num');
    const nameEl = node.querySelector('.score-name');
    const ptsEl = node.querySelector('.score-pts');

    rankEl.textContent = `#${r.rank}`;
    nameEl.textContent = r.clientId === state.clientId ? `${r.nickname} (我)` : r.nickname;
    ptsEl.textContent = `${r.score} 分`;

    orderedNodes.push(node);
  }

  const signature = rankings.map((r) => `${r.clientId}:${r.score}`).join('|');
  const applyOrder = () => reorderContainerNodes(container, orderedNodes);

  if (allMounted && signature !== state.lastRankSignature && rankings.length > 1) {
    state.lastRankSignature = signature;
    let vt = null;
    if (typeof container.startViewTransition === 'function') {
      vt = container.startViewTransition(applyOrder);
    } else if (typeof document.startViewTransition === 'function') {
      vt = document.startViewTransition(applyOrder);
    } else {
      applyOrder();
    }
    vt?.finished?.catch(() => {});
    const leader = rankings[0];
    if (leader) {
      els.scoreboardStatus.textContent = `积分榜更新：当前第 1 名 ${leader.nickname}，${leader.score} 分`;
    }
  } else {
    state.lastRankSignature = signature;
    applyOrder();
  }
}

function renderFeed(feed) {
  els.guessFeed.innerHTML = '';
  for (const item of feed) {
    const li = document.createElement('li');
    li.className = 'feed-entry';

    if (item.type === 'correct_guess') {
      li.classList.add('feed-correct');
      li.textContent = item.text;
    } else if (item.type === 'round_timeout') {
      li.classList.add('feed-timeout');
      li.textContent = item.text;
    } else if (item.type === 'system') {
      li.classList.add('feed-system');
      li.textContent = item.text;
    } else if (item.type === 'wrong_guess') {
      const author = document.createElement('span');
      author.className = 'feed-author';
      author.textContent = `${item.nickname} 猜：`;
      const body = document.createElement('span');
      body.textContent = item.text;
      li.append(author, body);
    } else {
      const author = document.createElement('span');
      author.className = 'feed-author';
      author.textContent = `${item.nickname}：`;
      const body = document.createElement('span');
      body.textContent = item.text;
      li.append(author, body);
    }

    els.guessFeed.append(li);
  }
  els.guessFeed.scrollTop = els.guessFeed.scrollHeight;
}

function renderResult(room) {
  const rankings = room.rankings || [];
  const champion = rankings[0];
  els.resultChampionTitle.textContent = champion
    ? `冠军：${champion.nickname}（${champion.score} 分）`
    : '十轮最终排名';

  const medals = ['第 1 名', '第 2 名', '第 3 名'];
  els.podiumGrid.innerHTML = '';
  rankings.slice(0, 3).forEach((r, idx) => {
    const card = document.createElement('div');
    card.className = `podium-card rank-${r.rank}`;

    const medal = document.createElement('div');
    medal.className = 'podium-medal';
    medal.textContent = `第 ${r.rank} 名` || medals[idx];

    const name = document.createElement('div');
    name.className = 'podium-name';
    name.textContent = r.clientId === state.clientId ? `${r.nickname} (我)` : r.nickname;

    const score = document.createElement('div');
    score.className = 'podium-score';
    score.textContent = `${r.score} 分 · 猜对 ${r.correctCount} 首`;

    card.append(medal, name, score);
    els.podiumGrid.append(card);
  });

  els.finalRankingTbody.innerHTML = '';
  for (const r of rankings) {
    const tr = document.createElement('tr');

    const rankTh = document.createElement('th');
    rankTh.textContent = `第 ${r.rank} 名`;

    const nameTd = document.createElement('td');
    nameTd.textContent = r.clientId === state.clientId ? `${r.nickname} (我)` : r.nickname;

    const scoreTd = document.createElement('td');
    scoreTd.textContent = `${r.score} 分`;

    const countTd = document.createElement('td');
    countTd.textContent = `${r.correctCount} 首`;

    const timeTd = document.createElement('td');
    timeTd.textContent = r.correctCount > 0 ? formatDurationMs(r.totalCorrectTimeMs) : '--';

    tr.append(rankTh, nameTd, scoreTd, countTd, timeTd);
    els.finalRankingTbody.append(tr);
  }

  els.roundHistoryList.innerHTML = '';
  for (const h of room.history || []) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const num = document.createElement('span');
    num.className = 'history-round-num';
    num.textContent = String(h.roundNumber);

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const song = document.createElement('div');
    song.className = 'history-song';
    song.textContent = `《${h.canonicalTitle}》 - ${h.singerName}`;

    const sub = document.createElement('div');
    sub.className = 'history-sub';
    const winnerPart = h.winnerNickname
      ? `${h.winnerNickname} 猜中 (+1分)`
      : h.reason === 'skipped'
        ? '投票跳过'
        : '时间到未猜出';
    sub.textContent = `起点 ${formatSeconds(h.startOffset)} (${h.startPercent}%) · ${winnerPart}`;

    meta.append(song, sub);
    li.append(num, meta);
    els.roundHistoryList.append(li);
  }
}

// ==================== TIMERS TICK ====================
function startGlobalTick() {
  if (state.timerRaf) return;
  const tick = () => {
    const room = state.room;
    if (!room) {
      state.timerRaf = null;
      return;
    }

    if (room.status === 'countdown' && room.countdownEndsAt) {
      const rem = Math.max(1, Math.ceil((room.countdownEndsAt - Date.now()) / 1000));
      els.countdownPill.textContent = String(rem);
    }

    if (room.status === 'playing' && room.activeRound?.endsAt) {
      const remSec = Math.max(0, Math.ceil((room.activeRound.endsAt - Date.now()) / 1000));
      els.roundTimerText.textContent = `${remSec}s`;
    } else if (room.status === 'round_reveal') {
      els.roundTimerText.textContent = '揭晓中';
    } else {
      els.roundTimerText.textContent = '--';
    }

    state.timerRaf = setTimeout(tick, 250);
  };
  tick();
}

// ==================== EVENT LISTENERS ====================
els.nicknameInput.addEventListener('input', () => {
  els.nicknameInput.setCustomValidity('');
  els.nicknameInput.removeAttribute('aria-invalid');
  els.nicknameError.textContent = '';
});

els.roomCodeInput.addEventListener('input', () => {
  els.roomCodeInput.setCustomValidity('');
  els.roomCodeInput.removeAttribute('aria-invalid');
  els.roomCodeError.textContent = '';
});

els.createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = getValidatedNickname();
  if (!nickname) return;

  unlockAudioElement();
  const data = new FormData(els.createForm);
  sendWs({
    type: 'create_room',
    clientId: state.clientId,
    nickname,
    roomName: String(data.get('roomName') || '').trim(),
    category: String(data.get('category') || 'all'),
    roundDurationSec: Number(data.get('roundDurationSec') || 45),
    isPublic: true,
    authTicket: state.vipAuth?.authTicket || undefined
  });
});

els.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = getValidatedNickname();
  if (!nickname) return;

  const code = els.roomCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    els.roomCodeInput.setCustomValidity('请输入 6 位数字房间号');
    els.roomCodeInput.setAttribute('aria-invalid', 'true');
    els.roomCodeError.textContent = '请输入 6 位数字房间号';
    els.roomCodeInput.focus();
    return;
  }

  unlockAudioElement();
  sendWs({
    type: 'join_room',
    code,
    clientId: state.clientId,
    nickname
  });
});

els.refreshRoomsBtn.addEventListener('click', refreshPublicRooms);

els.copyCodeBtn.addEventListener('click', async () => {
  if (!state.room?.code) return;
  const inviteUrl = `${location.origin}/?room=${state.room.code}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    showToast(`已复制邀请链接（房间号 ${state.room.code}）`);
  } catch {
    showToast(`房间号：${state.room.code}`);
  }
});

els.leaveLobbyBtn.addEventListener('click', () => sendWs({ type: 'leave_room' }));
els.leaveGameBtn.addEventListener('click', () => sendWs({ type: 'leave_room' }));
els.resultLeaveBtn.addEventListener('click', () => sendWs({ type: 'leave_room' }));

els.readyToggleBtn.addEventListener('click', () => {
  unlockAudioElement();
  sendWs({ type: 'toggle_ready' });
});

els.soloStartBtn.addEventListener('click', () => {
  unlockAudioElement();
  sendWs({ type: 'solo_start' });
});

els.addBotBtn.addEventListener('click', () => sendWs({ type: 'add_bot' }));
els.removeBotBtn.addEventListener('click', () => sendWs({ type: 'remove_bot' }));
els.skipVoteBtn.addEventListener('click', () => sendWs({ type: 'vote_skip' }));
els.playAgainBtn.addEventListener('click', () => {
  unlockAudioElement();
  sendWs({ type: 'play_again' });
});

// ==================== IME-SAFE ENTER SUBMIT (modern-web-guidance) ====================
let lastCompositionEndAt = null;

els.guessInput.addEventListener('compositionend', (event) => {
  lastCompositionEndAt = event.timeStamp;
});

els.guessInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();

    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    if (
      lastCompositionEndAt !== null &&
      Math.abs(event.timeStamp - lastCompositionEndAt) < 50
    ) {
      return;
    }

    els.guessForm.requestSubmit();
  }
});

els.guessForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.guessInput.value.trim();
  if (!text) return;
  sendWs({ type: 'submit_guess', text });
  els.guessInput.value = '';
  els.guessInput.focus();
});

// ==================== KUGOU MEMBER LOGIN (QR + TOKEN) ====================
function stopQrPolling() {
  if (state.qrPollTimer) {
    clearInterval(state.qrPollTimer);
    state.qrPollTimer = null;
  }
}

function updateHeaderVipButton() {
  if (state.vipAuth?.authTicket) {
    els.openVipBtn.textContent = `✓ ${state.vipAuth.nickname}`;
    els.openVipBtn.classList.add('btn-vip-active');
    els.vipActiveBox.hidden = false;
    els.vipActiveName.textContent = `当前已登录：${state.vipAuth.nickname}`;
  } else {
    els.openVipBtn.textContent = '会员登录';
    els.openVipBtn.classList.remove('btn-vip-active');
    els.vipActiveBox.hidden = true;
  }
}

function applyAuthorizedSession(authData) {
  stopQrPolling();
  state.vipAuth = {
    authTicket: authData.authTicket,
    nickname: authData.nickname,
    userid: authData.userid
  };
  sessionStorage.setItem('kugou_vip_auth', JSON.stringify(state.vipAuth));
  updateHeaderVipButton();

  if (state.room?.code) {
    sendWs({ type: 'bind_vip', authTicket: state.vipAuth.authTicket });
  }
  if (els.vipDialog.open) {
    els.vipDialog.close();
  }
  showToast(`已登录酷狗账号：${state.vipAuth.nickname}`);
}

async function startQrLoginFlow() {
  stopQrPolling();
  state.qrKey = '';
  els.qrCodeImg.hidden = true;
  els.qrPlaceholder.hidden = false;
  els.qrPlaceholder.textContent = '正在获取二维码…';
  els.qrStatusText.textContent = '正在连接酷狗登录服务…';

  try {
    const res = await fetch(apiUrl('/api/kugou/qr/create'), { method: 'POST' });
    const data = await res.json();
    if (!data.ok || !data.qrKey) {
      els.qrPlaceholder.textContent = '获取失败';
      els.qrStatusText.textContent = data.error || '无法获取二维码，请重试';
      return;
    }

    state.qrKey = data.qrKey;
    els.qrCodeImg.src = data.qrImgBase64;
    els.qrCodeImg.hidden = false;
    els.qrPlaceholder.hidden = true;
    els.qrStatusText.textContent = '请打开手机「酷狗音乐 APP」扫一扫登录';

    state.qrPollTimer = setInterval(async () => {
      if (!els.vipDialog.open || !state.qrKey) {
        stopQrPolling();
        return;
      }
      try {
        const chkRes = await fetch(
          apiUrl(`/api/kugou/qr/check?key=${encodeURIComponent(state.qrKey)}`)
        );
        const chk = await chkRes.json();
        if (!chk.ok) return;

        if (chk.state === 'expired') {
          stopQrPolling();
          els.qrStatusText.textContent = '二维码已过期，请点击下方按钮刷新';
        } else if (chk.state === 'scanned') {
          els.qrStatusText.textContent = chk.nickname
            ? `${chk.nickname} 已扫码，请在手机上点击确认登录`
            : '已扫码，请在手机上点击确认登录';
        } else if (chk.state === 'authorized' && chk.authTicket) {
          applyAuthorizedSession(chk);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 2000);
  } catch {
    els.qrPlaceholder.textContent = '网络异常';
    els.qrStatusText.textContent = '连接登录接口失败，请稍后重试';
  }
}

els.openVipBtn.addEventListener('click', () => {
  setTimeout(() => {
    if (els.vipDialog.open) startQrLoginFlow();
  }, 20);
});

els.lobbyVipBtn.addEventListener('click', () => {
  setTimeout(() => {
    if (els.vipDialog.open) startQrLoginFlow();
  }, 20);
});

els.refreshQrBtn.addEventListener('click', startQrLoginFlow);

els.vipDialog.addEventListener('close', () => {
  stopQrPolling();
});

els.unbindVipBtn.addEventListener('click', () => {
  sendWs({ type: 'unbind_vip' });
});

els.logoutVipBtn.addEventListener('click', async () => {
  const prevTicket = state.vipAuth?.authTicket;
  state.vipAuth = null;
  sessionStorage.removeItem('kugou_vip_auth');
  updateHeaderVipButton();

  if (state.room?.code) {
    sendWs({ type: 'unbind_vip' });
  }
  if (prevTicket) {
    fetch(apiUrl('/api/kugou/auth/logout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authTicket: prevTicket })
    }).catch(() => {});
  }
  showToast('已退出酷狗账号');
});

els.manualVipForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.vipFormError.textContent = '';

  const cookie = els.vipCookieInput.value.trim();
  const userid = els.vipUseridInput.value.trim();
  const token = els.vipTokenInput.value.trim();

  if (!cookie && (!userid || !token)) {
    els.vipFormError.textContent = '请粘贴完整 Cookie，或同时填写 userid 与 token';
    return;
  }

  try {
    const res = await fetch(apiUrl('/api/kugou/auth/manual'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, userid, token })
    });
    const data = await res.json();
    if (!data.ok || !data.authTicket) {
      els.vipFormError.textContent = data.error || '凭证校验失败';
      return;
    }
    els.vipCookieInput.value = '';
    els.vipTokenInput.value = '';
    applyAuthorizedSession(data);
  } catch {
    els.vipFormError.textContent = '请求失败，请检查网络连接';
  }
});

// ==================== INITIAL DATA FETCH ====================
async function refreshHealth() {
  try {
    const res = await fetch(apiUrl('/api/health'));
    const data = await res.json();
    if (data.ok) {
      const freeCount = data.uniqueSongs || data.poolSize;
      const allCount = data.totalWithVipUniqueSongs || freeCount;
      els.poolBadge.textContent =
        allCount > freeCount
          ? `免费 ${freeCount} 首 · VIP全库 ${allCount} 首`
          : `已收录 ${freeCount} 首`;
    } else {
      els.poolBadge.textContent = '曲库同步中';
    }
  } catch {
    els.poolBadge.textContent = '曲库连接中';
  }
}

async function refreshPublicRooms() {
  try {
    const res = await fetch(apiUrl('/api/rooms'));
    const data = await res.json();
    const rooms = data.rooms || [];

    els.publicRoomsList.innerHTML = '';
    if (rooms.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted-empty';
      p.textContent = '暂无公开房间';
      els.publicRoomsList.append(p);
      return;
    }

    for (const r of rooms) {
      const item = document.createElement('div');
      item.className = 'public-room-item';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'public-room-title';
      title.textContent = `${r.name} (#${r.code})`;

      const meta = document.createElement('div');
      meta.className = 'public-room-meta';
      const statusText =
        r.status === 'waiting'
          ? '等待中'
          : r.status === 'finished'
            ? '已结束'
            : `第 ${r.currentRound}/${r.totalRounds} 轮`;
      meta.textContent = `${r.playerCount}/${r.maxPlayers} 人 · ${CATEGORY_LABELS[r.category] || '全部华语'} · ${statusText}`;

      info.append(title, meta);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline btn-sm';
      btn.textContent = '加入';
      btn.addEventListener('click', () => {
        const nickname = getValidatedNickname();
        if (!nickname) return;
        unlockAudioElement();
        sendWs({
          type: 'join_room',
          code: r.code,
          clientId: state.clientId,
          nickname
        });
      });

      item.append(info, btn);
      els.publicRoomsList.append(item);
    }
  } catch {
    // Ignore transient fetch errors
  }
}

function initApp() {
  setupNativeDialogEnhancements();

  const savedNick = sessionStorage.getItem('kugou_guess_nickname');
  if (savedNick) {
    els.nicknameInput.value = savedNick;
  }

  try {
    const savedVip = JSON.parse(sessionStorage.getItem('kugou_vip_auth') || 'null');
    if (savedVip?.authTicket) {
      state.vipAuth = savedVip;
    }
  } catch {
    // Ignore corrupted storage
  }
  updateHeaderVipButton();

  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  if (roomParam && /^\d{6}$/.test(roomParam)) {
    els.roomCodeInput.value = roomParam;
  }

  connectWebSocket();
  refreshHealth();
  setTimeout(refreshHealth, 4000);
  setTimeout(refreshHealth, 9000);
  refreshPublicRooms();
  setInterval(() => {
    if (!state.room) refreshPublicRooms();
  }, 6000);
}

initApp();

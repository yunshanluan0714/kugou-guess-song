import crypto from 'node:crypto';
import { computeRankings, isSongNameMatch } from './songUtils.js';
import { kugouAuth } from './kugouAuth.js';

const AVATAR_COLORS = [
  '#ff4d6d',
  '#ff8a00',
  '#00bbf9',
  '#00f5d4',
  '#9b5de5',
  '#f15bb5',
  '#38b000',
  '#ffb703'
];

const BOT_PROFILES = [
  { name: '华语歌神·阿杰', color: '#00bbf9' },
  { name: '旋律捕手·小美', color: '#f15bb5' },
  { name: '金曲百科·老陈', color: '#ffb703' }
];

const BOT_WRONG_GUESSES = [
  '晴天',
  '七里香',
  '十年',
  '泡沫',
  '后来',
  '演员',
  '起风了',
  '海阔天空',
  '小幸运',
  '成都',
  '红豆',
  '平凡之路'
];

const VALID_CATEGORIES = ['all', 'classic', 'chart', 'folk_rock', 'cantonese_ost'];

export const TOTAL_ROUNDS = 10;

export class RoomManager {
  constructor(musicService, options = {}) {
    this.musicService = musicService;
    this.authManager = options.authManager ?? kugouAuth;
    this.totalRounds = options.totalRounds ?? TOTAL_ROUNDS;
    this.countdownMs = options.countdownMs ?? 3000;
    this.revealMs = options.revealMs ?? 4500;
    this.rooms = new Map();
    this.socketBindings = new Map(); // ws -> { roomCode, clientId }
  }

  _generateRoomCode() {
    for (let i = 0; i < 50; i += 1) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.rooms.has(code)) return code;
    }
    return String(Date.now()).slice(-6);
  }

  _pickAvatarColor(index) {
    return AVATAR_COLORS[index % AVATAR_COLORS.length];
  }

  _pushFeed(room, item) {
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...item
    };
    room.feed.push(entry);
    if (room.feed.length > 60) {
      room.feed = room.feed.slice(-60);
    }
    return entry;
  }

  _send(ws, payload) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore closed socket write errors
    }
  }

  _broadcast(room, payload) {
    const raw = JSON.stringify(payload);
    for (const player of room.players) {
      if (player.ws && player.ws.readyState === 1) {
        try {
          player.ws.send(raw);
        } catch {
          // Ignore individual socket failure
        }
      }
    }
  }

  _clearTimers(room) {
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    if (room.nextRoundTimer) {
      clearTimeout(room.nextRoundTimer);
      room.nextRoundTimer = null;
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
    this._clearBotTimers(room);
  }

  _clearBotTimers(room) {
    if (Array.isArray(room.botTimers)) {
      for (const t of room.botTimers) clearTimeout(t);
    }
    room.botTimers = [];
  }

  getPublicRooms() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic) continue;
      const activePlayers = room.players.filter((p) => p.connected || p.isBot);
      if (activePlayers.length === 0) continue;
      list.push({
        code: room.code,
        name: room.name,
        status: room.status,
        category: room.category,
        roundDurationSec: room.roundDurationSec,
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
        playerCount: activePlayers.length,
        readyCount: activePlayers.filter((p) => p.ready).length,
        maxPlayers: 8
      });
    }
    return list.sort((a, b) => b.playerCount - a.playerCount);
  }

  serializeRoom(room) {
    const activePlayers = room.players.filter((p) => p.connected || p.isBot);
    const rankings = computeRankings(activePlayers);

    let roundPublic = null;
    if (room.activeRound) {
      if (room.status === 'playing' || room.status === 'loading_round') {
        roundPublic = {
          roundNumber: room.activeRound.roundNumber,
          totalRounds: room.totalRounds,
          audioUrl: `/api/rooms/${room.code}/audio?round=${room.activeRound.roundNumber}&token=${room.activeRound.audioToken}`,
          duration: room.activeRound.duration,
          startOffset: room.activeRound.startOffset,
          startPercent: room.activeRound.startPercent,
          startedAt: room.activeRound.startedAt,
          endsAt: room.activeRound.endsAt,
          titleLengthHint: room.activeRound.canonicalTitle.length,
          sourceTag: room.activeRound.sourceTag
        };
      } else if (room.status === 'round_reveal') {
        roundPublic = {
          roundNumber: room.activeRound.roundNumber,
          totalRounds: room.totalRounds,
          audioUrl: `/api/rooms/${room.code}/audio?round=${room.activeRound.roundNumber}&token=${room.activeRound.audioToken}`,
          duration: room.activeRound.duration,
          startOffset: room.activeRound.startOffset,
          startPercent: room.activeRound.startPercent,
          startedAt: room.activeRound.startedAt,
          endsAt: room.activeRound.endsAt,
          revealedSong: {
            canonicalTitle: room.activeRound.canonicalTitle,
            rawSongName: room.activeRound.rawSongName,
            singerName: room.activeRound.singerName,
            albumImg: room.activeRound.albumImg,
            sourceTag: room.activeRound.sourceTag,
            winnerClientId: room.activeRound.winnerClientId || null,
            winnerNickname: room.activeRound.winnerNickname || null,
            winTimeMs: room.activeRound.winTimeMs ?? null,
            reason: room.activeRound.reason || 'guessed'
          }
        };
      }
    }

    const humanPlayers = activePlayers.filter((p) => !p.isBot);
    const skipVotes = humanPlayers.filter((p) => p.skipVoted).length;
    const skipNeeded = Math.max(1, Math.ceil(humanPlayers.length / 2));

    const envVip = this.authManager?.getEnvDefaultSession?.() || null;
    const vipStatus = room.vipSession
      ? {
          unlocked: true,
          kugouNickname: room.vipSession.nickname,
          boundByClientId: room.vipSession.boundByClientId,
          boundByNickname: room.vipSession.boundByNickname,
          isEnvDefault: false
        }
      : {
          unlocked: Boolean(envVip),
          kugouNickname: envVip ? envVip.nickname : '',
          boundByClientId: null,
          boundByNickname: null,
          isEnvDefault: Boolean(envVip)
        };

    return {
      code: room.code,
      name: room.name,
      hostClientId: room.hostClientId,
      isPublic: room.isPublic,
      category: room.category,
      roundDurationSec: room.roundDurationSec,
      status: room.status,
      currentRound: room.currentRound,
      totalRounds: room.totalRounds,
      countdownEndsAt: room.countdownEndsAt || null,
      skipVotes,
      skipNeeded,
      vipStatus,
      players: activePlayers.map((p) => ({
        clientId: p.clientId,
        nickname: p.nickname,
        avatarColor: p.avatarColor,
        isBot: p.isBot,
        ready: p.ready,
        connected: p.connected,
        score: p.score,
        correctCount: p.correctCount,
        totalCorrectTimeMs: p.totalCorrectTimeMs,
        skipVoted: p.skipVoted,
        joinedAt: p.joinedAt
      })),
      rankings,
      activeRound: roundPublic,
      history: room.history,
      feed: room.feed.slice(-30)
    };
  }

  _broadcastState(room, eventType = 'room_state', extra = {}) {
    this._broadcast(room, {
      type: eventType,
      room: this.serializeRoom(room),
      ...extra
    });
  }

  getAudioTarget(roomCode, roundNum, token) {
    const room = this.rooms.get(String(roomCode));
    if (!room || !room.activeRound) return null;
    if (
      Number(roundNum) === room.activeRound.roundNumber &&
      token &&
      token === room.activeRound.audioToken
    ) {
      return {
        hash: room.activeRound.hash,
        streamUrl: room.activeRound.streamUrl,
        authSession: room.vipSession || null
      };
    }
    return null;
  }

  handleMessage(ws, rawMsg) {
    let msg;
    try {
      msg = JSON.parse(String(rawMsg));
    } catch {
      this._send(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }

    const type = msg?.type;
    switch (type) {
      case 'ping':
        this._send(ws, { type: 'pong', ts: Date.now() });
        break;
      case 'create_room':
        this._handleCreateRoom(ws, msg);
        break;
      case 'join_room':
        this._handleJoinRoom(ws, msg);
        break;
      case 'leave_room':
        this._handleLeaveRoom(ws);
        break;
      case 'toggle_ready':
        this._handleToggleReady(ws, msg);
        break;
      case 'solo_start':
        this._handleSoloStart(ws);
        break;
      case 'add_bot':
        this._handleAddBot(ws);
        break;
      case 'remove_bot':
        this._handleRemoveBot(ws, msg);
        break;
      case 'submit_guess':
        this._handleSubmitGuess(ws, msg);
        break;
      case 'vote_skip':
        this._handleVoteSkip(ws);
        break;
      case 'play_again':
        this._handlePlayAgain(ws);
        break;
      case 'bind_vip':
        this._handleBindVip(ws, msg);
        break;
      case 'unbind_vip':
        this._handleUnbindVip(ws);
        break;
      default:
        this._send(ws, { type: 'error', message: `未知指令: ${type}` });
    }
  }

  handleDisconnect(ws) {
    const binding = this.socketBindings.get(ws);
    if (!binding) return;
    this.socketBindings.delete(ws);

    const room = this.rooms.get(binding.roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.clientId === binding.clientId);
    if (!player) return;

    // Only disconnect if this ws is still the player's latest socket
    if (player.ws === ws) {
      player.connected = false;
      player.ws = null;
      if (room.status === 'waiting' || room.status === 'countdown') {
        player.ready = false;
      }

      this._reassignHostIfNeeded(room);
      this._pushFeed(room, {
        type: 'system',
        text: `${player.nickname} 暂时离开了房间`
      });
      this._evaluateReadyState(room);
      this._broadcastState(room);
      this._scheduleCleanupIfEmpty(room);
    }
  }

  _scheduleCleanupIfEmpty(room) {
    const hasConnectedHuman = room.players.some((p) => !p.isBot && p.connected);
    if (hasConnectedHuman) {
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }
      return;
    }

    if (!room.cleanupTimer) {
      room.cleanupTimer = setTimeout(() => {
        const stillEmpty = !room.players.some((p) => !p.isBot && p.connected);
        if (stillEmpty) {
          this._clearTimers(room);
          this.rooms.delete(room.code);
        }
      }, 60_000);
      room.cleanupTimer.unref?.();
    }
  }

  dispose() {
    for (const room of this.rooms.values()) {
      this._clearTimers(room);
    }
    this.rooms.clear();
    this.socketBindings.clear();
  }

  _reassignHostIfNeeded(room) {
    const currentHost = room.players.find(
      (p) => p.clientId === room.hostClientId && !p.isBot && p.connected
    );
    if (currentHost) return;

    const nextHuman = room.players.find((p) => !p.isBot && p.connected);
    if (nextHuman) {
      room.hostClientId = nextHuman.clientId;
    }
  }

  _detachPreviousSocket(ws) {
    const prev = this.socketBindings.get(ws);
    if (prev) {
      this.handleDisconnect(ws);
    }
  }

  _handleCreateRoom(ws, msg) {
    this._detachPreviousSocket(ws);

    const clientId = String(msg.clientId || crypto.randomUUID()).slice(0, 64);
    const nickname = String(msg.nickname || '').trim().slice(0, 16) || `歌友${clientId.slice(-4)}`;
    const code = this._generateRoomCode();
    const category = VALID_CATEGORIES.includes(msg.category) ? msg.category : 'all';
    const roundDurationSec = [30, 45, 60].includes(Number(msg.roundDurationSec))
      ? Number(msg.roundDurationSec)
      : 45;
    const isPublic = msg.isPublic !== false;
    const roomName = String(msg.roomName || '').trim().slice(0, 24) || `华语猜歌房 #${code}`;

    const hostPlayer = {
      clientId,
      nickname,
      avatarColor: this._pickAvatarColor(0),
      isBot: false,
      ready: false,
      connected: true,
      score: 0,
      correctCount: 0,
      totalCorrectTimeMs: 0,
      skipVoted: false,
      joinedAt: Date.now(),
      ws
    };

    const room = {
      code,
      name: roomName,
      hostClientId: clientId,
      isPublic,
      category,
      roundDurationSec,
      status: 'waiting',
      currentRound: 0,
      totalRounds: this.totalRounds,
      countdownEndsAt: null,
      players: [hostPlayer],
      vipSession: null,
      activeRound: null,
      history: [],
      feed: [],
      usedHashes: new Set(),
      usedCanonicalTitles: new Set(),
      countdownTimer: null,
      roundTimer: null,
      nextRoundTimer: null,
      cleanupTimer: null,
      botTimers: []
    };

    if (msg.authTicket) {
      const saved = this.authManager?.getAuthSession?.(msg.authTicket);
      if (saved) {
        room.vipSession = {
          userid: saved.userid,
          token: saved.token,
          nickname: saved.nickname,
          boundByClientId: clientId,
          boundByNickname: nickname
        };
      }
    }

    this._pushFeed(room, {
      type: 'system',
      text: `${nickname} 创建了华语猜歌房 #${code}（共 ${this.totalRounds} 轮）`
    });

    this.rooms.set(code, room);
    this.socketBindings.set(ws, { roomCode: code, clientId });
    this._send(ws, {
      type: 'joined_room',
      clientId,
      room: this.serializeRoom(room)
    });
  }

  _handleJoinRoom(ws, msg) {
    this._detachPreviousSocket(ws);

    const code = String(msg.code || '').trim();
    const room = this.rooms.get(code);
    if (!room) {
      this._send(ws, { type: 'error', message: `房间 ${code || ''} 不存在或已解散` });
      return;
    }

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }

    const clientId = String(msg.clientId || crypto.randomUUID()).slice(0, 64);
    const rawNickname = String(msg.nickname || '').trim().slice(0, 16);
    const existing = room.players.find((p) => p.clientId === clientId);

    if (existing) {
      existing.ws = ws;
      existing.connected = true;
      if (rawNickname) existing.nickname = rawNickname;
      this._reassignHostIfNeeded(room);
      this.socketBindings.set(ws, { roomCode: code, clientId });
      this._pushFeed(room, {
        type: 'system',
        text: `${existing.nickname} 重新回到房间`
      });
      this._send(ws, {
        type: 'joined_room',
        clientId,
        room: this.serializeRoom(room)
      });
      this._broadcastState(room);
      return;
    }

    const activePlayers = room.players.filter((p) => p.connected || p.isBot);
    if (activePlayers.length >= 8) {
      this._send(ws, { type: 'error', message: '该房间人数已满（最多 8 人）' });
      return;
    }

    const nickname = rawNickname || `歌友${activePlayers.length + 1}`;
    const newPlayer = {
      clientId,
      nickname,
      avatarColor: this._pickAvatarColor(room.players.length),
      isBot: false,
      ready: false,
      connected: true,
      score: 0,
      correctCount: 0,
      totalCorrectTimeMs: 0,
      skipVoted: false,
      joinedAt: Date.now(),
      ws
    };

    room.players.push(newPlayer);
    this._reassignHostIfNeeded(room);
    this.socketBindings.set(ws, { roomCode: code, clientId });

    this._pushFeed(room, {
      type: 'system',
      text: `${nickname} 加入了房间`
    });

    // If a new unready player joins during countdown, revert countdown back to waiting
    this._evaluateReadyState(room);

    this._send(ws, {
      type: 'joined_room',
      clientId,
      room: this.serializeRoom(room)
    });
    this._broadcastState(room);
  }

  _handleLeaveRoom(ws) {
    const binding = this.socketBindings.get(ws);
    if (!binding) return;
    this.socketBindings.delete(ws);

    const room = this.rooms.get(binding.roomCode);
    if (!room) return;

    const idx = room.players.findIndex((p) => p.clientId === binding.clientId);
    if (idx !== -1) {
      const [removed] = room.players.splice(idx, 1);
      this._pushFeed(room, {
        type: 'system',
        text: `${removed.nickname} 退出了房间`
      });
    }

    const hasHuman = room.players.some((p) => !p.isBot && p.connected);
    if (!hasHuman) {
      this._clearTimers(room);
      this.rooms.delete(room.code);
      this._send(ws, { type: 'left_room' });
      return;
    }

    this._reassignHostIfNeeded(room);
    this._evaluateReadyState(room);
    this._send(ws, { type: 'left_room' });
    this._broadcastState(room);
  }

  _getBinding(ws) {
    const binding = this.socketBindings.get(ws);
    if (!binding) return null;
    const room = this.rooms.get(binding.roomCode);
    if (!room) return null;
    const player = room.players.find((p) => p.clientId === binding.clientId);
    if (!player) return null;
    return { room, player };
  }

  _handleToggleReady(ws, msg) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room, player } = ctx;

    if (room.status !== 'waiting' && room.status !== 'countdown') {
      return;
    }

    player.ready = typeof msg.ready === 'boolean' ? msg.ready : !player.ready;
    this._pushFeed(room, {
      type: 'system',
      text: player.ready ? `${player.nickname} 已准备就绪` : `${player.nickname} 取消了准备`
    });

    this._evaluateReadyState(room);
    this._broadcastState(room);
  }

  _handleSoloStart(ws) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room, player } = ctx;

    if (room.status !== 'waiting') return;
    const activePlayers = room.players.filter((p) => p.connected || p.isBot);
    if (activePlayers.length !== 1 || !player.ready) {
      this._send(ws, {
        type: 'error',
        message: '多人房间需要所有玩家点击准备就绪后自动开始'
      });
      return;
    }

    this._beginCountdown(room, true);
    this._broadcastState(room);
  }

  _handleAddBot(ws) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room } = ctx;

    if (room.status !== 'waiting' && room.status !== 'countdown') return;
    const activePlayers = room.players.filter((p) => p.connected || p.isBot);
    if (activePlayers.length >= 8) {
      this._send(ws, { type: 'error', message: '房间已满（最多 8 人）' });
      return;
    }

    const existingBots = room.players.filter((p) => p.isBot);
    if (existingBots.length >= 3) {
      this._send(ws, { type: 'error', message: '最多可添加 3 位 AI 歌友' });
      return;
    }

    const profile = BOT_PROFILES[existingBots.length % BOT_PROFILES.length];
    const bot = {
      clientId: `bot_${crypto.randomUUID().slice(0, 8)}`,
      nickname: profile.name,
      avatarColor: profile.color,
      isBot: true,
      ready: true,
      connected: true,
      score: 0,
      correctCount: 0,
      totalCorrectTimeMs: 0,
      skipVoted: false,
      joinedAt: Date.now(),
      ws: null
    };

    room.players.push(bot);
    this._pushFeed(room, {
      type: 'system',
      text: `🤖 ${bot.nickname} 加入房间（已自动准备）`
    });

    this._evaluateReadyState(room);
    this._broadcastState(room);
  }

  _handleRemoveBot(ws, msg) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room } = ctx;
    if (room.status !== 'waiting' && room.status !== 'countdown') return;

    const botId = msg?.botClientId;
    const idx = botId
      ? room.players.findIndex((p) => p.isBot && p.clientId === botId)
      : room.players.findLastIndex((p) => p.isBot);

    if (idx === -1) return;
    const [removed] = room.players.splice(idx, 1);
    this._pushFeed(room, {
      type: 'system',
      text: `移除了 AI 歌友 ${removed.nickname}`
    });

    this._evaluateReadyState(room);
    this._broadcastState(room);
  }

  _handleBindVip(ws, msg) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room, player } = ctx;

    const session = this.authManager?.getAuthSession?.(msg?.authTicket);
    if (!session) {
      this._send(ws, { type: 'error', message: '会员登录凭证已失效，请重新扫码或绑定' });
      return;
    }

    room.vipSession = {
      userid: session.userid,
      token: session.token,
      nickname: session.nickname,
      boundByClientId: player.clientId,
      boundByNickname: player.nickname
    };

    this._pushFeed(room, {
      type: 'system',
      text: `${player.nickname} 已登录酷狗账号（${session.nickname}），本房间已开启会员实时拉取`
    });
    this._broadcastState(room, 'vip_updated');
  }

  _handleUnbindVip(ws) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room, player } = ctx;
    if (!room.vipSession) return;

    if (
      room.vipSession.boundByClientId !== player.clientId &&
      room.hostClientId !== player.clientId
    ) {
      this._send(ws, { type: 'error', message: '仅绑定者或房主可解除会员绑定' });
      return;
    }

    room.vipSession = null;
    this._pushFeed(room, {
      type: 'system',
      text: `${player.nickname} 已解除酷狗会员绑定，恢复默认免费华语曲库`
    });
    this._broadcastState(room, 'vip_updated');
  }

  _evaluateReadyState(room) {
    if (room.status !== 'waiting' && room.status !== 'countdown') return;

    const activePlayers = room.players.filter((p) => p.connected || p.isBot);
    const allReady = activePlayers.length >= 2 && activePlayers.every((p) => p.ready);

    if (allReady && room.status === 'waiting') {
      this._beginCountdown(room, false);
    } else if (!allReady && room.status === 'countdown') {
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
      room.status = 'waiting';
      room.countdownEndsAt = null;
      this._pushFeed(room, {
        type: 'system',
        text: '有玩家未准备，倒计时已取消'
      });
    }
  }

  _beginCountdown(room, allowSolo = false) {
    if (room.countdownTimer) clearTimeout(room.countdownTimer);
    room.status = 'countdown';
    room.countdownEndsAt = Date.now() + this.countdownMs;

    this._pushFeed(room, {
      type: 'system',
      text: '所有人准备就绪！游戏即将开始！'
    });

    room.countdownTimer = setTimeout(() => {
      room.countdownTimer = null;
      const activePlayers = room.players.filter((p) => p.connected || p.isBot);
      const minRequired = allowSolo ? 1 : 2;
      if (activePlayers.length < minRequired || !activePlayers.every((p) => p.ready)) {
        room.status = 'waiting';
        room.countdownEndsAt = null;
        this._broadcastState(room);
        return;
      }

      // Reset match stats and start round 1
      room.currentRound = 0;
      room.history = [];
      room.usedHashes.clear();
      room.usedCanonicalTitles.clear();
      for (const p of room.players) {
        p.score = 0;
        p.correctCount = 0;
        p.totalCorrectTimeMs = 0;
        p.skipVoted = false;
      }
      this._startNextRound(room);
    }, this.countdownMs);
  }

  async _startNextRound(room) {
    if (!this.rooms.has(room.code)) return;
    this._clearBotTimers(room);

    room.currentRound += 1;
    room.status = 'loading_round';
    room.countdownEndsAt = null;
    for (const p of room.players) {
      p.skipVoted = false;
    }
    this._broadcastState(room);

    try {
      const song = await this.musicService.pickPlayableRoundSong({
        usedHashes: room.usedHashes,
        usedCanonicalTitles: room.usedCanonicalTitles,
        category: room.category,
        authSession: room.vipSession
      });

      if (!this.rooms.has(room.code)) return;

      room.usedHashes.add(song.hash);
      room.usedCanonicalTitles.add(song.normalizedCanonical);

      const startedAt = Date.now();
      const endsAt = startedAt + room.roundDurationSec * 1000;
      const audioToken = crypto.randomBytes(12).toString('hex');

      room.activeRound = {
        roundNumber: room.currentRound,
        audioToken,
        hash: song.hash,
        streamUrl: song.streamUrl,
        canonicalTitle: song.canonicalTitle,
        rawSongName: song.rawSongName,
        singerName: song.singerName,
        albumImg: song.albumImg,
        duration: song.duration,
        startOffset: song.startOffset,
        startPercent: song.startPercent,
        sourceTag: song.sourceTag,
        startedAt,
        endsAt,
        winnerClientId: null,
        winnerNickname: null,
        winTimeMs: null,
        reason: null
      };

      room.status = 'playing';
      this._pushFeed(room, {
        type: 'system',
        text: `🎵 第 ${room.currentRound}/${room.totalRounds} 轮开始！从全曲 ${song.startPercent}% 处随机播放（歌名 ${song.canonicalTitle.length} 个字）`
      });

      this._broadcastState(room, 'round_start');

      room.roundTimer = setTimeout(() => {
        this._endRoundTimeoutOrSkip(room, 'timeout');
      }, room.roundDurationSec * 1000);

      this._scheduleBotGuesses(room);
    } catch (err) {
      room.status = 'waiting';
      room.currentRound = Math.max(0, room.currentRound - 1);
      for (const p of room.players) {
        if (!p.isBot) p.ready = false;
      }
      this._pushFeed(room, {
        type: 'system',
        text: `⚠️ 曲库加载失败：${err?.message || '网络异常'}`
      });
      this._broadcastState(room, 'error', {
        message: err?.message || '酷狗华语曲库拉取失败'
      });
    }
  }

  _scheduleBotGuesses(room) {
    const bots = room.players.filter((p) => p.isBot);
    if (bots.length === 0 || !room.activeRound) return;

    const roundSnapshot = room.activeRound;
    const roundMs = room.roundDurationSec * 1000;

    bots.forEach((bot, idx) => {
      // One realistic wrong guess early
      const wrongDelay = Math.min(roundMs - 4000, 5000 + idx * 3000 + Math.random() * 6000);
      if (wrongDelay > 1000) {
        const wrongTimer = setTimeout(() => {
          if (room.status !== 'playing' || room.activeRound !== roundSnapshot) return;
          const candidates = BOT_WRONG_GUESSES.filter(
            (t) => t !== roundSnapshot.canonicalTitle
          );
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          this._processGuess(room, bot, pick);
        }, wrongDelay);
        room.botTimers.push(wrongTimer);
      }

      // 65% chance to guess correctly between 45% and 85% of the round duration
      if (Math.random() < 0.65) {
        const minMs = Math.max(12000, roundMs * 0.45);
        const maxMs = Math.max(minMs + 1000, roundMs * 0.85);
        const winDelay = minMs + Math.random() * (maxMs - minMs) + idx * 1200;
        if (winDelay < roundMs - 1000) {
          const winTimer = setTimeout(() => {
            if (room.status !== 'playing' || room.activeRound !== roundSnapshot) return;
            this._processGuess(room, bot, roundSnapshot.canonicalTitle);
          }, winDelay);
          room.botTimers.push(winTimer);
        }
      }
    });
  }

  _handleSubmitGuess(ws, msg) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room, player } = ctx;

    const text = String(msg?.text || '').trim().slice(0, 40);
    if (!text) return;

    if (room.status !== 'playing' || !room.activeRound) {
      const feedItem = this._pushFeed(room, {
        type: 'chat',
        nickname: player.nickname,
        avatarColor: player.avatarColor,
        text
      });
      this._broadcast(room, { type: 'feed_item', item: feedItem });
      return;
    }

    const result = this._processGuess(room, player, text);
    this._send(ws, {
      type: 'guess_result',
      correct: result.correct,
      text,
      songTitle: result.correct ? room.activeRound?.canonicalTitle : undefined
    });
  }

  _processGuess(room, player, text) {
    if (room.status !== 'playing' || !room.activeRound) {
      return { correct: false };
    }

    const matched = isSongNameMatch(text, room.activeRound);
    if (!matched) {
      const feedItem = this._pushFeed(room, {
        type: 'wrong_guess',
        nickname: player.nickname,
        avatarColor: player.avatarColor,
        text
      });
      this._broadcast(room, { type: 'feed_item', item: feedItem });
      return { correct: false };
    }

    // Correct match! End this round immediately and award +1 point
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    this._clearBotTimers(room);

    const winTimeMs = Math.max(100, Date.now() - room.activeRound.startedAt);
    player.score += 1;
    player.correctCount += 1;
    player.totalCorrectTimeMs += winTimeMs;

    room.activeRound.winnerClientId = player.clientId;
    room.activeRound.winnerNickname = player.nickname;
    room.activeRound.winTimeMs = winTimeMs;
    room.activeRound.reason = 'guessed';
    room.status = 'round_reveal';

    room.history.push({
      roundNumber: room.activeRound.roundNumber,
      canonicalTitle: room.activeRound.canonicalTitle,
      rawSongName: room.activeRound.rawSongName,
      singerName: room.activeRound.singerName,
      albumImg: room.activeRound.albumImg,
      duration: room.activeRound.duration,
      startOffset: room.activeRound.startOffset,
      startPercent: room.activeRound.startPercent,
      winnerClientId: player.clientId,
      winnerNickname: player.nickname,
      winTimeMs,
      reason: 'guessed'
    });

    this._pushFeed(room, {
      type: 'correct_guess',
      nickname: player.nickname,
      avatarColor: player.avatarColor,
      songTitle: room.activeRound.canonicalTitle,
      singerName: room.activeRound.singerName,
      winTimeMs,
      text: `🎯 ${player.nickname} 猜中《${room.activeRound.canonicalTitle}》！本轮结束，+1 分！`
    });

    this._broadcastState(room, 'round_reveal');
    this._schedulePostReveal(room);
    return { correct: true };
  }

  _handleVoteSkip(ws) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.status !== 'playing' || !room.activeRound || player.isBot) return;

    player.skipVoted = !player.skipVoted;
    const humanPlayers = room.players.filter((p) => !p.isBot && p.connected);
    const skipVotes = humanPlayers.filter((p) => p.skipVoted).length;
    const skipNeeded = Math.max(1, Math.ceil(humanPlayers.length / 2));

    this._pushFeed(room, {
      type: 'system',
      text: `${player.nickname} ${player.skipVoted ? '投票跳过本轮' : '取消了跳过投票'} (${skipVotes}/${skipNeeded})`
    });

    if (skipVotes >= skipNeeded) {
      this._endRoundTimeoutOrSkip(room, 'skipped');
    } else {
      this._broadcastState(room);
    }
  }

  _endRoundTimeoutOrSkip(room, reason) {
    if (room.status !== 'playing' || !room.activeRound) return;

    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    this._clearBotTimers(room);

    room.status = 'round_reveal';
    room.activeRound.reason = reason;

    room.history.push({
      roundNumber: room.activeRound.roundNumber,
      canonicalTitle: room.activeRound.canonicalTitle,
      rawSongName: room.activeRound.rawSongName,
      singerName: room.activeRound.singerName,
      albumImg: room.activeRound.albumImg,
      duration: room.activeRound.duration,
      startOffset: room.activeRound.startOffset,
      startPercent: room.activeRound.startPercent,
      winnerClientId: null,
      winnerNickname: null,
      winTimeMs: null,
      reason
    });

    this._pushFeed(room, {
      type: 'round_timeout',
      songTitle: room.activeRound.canonicalTitle,
      singerName: room.activeRound.singerName,
      text:
        reason === 'skipped'
          ? `⏭️ 大家跳过本轮，答案揭晓：《${room.activeRound.canonicalTitle}》- ${room.activeRound.singerName}`
          : `⏱️ 本轮时间到，无人猜中！答案：《${room.activeRound.canonicalTitle}》- ${room.activeRound.singerName}`
    });

    this._broadcastState(room, 'round_reveal');
    this._schedulePostReveal(room);
  }

  _schedulePostReveal(room) {
    if (room.nextRoundTimer) clearTimeout(room.nextRoundTimer);
    room.nextRoundTimer = setTimeout(() => {
      room.nextRoundTimer = null;
      if (!this.rooms.has(room.code)) return;

      if (room.currentRound < room.totalRounds) {
        this._startNextRound(room);
      } else {
        this._finishGame(room);
      }
    }, this.revealMs);
  }

  _finishGame(room) {
    this._clearTimers(room);
    room.status = 'finished';
    room.activeRound = null;
    for (const p of room.players) {
      if (!p.isBot) p.ready = false;
      p.skipVoted = false;
    }

    const activePlayers = room.players.filter((p) => p.connected || p.isBot);
    const rankings = computeRankings(activePlayers);
    const champion = rankings[0];

    this._pushFeed(room, {
      type: 'system',
      text: champion
        ? `🏆 十轮比赛结束！冠军：${champion.nickname}（${champion.score} 分）`
        : '🏆 十轮比赛结束！'
    });

    this._broadcastState(room, 'game_finished', { rankings });
  }

  _handlePlayAgain(ws) {
    const ctx = this._getBinding(ws);
    if (!ctx) return;
    const { room } = ctx;
    if (room.status !== 'finished') return;

    this._clearTimers(room);
    room.status = 'waiting';
    room.currentRound = 0;
    room.activeRound = null;
    room.history = [];
    room.usedHashes.clear();
    room.usedCanonicalTitles.clear();

    for (const p of room.players) {
      p.score = 0;
      p.correctCount = 0;
      p.totalCorrectTimeMs = 0;
      p.skipVoted = false;
      p.ready = p.isBot;
    }

    this._pushFeed(room, {
      type: 'system',
      text: '🔄 已开启新一局，请所有人点击准备就绪！'
    });
    this._broadcastState(room);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  computeRankings,
  extractCanonicalTitle,
  isSongNameMatch,
  isValidMandarinSong,
  pickRandomFirstHalfOffset
} from '../src/songUtils.js';
import { kugouService } from '../src/kugouService.js';
import { KuGouAuthManager, parseCookieCredentials } from '../src/kugouAuth.js';
import { createAppServer } from '../server.js';

// ==================== 1. UNIT TESTS: songUtils ====================
test('extractCanonicalTitle strips Live/bracket/feat suffixes cleanly', () => {
  assert.equal(extractCanonicalTitle('起风了 (Live)'), '起风了');
  assert.equal(extractCanonicalTitle('窗外的泪光 (烟嗓版)'), '窗外的泪光');
  assert.equal(extractCanonicalTitle('《晴天》'), '晴天');
  assert.equal(extractCanonicalTitle('后来 (2010音乐万万岁现场) [经典]'), '后来');
  assert.equal(extractCanonicalTitle('海阔天空 - Live版'), '海阔天空');
  assert.equal(extractCanonicalTitle('珊瑚海 feat. 梁心颐'), '珊瑚海');
});

test('isValidMandarinSong accepts playable Mandarin songs and rejects VIP/foreign/instrumental tracks', () => {
  // Valid free Mandarin tracks (privilege 0 or 8)
  assert.equal(
    isValidMandarinSong({
      songname: '起风了 (Live)',
      singername: '林俊杰',
      privilege: 8,
      duration: 309
    }),
    true
  );
  assert.equal(
    isValidMandarinSong({
      songname: '日不落',
      singername: '蔡依林',
      privilege: 0,
      duration: 226
    }),
    true
  );

  // Reject paid VIP tracks (privilege 10)
  assert.equal(
    isValidMandarinSong({
      songname: '晴天',
      singername: '周杰伦',
      privilege: 10,
      duration: 269
    }),
    false
  );

  // Reject Korean / Japanese / English-only songs
  assert.equal(
    isValidMandarinSong({
      songname: '연애의 조건 (恋爱的条件)',
      singername: 'BESTie',
      privilege: 8,
      duration: 200
    }),
    false
  );
  assert.equal(
    isValidMandarinSong({
      songname: 'Lemon (米津玄师)',
      singername: '米津玄師',
      privilege: 0,
      duration: 255
    }),
    false
  );
  assert.equal(
    isValidMandarinSong({
      songname: 'Shape of You',
      singername: 'Ed Sheeran',
      privilege: 0,
      duration: 233
    }),
    false
  );

  // Reject DJ / 伴奏 / 纯音乐 / 铃声 / out-of-range duration
  assert.equal(
    isValidMandarinSong({
      songname: '最炫民族风 (DJ版)',
      singername: '凤凰传奇',
      privilege: 0,
      duration: 198
    }),
    false
  );
  assert.equal(
    isValidMandarinSong({
      songname: '十年 (伴奏)',
      singername: '陈奕迅',
      privilege: 0,
      duration: 200
    }),
    false
  );
  assert.equal(
    isValidMandarinSong({
      songname: '夜曲',
      singername: '周杰伦',
      privilege: 0,
      duration: 35
    }),
    false
  );
});

test('isSongNameMatch performs exact punctuation-insensitive match without partial substring matching', () => {
  const song = {
    canonicalTitle: '突然好想你',
    rawSongName: '突然好想你 (Live)'
  };

  assert.equal(isSongNameMatch('突然好想你', song), true);
  assert.equal(isSongNameMatch(' 《突然好想你》 ', song), true);
  assert.equal(isSongNameMatch('突然好想你！', song), true);
  assert.equal(isSongNameMatch('突然好想你(Live)', song), true);

  // Must NOT match substrings or wrong names
  assert.equal(isSongNameMatch('突然', song), false);
  assert.equal(isSongNameMatch('好想你', song), false);
  assert.equal(isSongNameMatch('突然好想你啊', song), false);
  assert.equal(isSongNameMatch('', song), false);
});

test('pickRandomFirstHalfOffset always picks a node strictly in [0, duration * 0.5)', () => {
  for (const dur of [2, 30, 90, 180, 269, 350]) {
    for (let i = 0; i < 150; i += 1) {
      const offset = pickRandomFirstHalfOffset(dur);
      assert.ok(offset >= 0, `offset ${offset} should be >= 0 for duration ${dur}`);
      assert.ok(
        offset < dur * 0.5,
        `offset ${offset} must be strictly < 50% (${dur * 0.5}) for duration ${dur}`
      );
    }
  }
});

test('computeRankings orders players by score and handles ties accurately', () => {
  const ranked = computeRankings([
    { clientId: 'c', nickname: 'C', score: 2, correctCount: 2, totalCorrectTimeMs: 9000, joinedAt: 3 },
    { clientId: 'a', nickname: 'A', score: 5, correctCount: 5, totalCorrectTimeMs: 25000, joinedAt: 1 },
    { clientId: 'b', nickname: 'B', score: 3, correctCount: 3, totalCorrectTimeMs: 12000, joinedAt: 2 },
    { clientId: 'd', nickname: 'D', score: 2, correctCount: 2, totalCorrectTimeMs: 15000, joinedAt: 4 }
  ]);

  assert.deepEqual(
    ranked.map((r) => ({ id: r.clientId, score: r.score, rank: r.rank })),
    [
      { id: 'a', score: 5, rank: 1 },
      { id: 'b', score: 3, rank: 2 },
      { id: 'c', score: 2, rank: 3 },
      { id: 'd', score: 2, rank: 3 }
    ]
  );
});

// ==================== 2. LIVE KUGOU MANDARIN POOL & AUDIO PROXY TEST ====================
test(
  'KuGou Mandarin service loads valid Chinese pool and proxies Range audio stream',
  { skip: process.env.CI === 'true' },
  async () => {
    const pool = await kugouService.ensurePoolLoaded();
    assert.ok(pool.length >= 300, `Expected >= 300 Mandarin songs, got ${pool.length}`);
    const stats = kugouService.getPoolStats();
    assert.ok(stats.vipTracks >= 50, `Expected >= 50 VIP Mandarin tracks indexed, got ${stats.vipTracks}`);
    assert.ok(stats.categories.classic > 0);
    assert.ok(stats.categories.chart > 0);
    assert.ok(stats.categories.folk_rock > 0);
    assert.ok(stats.categories.cantonese_ost > 0);

  for (const song of pool) {
    assert.ok(
      /[\u4e00-\u9fff]/.test(song.canonicalTitle),
      `Non-Chinese canonicalTitle leaked into pool: ${song.canonicalTitle}`
    );
    assert.ok(song.privilege === 0 || song.privilege === 8);
  }

  const picked = await kugouService.pickPlayableRoundSong();
  assert.ok(picked.streamUrl.startsWith('http'), 'Picked song must have playable HTTP URL');
  assert.ok(picked.startOffset >= 0 && picked.startOffset < picked.duration * 0.5);

  // Verify HTTP proxy serves Range requests properly through Express
  const { server, roomManager } = createAppServer({ musicService: kugouService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Inject a synthetic active round referencing the live KuGou picked track
    roomManager.rooms.set('999888', {
      code: '999888',
      players: [],
      activeRound: {
        roundNumber: 1,
        audioToken: 'tok123',
        hash: picked.hash,
        streamUrl: picked.streamUrl
      }
    });

    const res = await fetch(`${baseUrl}/api/rooms/999888/audio?round=1&token=tok123`, {
      headers: { Range: 'bytes=0-2047' }
    });
    assert.ok(res.status === 206 || res.status === 200, `Unexpected proxy status ${res.status}`);
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0, 'Audio proxy must return audio bytes');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  }
);

// ==================== 3. FULL 10-ROUND MULTIPLAYER WEBSOCKET E2E TEST ====================
function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx !== -1) {
        const [waiter] = waiters.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        inbox.push(msg);
      }
    });

    ws.waitFor = (predicate, timeoutMs = 4000) => {
      const existingIdx = inbox.findIndex(predicate);
      if (existingIdx !== -1) {
        return Promise.resolve(inbox.splice(existingIdx, 1)[0]);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const pos = waiters.indexOf(entry);
          if (pos !== -1) waiters.splice(pos, 1);
          rej(new Error('Timed out waiting for WS message'));
        }, timeoutMs);
        const entry = { predicate, resolve: res, timer };
        waiters.push(entry);
      });
    };

    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('Full 10-round multiplayer match: ready gate, <50% offset, exact guess +1 score, and final ranking', async () => {
  const mockSongs = Array.from({ length: 12 }, (_, i) => ({
    hash: `mock_hash_${i + 1}`,
    canonicalTitle: `测试金曲${i + 1}`,
    normalizedCanonical: `测试金曲${i + 1}`,
    rawSongName: `测试金曲${i + 1} (Live)`,
    singerName: `华语歌手${i + 1}`,
    duration: 200 + i * 10,
    sourceTag: '酷狗华语曲库',
    category: 'classic',
    streamUrl: 'https://example.com/mock.mp3'
  }));

  let pickIdx = 0;
  const mockMusicService = {
    async ensurePoolLoaded() {
      return mockSongs;
    },
    getPoolStats() {
      return { totalTracks: mockSongs.length, uniqueSongs: mockSongs.length, classicCount: 12, chartCount: 0 };
    },
    async pickPlayableRoundSong({ usedHashes }) {
      const song = mockSongs.find((s) => !usedHashes.has(s.hash)) || mockSongs[pickIdx++ % mockSongs.length];
      const startOffset = pickRandomFirstHalfOffset(song.duration);
      return {
        ...song,
        startOffset,
        startPercent: Number(((startOffset / song.duration) * 100).toFixed(1)),
        albumImg: 'https://example.com/cover.jpg'
      };
    },
    async proxyAudioStream(_req, res) {
      res.status(200).send('ok');
    }
  };

  const { server, roomManager } = createAppServer({
    musicService: mockMusicService,
    roomOptions: { totalRounds: 10, countdownMs: 40, revealMs: 40 }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const wsA = await connectClient(wsUrl);
  const wsB = await connectClient(wsUrl);
  const wsC = await connectClient(wsUrl);

  try {
    // 1. Player A creates room with folk_rock category
    wsA.send(JSON.stringify({ type: 'create_room', clientId: 'pA', nickname: '玩家A', category: 'folk_rock' }));
    const created = await wsA.waitFor((m) => m.type === 'joined_room');
    const code = created.room.code;
    assert.equal(created.room.totalRounds, 10);
    assert.equal(created.room.category, 'folk_rock');

    // 2. Players B and C join
    wsB.send(JSON.stringify({ type: 'join_room', code, clientId: 'pB', nickname: '玩家B' }));
    await wsB.waitFor((m) => m.type === 'joined_room');
    wsC.send(JSON.stringify({ type: 'join_room', code, clientId: 'pC', nickname: '玩家C' }));
    await wsC.waitFor((m) => m.type === 'joined_room');

    // 3. Only 2/3 players ready -> game MUST stay in waiting
    wsA.send(JSON.stringify({ type: 'toggle_ready', ready: true }));
    wsB.send(JSON.stringify({ type: 'toggle_ready', ready: true }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(roomManager.rooms.get(code).status, 'waiting');

    // 4. 3/3 players ready -> game auto-starts all 10 rounds
    wsC.send(JSON.stringify({ type: 'toggle_ready', ready: true }));

    // Planned winners across 10 rounds: A wins 5, B wins 3, C wins 2
    const roundWinners = [
      { ws: wsA, id: 'pA', expectedScore: 1 },
      { ws: wsA, id: 'pA', expectedScore: 2 },
      { ws: wsA, id: 'pA', expectedScore: 3 },
      { ws: wsA, id: 'pA', expectedScore: 4 },
      { ws: wsA, id: 'pA', expectedScore: 5 },
      { ws: wsB, id: 'pB', expectedScore: 1 },
      { ws: wsB, id: 'pB', expectedScore: 2 },
      { ws: wsB, id: 'pB', expectedScore: 3 },
      { ws: wsC, id: 'pC', expectedScore: 1 },
      { ws: wsC, id: 'pC', expectedScore: 2 }
    ];

    for (let r = 1; r <= 10; r += 1) {
      const startMsg = await wsA.waitFor((m) => m.type === 'round_start' && m.room.currentRound === r);
      const pubRound = startMsg.room.activeRound;
      assert.ok(pubRound.startOffset >= 0);
      assert.ok(
        pubRound.startOffset < pubRound.duration * 0.5,
        `Round ${r} startOffset ${pubRound.startOffset} must be < 50% of ${pubRound.duration}`
      );
      // Anti-cheat check: title/singer/hash must NOT be sent during playing
      assert.equal(pubRound.canonicalTitle, undefined);
      assert.equal(pubRound.hash, undefined);
      assert.equal(pubRound.revealedSong, undefined);

      // Submit a wrong guess first on Round 1 -> round must NOT end
      if (r === 1) {
        wsB.send(JSON.stringify({ type: 'submit_guess', text: '肯定猜错的歌名' }));
        const wrongResult = await wsB.waitFor((m) => m.type === 'guess_result');
        assert.equal(wrongResult.correct, false);
        assert.equal(roomManager.rooms.get(code).status, 'playing');
      }

      // Retrieve authoritative title from server state for testing exact match scoring
      const realTitle = roomManager.rooms.get(code).activeRound.canonicalTitle;
      const plan = roundWinners[r - 1];
      const guessPayload = r % 2 === 0 ? `《${realTitle}》` : realTitle;
      plan.ws.send(JSON.stringify({ type: 'submit_guess', text: guessPayload }));

      const revealMsg = await wsA.waitFor((m) => m.type === 'round_reveal' && m.room.currentRound === r);
      assert.equal(revealMsg.room.activeRound.revealedSong.canonicalTitle, realTitle);
      assert.equal(revealMsg.room.activeRound.revealedSong.winnerClientId, plan.id);
      const updatedWinner = revealMsg.room.players.find((p) => p.clientId === plan.id);
      assert.equal(updatedWinner.score, plan.expectedScore);
    }

    // 5. After Round 10 -> game_finished & final ranking verification
    const finishMsg = await wsA.waitFor((m) => m.type === 'game_finished');
    assert.equal(finishMsg.room.status, 'finished');
    assert.equal(finishMsg.room.history.length, 10);

    const rankings = finishMsg.rankings || finishMsg.room.rankings;
    assert.deepEqual(
      rankings.map((r) => ({ id: r.clientId, score: r.score, rank: r.rank })),
      [
        { id: 'pA', score: 5, rank: 1 },
        { id: 'pB', score: 3, rank: 2 },
        { id: 'pC', score: 2, rank: 3 }
      ]
    );
  } finally {
    wsA.close();
    wsB.close();
    wsC.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ==================== 4. KUGOU MEMBER LOGIN & ROOM VIP BINDING SECURITY TEST ====================
test('KuGou member login (QR + Cookie) and room VIP real-time session binding without token leakage', async () => {
  const parsedCookie = parseCookieCredentials(
    'kg_mid=abc; userid=987654321; token=secret_vip_token_123456; Path=/'
  );
  assert.equal(parsedCookie.userid, '987654321');
  assert.equal(parsedCookie.token, 'secret_vip_token_123456');

  let receivedAuthSession = null;
  const mockMusicService = {
    async ensurePoolLoaded() {
      return [];
    },
    getPoolStats() {
      return {
        totalTracks: 100,
        uniqueSongs: 100,
        vipTracks: 50,
        totalWithVipUniqueSongs: 150,
        classicCount: 50,
        chartCount: 50,
        categories: { classic: 50, chart: 50, folk_rock: 0, cantonese_ost: 0 }
      };
    },
    async pickPlayableRoundSong({ authSession }) {
      receivedAuthSession = authSession;
      return {
        hash: 'vip_jay_qingtian',
        canonicalTitle: '晴天',
        normalizedCanonical: '晴天',
        rawSongName: '晴天',
        singerName: '周杰伦',
        duration: 269,
        startOffset: 32.5,
        startPercent: 12.1,
        albumImg: '',
        sourceTag: 'VIP华语经典',
        category: 'classic',
        streamUrl: 'https://example.com/qingtian.mp3'
      };
    },
    async proxyAudioStream(_req, res) {
      res.status(200).send('ok');
    }
  };

  const authManager = new KuGouAuthManager();
  authManager.createQrCode = async () => ({
    qrKey: 'mock_qr_key_001',
    qrImgBase64: 'data:image/png;base64,iVBORw0KGgo=',
    qrUrl: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=mock_qr_key_001'
  });
  authManager.checkQrCode = async (key) => ({
    state: key === 'mock_qr_key_001' ? 'waiting' : 'expired',
    message: '等待扫码'
  });

  const { server } = createAppServer({
    musicService: mockMusicService,
    authManager,
    roomOptions: { totalRounds: 10, countdownMs: 30, revealMs: 30 }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const httpBase = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const wsHost = await connectClient(wsUrl);
  const wsGuest = await connectClient(wsUrl);

  try {
    // 1. Test QR Code creation & polling endpoints
    const qrRes = await fetch(`${httpBase}/api/kugou/qr/create`, { method: 'POST' });
    const qrData = await qrRes.json();
    assert.equal(qrData.ok, true);
    assert.equal(qrData.qrKey, 'mock_qr_key_001');

    const chkRes = await fetch(`${httpBase}/api/kugou/qr/check?key=mock_qr_key_001`);
    const chkData = await chkRes.json();
    assert.equal(chkData.state, 'waiting');

    // 2. Test Manual Cookie login endpoint -> issues opaque authTicket
    const manualRes = await fetch(`${httpBase}/api/kugou/auth/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cookie: 'userid=88886666; token=my_private_kugou_vip_token_xyz',
        nickname: 'VIP房主小周'
      })
    });
    const manualData = await manualRes.json();
    assert.equal(manualData.ok, true);
    assert.ok(manualData.authTicket.startsWith('kg_'));

    // 3. Host creates room and Guest joins
    wsHost.send(JSON.stringify({ type: 'create_room', clientId: 'host1', nickname: '房主' }));
    const created = await wsHost.waitFor((m) => m.type === 'joined_room');
    const code = created.room.code;
    assert.equal(created.room.vipStatus.unlocked, false);

    wsGuest.send(JSON.stringify({ type: 'join_room', code, clientId: 'guest1', nickname: '路人乙' }));
    await wsGuest.waitFor((m) => m.type === 'joined_room');

    // 4. Guest binds their KuGou VIP account to the room
    wsGuest.send(JSON.stringify({ type: 'bind_vip', authTicket: manualData.authTicket }));
    const vipUpdated = await wsHost.waitFor((m) => m.type === 'vip_updated');
    assert.equal(vipUpdated.room.vipStatus.unlocked, true);
    assert.equal(vipUpdated.room.vipStatus.kugouNickname, 'VIP房主小周');

    // Security check: raw token and userid MUST NOT leak in serialized room state
    const serializedStr = JSON.stringify(vipUpdated);
    assert.equal(serializedStr.includes('my_private_kugou_vip_token_xyz'), false);
    assert.equal(serializedStr.includes('88886666'), false);

    // 5. Both players ready -> Round 1 passes VIP authSession to musicService in real time
    wsHost.send(JSON.stringify({ type: 'toggle_ready', ready: true }));
    wsGuest.send(JSON.stringify({ type: 'toggle_ready', ready: true }));
    await wsHost.waitFor((m) => m.type === 'round_start');
    assert.equal(receivedAuthSession?.userid, '88886666');
    assert.equal(receivedAuthSession?.token, 'my_private_kugou_vip_token_xyz');
  } finally {
    wsHost.close();
    wsGuest.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

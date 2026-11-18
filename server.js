import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { parseCookieCredentials } from './src/kugouAuth.js';
import { multiAuth, musicHub, SUPPORTED_PLATFORMS } from './src/musicHub.js';
import { MANDARIN_ARTIST_CATALOG } from './src/mandarinCatalog.js';
import { RoomManager } from './src/roomManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createAppServer({
  musicService = musicHub,
  authManager = multiAuth,
  roomOptions = {}
} = {}) {
  const app = express();
  app.set('trust proxy', 1);

  const roomManager = new RoomManager(musicService, {
    ...roomOptions,
    authManager
  });

  // Allow cross-origin calls when frontend is hosted on GitHub Pages or WeChat Mini Program
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '32kb' }));
  app.use(
    '/vendor/focusgroup-polyfill',
    express.static(path.join(__dirname, 'node_modules/@microsoft/focusgroup-polyfill/build'))
  );
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/health', async (_req, res) => {
    try {
      await musicService.ensurePoolLoaded();
      const stats = musicService.getPoolStats();
      res.json({
        ok: true,
        mandarinOnly: true,
        dynamicLiveSearch: true,
        platforms: SUPPORTED_PLATFORMS,
        artistCatalogCount: MANDARIN_ARTIST_CATALOG.length,
        poolSize: stats.totalTracks,
        uniqueSongs: stats.uniqueSongs,
        vipTracks: stats.vipTracks || 0,
        totalWithVipUniqueSongs: stats.totalWithVipUniqueSongs || stats.uniqueSongs,
        classicCount: stats.classicCount,
        chartCount: stats.chartCount,
        categories: stats.categories,
        envVipConfigured: Boolean(authManager?.getEnvDefaultSession?.())
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        mandarinOnly: true,
        error: err?.message || '曲库加载中'
      });
    }
  });

  app.get('/api/rooms', (_req, res) => {
    res.json({
      rooms: roomManager.getPublicRooms()
    });
  });

  // ==================== MULTI-PLATFORM MEMBER LOGIN API ====================
  async function handleQrCreate(platform, res) {
    try {
      const qr = await authManager.createQrCode(platform);
      res.json({ ok: true, platform, ...qr });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err?.message || '创建扫码二维码失败'
      });
    }
  }

  async function handleQrCheck(platform, req, res) {
    try {
      const key = String(req.query.key || '').trim();
      const result =
        typeof authManager.checkQrCode === 'function'
          ? await authManager.checkQrCode(key, platform)
          : { state: 'waiting' };
      res.json({ ok: true, platform, ...result });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err?.message || '查询扫码状态失败'
      });
    }
  }

  async function handleManualAuth(platform, req, res) {
    try {
      if (typeof authManager.verifyAndStoreManual === 'function') {
        const saved = await authManager.verifyAndStoreManual(platform, req.body || {});
        res.json({ ok: true, ...saved });
        return;
      }

      // Legacy fallback when a custom KuGouAuthManager instance is injected in unit tests
      let { userid = '', token = '', cookie = '', nickname = '' } = req.body || {};
      if (cookie && (!userid || !token)) {
        const parsed = parseCookieCredentials(cookie);
        if (!userid) userid = parsed.userid;
        if (!token) token = parsed.token;
        if (!nickname && parsed.nickname) nickname = parsed.nickname;
      }
      const saved = authManager.storeAuthSession({ userid, token, nickname });
      res.json({ ok: true, platform: 'kugou', ...saved });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err?.message || '凭证格式无效，请检查后重试'
      });
    }
  }

  app.post('/api/auth/:platform/qr/create', (req, res) => {
    handleQrCreate(req.params.platform, res);
  });

  app.get('/api/auth/:platform/qr/check', (req, res) => {
    handleQrCheck(req.params.platform, req, res);
  });

  app.post('/api/auth/:platform/manual', (req, res) => {
    handleManualAuth(req.params.platform, req, res);
  });

  app.post('/api/auth/logout', (req, res) => {
    const { authTicket } = req.body || {};
    authManager.revokeAuthTicket(authTicket);
    res.json({ ok: true });
  });

  // Backward-compatible KuGou routes
  app.post('/api/kugou/qr/create', (_req, res) => handleQrCreate('kugou', res));
  app.get('/api/kugou/qr/check', (req, res) => handleQrCheck('kugou', req, res));
  app.post('/api/kugou/auth/manual', (req, res) => handleManualAuth('kugou', req, res));
  app.post('/api/kugou/auth/logout', (req, res) => {
    const { authTicket } = req.body || {};
    authManager.revokeAuthTicket(authTicket);
    res.json({ ok: true });
  });

  // ==================== ROOM AUDIO STREAM PROXY ====================
  app.get('/api/rooms/:code/audio', async (req, res) => {
    const { code } = req.params;
    const { round, token } = req.query;
    const target = roomManager.getAudioTarget(code, round, token);
    if (!target) {
      res.status(404).json({ error: '音频会话无效或本轮已结束' });
      return;
    }

    let streamUrl = target.streamUrl;
    if (!streamUrl && target.hash) {
      streamUrl = await musicService.getStreamUrlForHash(
        target.hash,
        target.authSession,
        target
      );
    }
    if (!streamUrl) {
      res.status(502).json({ error: '未获取到播放地址' });
      return;
    }

    await musicService.proxyAudioStream(req, res, streamUrl);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      roomManager.handleMessage(ws, data);
    });

    ws.on('close', () => {
      roomManager.handleDisconnect(ws);
    });

    ws.on('error', () => {
      roomManager.handleDisconnect(ws);
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeatInterval.unref();

  server.on('close', () => {
    clearInterval(heartbeatInterval);
    roomManager.dispose();
    wss.close();
  });

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return { app, server, wss, roomManager, musicService, authManager };
}

const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  const PORT = Number(process.env.PORT || 3000);
  const { server, musicService } = createAppServer();

  musicService
    .ensurePoolLoaded()
    .then(async () => {
      const stats = musicService.getPoolStats();
      console.log(
        `[三平台华语曲库] 酷狗·网易云·QQ音乐 实时检索就绪（秒开缓存池 ${stats.totalWithVipUniqueSongs} 首）`
      );
      if (typeof musicService.expandPoolInBackground === 'function') {
        await musicService.expandPoolInBackground();
        const expanded = musicService.getPoolStats();
        console.log(
          `[三平台华语曲库] 秒开缓存池扩展完成（${expanded.totalWithVipUniqueSongs} 首 + 线上百万级动态全库）`
        );
      }
    })
    .catch((err) => {
      console.warn('[三平台华语曲库] 预加载告警:', err?.message || err);
    });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`华语猜歌服务已启动: http://localhost:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

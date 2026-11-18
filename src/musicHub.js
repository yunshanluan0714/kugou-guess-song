import crypto from 'node:crypto';
import { kugouAuth, parseCookieCredentials } from './kugouAuth.js';
import { kugouService } from './kugouService.js';
import { neteaseProvider } from './neteaseProvider.js';
import { qqMusicProvider } from './qqMusicProvider.js';
import { getSafePlatformLabel } from './mandarinCatalog.js';
import { pickRandomFirstHalfOffset } from './songUtils.js';

const VAULT_TTL_MS = 12 * 60 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
export const SUPPORTED_PLATFORMS = ['kugou', 'netease', 'qq'];

function normalizePlatform(platform) {
  const p = String(platform || 'kugou').trim().toLowerCase();
  if (p === '163' || p === 'wy' || p === 'netease') return 'netease';
  if (p === 'qqmusic' || p === 'qq') return 'qq';
  return 'kugou';
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class MultiPlatformAuthManager {
  constructor({
    kugou = kugouAuth,
    netease = neteaseProvider,
    qq = qqMusicProvider
  } = {}) {
    this.kugou = kugou;
    this.netease = netease;
    this.qq = qq;
    this.authVault = new Map();
  }

  _pruneVault() {
    const now = Date.now();
    for (const [ticket, entry] of this.authVault.entries()) {
      if (now - entry.createdAt > VAULT_TTL_MS) {
        this.authVault.delete(ticket);
      }
    }
  }

  storeAuthSession({ platform = 'kugou', userid, token, nickname, pic = '' }) {
    this._pruneVault();
    const normPlat = normalizePlatform(platform);
    const cleanUid = String(userid || '').trim();
    const cleanToken = String(token || '').trim();

    if (normPlat === 'kugou') {
      if (!/^\d+$/.test(cleanUid) || cleanToken.length < 8) {
        throw new Error('无效的酷狗 userid 或 token');
      }
    } else if (!cleanUid || cleanToken.length < 8) {
      throw new Error(`无效的${getSafePlatformLabel(normPlat)}登录凭证`);
    }

    const prefix = normPlat === 'netease' ? 'ne' : normPlat === 'qq' ? 'qq' : 'kg';
    const authTicket = `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
    const platformLabel = getSafePlatformLabel(normPlat);
    const displayNick =
      String(nickname || '').trim() || `${platformLabel}会员(${cleanUid.slice(-4)})`;

    const session = {
      platform: normPlat,
      platformLabel,
      userid: cleanUid,
      token: cleanToken,
      nickname: displayNick,
      pic,
      createdAt: Date.now()
    };

    this.authVault.set(authTicket, session);
    return {
      authTicket,
      platform: normPlat,
      platformLabel,
      userid: cleanUid,
      nickname: displayNick,
      pic
    };
  }

  getAuthSession(authTicket) {
    if (!authTicket) return null;
    this._pruneVault();
    const direct = this.authVault.get(authTicket);
    if (direct) return direct;

    const legacyKg = this.kugou?.getAuthSession?.(authTicket);
    if (legacyKg) {
      return {
        platform: 'kugou',
        platformLabel: '酷狗音乐',
        ...legacyKg
      };
    }
    return null;
  }

  revokeAuthTicket(authTicket) {
    if (!authTicket) return;
    this.authVault.delete(authTicket);
    this.kugou?.revokeAuthTicket?.(authTicket);
  }

  getEnvDefaultSessions() {
    const kg = this.kugou?.getEnvDefaultSession?.();
    const ne = this.netease?.getEnvDefaultSession?.();
    const qq = this.qq?.getEnvDefaultSession?.();
    return {
      kugou: kg ? { platform: 'kugou', platformLabel: '酷狗音乐', ...kg } : null,
      netease: ne ? { platform: 'netease', platformLabel: '网易云音乐', ...ne } : null,
      qq: qq ? { platform: 'qq', platformLabel: 'QQ音乐', ...qq } : null
    };
  }

  getEnvDefaultSession() {
    const all = this.getEnvDefaultSessions();
    return all.kugou || all.netease || all.qq || null;
  }

  async createQrCode(platform = 'kugou') {
    const normPlat = normalizePlatform(platform);
    if (normPlat === 'netease') {
      return this.netease.createQrCode();
    }
    if (normPlat === 'qq') {
      return this.qq.createQrCode();
    }
    const qr = await this.kugou.createQrCode();
    return { platform: 'kugou', ...qr };
  }

  async checkQrCode(qrKey, platform = 'kugou') {
    const normPlat = normalizePlatform(platform);
    if (normPlat === 'netease') {
      const res = await this.netease.checkQrCode(qrKey);
      if (res.state === 'authorized' && res.token) {
        const saved = this.storeAuthSession({
          platform: 'netease',
          userid: res.userid,
          token: res.token,
          nickname: res.nickname,
          pic: res.pic
        });
        return { state: 'authorized', message: res.message, ...saved };
      }
      return res;
    }

    if (normPlat === 'qq') {
      const res = await this.qq.checkQrCode(qrKey);
      if (res.state === 'authorized' && res.token) {
        const saved = this.storeAuthSession({
          platform: 'qq',
          userid: res.userid,
          token: res.token,
          nickname: res.nickname
        });
        return { state: 'authorized', message: res.message, ...saved };
      }
      return res;
    }

    const kgRes = await this.kugou.checkQrCode(qrKey);
    if (kgRes.state === 'authorized' && kgRes.authTicket) {
      const kgSaved = this.kugou.getAuthSession(kgRes.authTicket);
      if (kgSaved) {
        this.authVault.set(kgRes.authTicket, {
          platform: 'kugou',
          platformLabel: '酷狗音乐',
          ...kgSaved
        });
      }
      return {
        platform: 'kugou',
        platformLabel: '酷狗音乐',
        ...kgRes
      };
    }
    return kgRes;
  }

  async verifyAndStoreManual(platform = 'kugou', payload = {}) {
    const normPlat = normalizePlatform(platform);
    if (normPlat === 'netease') {
      const verified = await this.netease.verifyManualCredentials(payload);
      return this.storeAuthSession(verified);
    }
    if (normPlat === 'qq') {
      const verified = await this.qq.verifyManualCredentials(payload);
      return this.storeAuthSession(verified);
    }

    let { userid = '', token = '', cookie = '', nickname = '' } = payload || {};
    if (cookie && (!userid || !token)) {
      const parsed = parseCookieCredentials(cookie);
      if (!userid) userid = parsed.userid;
      if (!token) token = parsed.token;
      if (!nickname && parsed.nickname) nickname = parsed.nickname;
    }
    return this.storeAuthSession({ platform: 'kugou', userid, token, nickname });
  }
}

export class MultiPlatformMusicHub {
  constructor({
    kugou = kugouService,
    kugouAuthMgr = kugouAuth,
    netease = neteaseProvider,
    qq = qqMusicProvider
  } = {}) {
    this.kugou = kugou;
    this.kugouAuthMgr = kugouAuthMgr;
    this.netease = netease;
    this.qq = qq;
    this.streamCache = new Map();
  }

  async ensurePoolLoaded(forceRefresh = false) {
    return this.kugou.ensurePoolLoaded(forceRefresh);
  }

  async expandPoolInBackground() {
    if (typeof this.kugou.expandPoolInBackground === 'function') {
      return this.kugou.expandPoolInBackground();
    }
    return [];
  }

  getPoolStats() {
    const base = this.kugou.getPoolStats();
    return {
      ...base,
      platforms: SUPPORTED_PLATFORMS,
      dynamicLiveSearch: true
    };
  }

  _normalizeSessions(authSession = null, authSessions = null) {
    const envSessions = {
      kugou: this.kugouAuthMgr?.getEnvDefaultSession?.() || null,
      netease: this.netease?.getEnvDefaultSession?.() || null,
      qq: this.qq?.getEnvDefaultSession?.() || null
    };

    const out = { ...envSessions };
    if (authSessions && typeof authSessions === 'object') {
      for (const plat of SUPPORTED_PLATFORMS) {
        if (authSessions[plat]?.token) {
          out[plat] = authSessions[plat];
        }
      }
    }
    if (authSession?.token) {
      const plat = normalizePlatform(authSession.platform || 'kugou');
      out[plat] = authSession;
    }
    return out;
  }

  async _sampleFromPlatform(platform, { category, allowVip, customKeyword, authSession }) {
    let timer = null;
    try {
      const work =
        platform === 'netease'
          ? this.netease.sampleLiveSongs({
              category,
              allowVip,
              customKeyword,
              authSession
            })
          : platform === 'qq'
            ? this.qq.sampleLiveSongs({
                category,
                allowVip,
                customKeyword
              })
            : this.kugou.sampleLiveSongs({
                category,
                allowVip,
                customKeyword
              });

      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve([]), 2400);
        timer.unref?.();
      });
      return await Promise.race([work, timeout]);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _resolveCandidateStream(candidate, sessions) {
    const plat = normalizePlatform(candidate.platform || 'kugou');
    const session = sessions[plat] || null;
    const cacheKey = `${candidate.hash}:${session?.userid || 'free'}`;
    const cached = this.streamCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STREAM_CACHE_TTL_MS) {
      return cached;
    }

    let resolved = null;
    if (plat === 'netease') {
      resolved = await this.netease.resolveStreamUrl(candidate, session);
    } else if (plat === 'qq') {
      resolved = await this.qq.resolveStreamUrl(candidate, session);
    } else {
      if (session) {
        resolved = await this.kugouAuthMgr.resolveV5StreamUrl({
          hash: candidate.hash,
          albumId: candidate.albumId,
          albumAudioId: candidate.albumAudioId,
          authSession: session
        });
      }
      if (!resolved && candidate.privilege !== 10) {
        resolved = await this.kugou.resolvePlayInfo(candidate.hash);
      }
    }

    if (resolved) {
      if (this.streamCache.size > 600) {
        const oldestKey = this.streamCache.keys().next().value;
        if (oldestKey) this.streamCache.delete(oldestKey);
      }
      this.streamCache.set(cacheKey, resolved);
    }
    return resolved;
  }

  /**
   * Real-time multi-platform Mandarin song picker:
   * Dynamically queries KuGou, NetEase Cloud Music, and QQ Music live online catalogs
   * on demand (prioritizing any VIP-logged-in platforms), with pre-warmed memory pool
   * as an instant fallback.
   */
  async pickPlayableRoundSong({
    usedHashes = new Set(),
    usedCanonicalTitles = new Set(),
    category = 'all',
    customKeyword = '',
    authSession = null,
    authSessions = null
  } = {}) {
    const sessions = this._normalizeSessions(authSession, authSessions);
    const trimmedKeyword = String(customKeyword || '').trim();

    // Ensure background warm pool is loaded without blocking if already warm
    this.ensurePoolLoaded().catch(() => {});

    const vipPlatforms = SUPPORTED_PLATFORMS.filter((p) => Boolean(sessions[p]));
    let targetPlatforms;
    if (vipPlatforms.length > 0) {
      const others = shuffleArray(
        SUPPORTED_PLATFORMS.filter((p) => !vipPlatforms.includes(p))
      );
      targetPlatforms = [...shuffleArray(vipPlatforms), ...others.slice(0, 1)];
    } else {
      targetPlatforms = shuffleArray(SUPPORTED_PLATFORMS).slice(0, 2);
    }

    const sampledBuckets = await Promise.all(
      targetPlatforms.map(async (plat) => {
        const list = await this._sampleFromPlatform(plat, {
          category,
          allowVip: Boolean(sessions[plat]),
          customKeyword: trimmedKeyword,
          authSession: sessions[plat]
        });
        const fresh = shuffleArray(
          list.filter(
            (item) =>
              !usedHashes.has(item.hash) &&
              !usedCanonicalTitles.has(item.normalizedCanonical)
          )
        );
        // Put VIP studio tracks ahead of free tracks on VIP-authenticated platforms
        if (sessions[plat]) {
          const vipItems = fresh.filter((t) => t.privilege === 10);
          const freeItems = fresh.filter((t) => t.privilege !== 10);
          const interleaved = [];
          const maxLen = Math.max(vipItems.length, freeItems.length);
          for (let i = 0; i < maxLen; i += 1) {
            if (i < vipItems.length) interleaved.push(vipItems[i]);
            if (i < freeItems.length) interleaved.push(freeItems[i]);
          }
          return interleaved.slice(0, 10);
        }
        return fresh.slice(0, 8);
      })
    );

    const liveCandidates = [];
    const maxBucket = Math.max(0, ...sampledBuckets.map((b) => b.length));
    for (let i = 0; i < maxBucket; i += 1) {
      for (const bucket of sampledBuckets) {
        if (i < bucket.length) {
          liveCandidates.push(bucket[i]);
        }
      }
    }

    // Append pre-warmed KuGou memory pool as ultra-reliable zero-latency fallback
    let fallbackCandidates = [];
    if (!trimmedKeyword) {
      if (this.kugou.pool.length === 0) {
        await this.ensurePoolLoaded().catch(() => {});
      }
      const validCats = new Set(['classic', 'chart', 'folk_rock', 'cantonese_ost']);
      const filterWarm = (arr) =>
        shuffleArray(
          arr.filter((item) => {
            if (usedHashes.has(item.hash)) return false;
            if (usedCanonicalTitles.has(item.normalizedCanonical)) return false;
            if (validCats.has(category)) return item.category === category;
            return true;
          })
        );

      if (sessions.kugou && this.kugou.vipPool.length > 0) {
        fallbackCandidates.push(...filterWarm(this.kugou.vipPool).slice(0, 6));
      }
      fallbackCandidates.push(...filterWarm(this.kugou.pool).slice(0, 10));
    }

    const combinedCandidates = [...liveCandidates, ...fallbackCandidates];

    for (let idx = 0; idx < combinedCandidates.length; idx += 3) {
      const batch = combinedCandidates.slice(idx, idx + 3);
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          const info = await this._resolveCandidateStream(candidate, sessions);
          if (!info || !info.streamUrl) return null;
          const duration = info.duration || candidate.duration;
          if (!Number.isFinite(duration) || duration < 60) return null;
          return { candidate, info, duration };
        })
      );

      const hit = batchResults.find(Boolean);
      if (!hit) continue;

      const { candidate, info, duration } = hit;
      const startOffset = pickRandomFirstHalfOffset(duration);
      const startPercent = Number(((startOffset / duration) * 100).toFixed(1));
      const platform = normalizePlatform(candidate.platform || 'kugou');

      return {
        platform,
        hash: candidate.hash,
        songId: candidate.songId || '',
        mid: candidate.mid || '',
        mediaMid: candidate.mediaMid || '',
        albumId: candidate.albumId || '',
        albumAudioId: candidate.albumAudioId || 0,
        canonicalTitle: candidate.canonicalTitle,
        normalizedCanonical: candidate.normalizedCanonical,
        rawSongName: candidate.rawSongName,
        singerName: candidate.singerName,
        duration,
        startOffset,
        startPercent,
        albumImg: info.albumImg || candidate.albumImg || '',
        sourceTag: getSafePlatformLabel(platform),
        category: candidate.category || category,
        isVipTrack: candidate.privilege === 10,
        streamUrl: info.streamUrl
      };
    }

    if (trimmedKeyword) {
      throw new Error(`未找到「${trimmedKeyword}」可播放的完整版华语歌曲，请换个关键词或登录对应平台会员`);
    }
    throw new Error('暂无可用的华语歌曲播放源，请稍后重试');
  }

  async getStreamUrlForHash(hash, authSession = null, targetMeta = null) {
    const rawHash = String(hash || '');
    const plat = rawHash.startsWith('ne_')
      ? 'netease'
      : rawHash.startsWith('qq_')
        ? 'qq'
        : normalizePlatform(targetMeta?.platform || 'kugou');

    const sessions = this._normalizeSessions(authSession, targetMeta?.authSessions || null);
    const candidate = {
      platform: plat,
      hash: rawHash,
      songId: targetMeta?.songId || rawHash.replace(/^ne_/, ''),
      mid: targetMeta?.mid || rawHash.replace(/^qq_/, ''),
      mediaMid: targetMeta?.mediaMid || '',
      albumId: targetMeta?.albumId || '',
      albumAudioId: targetMeta?.albumAudioId || 0,
      duration: targetMeta?.duration || 180
    };

    const resolved = await this._resolveCandidateStream(candidate, sessions);
    return resolved ? resolved.streamUrl : null;
  }

  async proxyAudioStream(req, res, streamUrl) {
    return this.kugou.proxyAudioStream(req, res, streamUrl);
  }
}

export const multiAuth = new MultiPlatformAuthManager();
export const musicHub = new MultiPlatformMusicHub();

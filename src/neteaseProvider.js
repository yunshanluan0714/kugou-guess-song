import crypto from 'node:crypto';
import QRCode from 'qrcode';
import {
  extractCanonicalTitle,
  isValidMandarinSong,
  normalizeGuess
} from './songUtils.js';
import { pickRandomQueriesForCategory } from './mandarinCatalog.js';

const EAPI_KEY = Buffer.from('e82ckenh8dichen8', 'utf8');
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 NeteaseMusicDesktop/3.0.18.203152';

const NETEASE_CHARTS = [
  { id: '3778678', category: 'chart' }, // 热歌榜
  { id: '3779629', category: 'chart' }, // 新歌榜
  { id: '19723756', category: 'chart' }, // 飙升榜
  { id: '2884035', category: 'folk_rock' }, // 原创榜
  { id: '5059661515', category: 'folk_rock' }, // 民谣榜
  { id: '5059633707', category: 'folk_rock' }, // 摇滚榜
  { id: '5059642708', category: 'cantonese_ost' }, // 国风榜
  { id: '6732051320', category: 'cantonese_ost' }, // 粤语榜
  { id: '991319590', category: 'chart' } // 说唱榜
];

export function eapiEncrypt(apiPath, payloadObj) {
  const text = JSON.stringify(payloadObj);
  const message = `nobody${apiPath}use${text}md5forencrypt`;
  const digest = crypto.createHash('md5').update(message).digest('hex');
  const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

export function parseNeteaseCookie(cookieStr = '', rawToken = '') {
  const trimmedToken = String(rawToken || '').trim();
  const trimmedCookie = String(cookieStr || '').trim();
  const kv = {};

  for (const part of trimmedCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) kv[k] = v;
  }

  let musicU = kv.MUSIC_U || trimmedToken;
  if (!musicU && trimmedCookie && !trimmedCookie.includes('=') && trimmedCookie.length >= 20) {
    musicU = trimmedCookie;
  }

  return {
    musicU,
    userid: kv.__uid || ''
  };
}

function extractCookieValueFromHeaders(headers, targetName) {
  const setCookies =
    typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers?.get?.('set-cookie')
        ? [headers.get('set-cookie')]
        : [];

  for (const line of setCookies) {
    for (const seg of String(line).split(';')) {
      const eq = seg.indexOf('=');
      if (eq === -1) continue;
      const k = seg.slice(0, eq).trim();
      const v = seg.slice(eq + 1).trim();
      if (k === targetName && v) return v;
    }
  }
  return '';
}

async function callNeteaseEapi(apiPath, payload = {}, { musicU = '', timeoutMs = 5500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const paramsHex = eapiEncrypt(apiPath, {
      ...payload,
      header: '{}'
    });

    const cookieParts = ['os=pc', 'appver=3.0.18.203152', 'channel=netease'];
    if (musicU) cookieParts.push(`MUSIC_U=${musicU}`);

    const url = `https://interface.music.163.com/eapi${apiPath.replace(/^\/api/, '')}`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DESKTOP_UA,
        Referer: 'https://music.163.com/',
        Cookie: cookieParts.join('; ')
      },
      body: `params=${paramsHex}`
    });

    if (!res.ok) return { json: null, headers: res.headers };
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if (!text.trim().startsWith('{')) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', EAPI_KEY, null);
      text = Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
    }
    return { json: JSON.parse(text), headers: res.headers };
  } catch {
    return { json: null, headers: null };
  } finally {
    clearTimeout(timer);
  }
}

export class NeteaseMusicProvider {
  getEnvDefaultSession() {
    const musicU = String(process.env.NETEASE_VIP_COOKIE || process.env.NETEASE_MUSIC_U || '').trim();
    if (!musicU) return null;
    const parsed = parseNeteaseCookie(musicU, musicU);
    if (!parsed.musicU || parsed.musicU.length < 16) return null;
    return {
      platform: 'netease',
      userid: parsed.userid || 'env_ne',
      token: parsed.musicU,
      nickname: '系统默认网易云会员',
      isEnvDefault: true
    };
  }

  async fetchAccountProfile(musicU) {
    if (!musicU) return null;
    const { json } = await callNeteaseEapi('/api/w/nuser/account/get', {}, { musicU, timeoutMs: 4500 });
    const profile = json?.profile;
    if (!profile) return null;
    return {
      userid: String(profile.userId || ''),
      nickname: String(profile.nickname || '').trim(),
      pic: String(profile.avatarUrl || ''),
      vipType: Number(profile.vipType || json?.account?.vipType || 0)
    };
  }

  async createQrCode() {
    const { json } = await callNeteaseEapi('/api/login/qrcode/unikey', { type: 1 });
    const qrKey = json?.unikey;
    if (!qrKey) {
      throw new Error('获取网易云音乐登录二维码失败，请稍后重试');
    }
    const qrUrl = `https://music.163.com/login?codekey=${encodeURIComponent(qrKey)}`;
    const qrImgBase64 = await QRCode.toDataURL(qrUrl, {
      margin: 1,
      width: 240,
      color: { dark: '#18181b', light: '#ffffff' }
    });

    return {
      platform: 'netease',
      qrKey,
      qrImgBase64,
      qrUrl
    };
  }

  async checkQrCode(qrKey) {
    if (!qrKey) throw new Error('缺少网易云二维码标识 key');

    const { json, headers } = await callNeteaseEapi('/api/login/qrcode/client/login', {
      key: String(qrKey),
      type: 1
    });

    const code = Number(json?.code || 0);
    if (code === 800) {
      return { state: 'expired', message: '二维码已过期，请点击刷新' };
    }
    if (code === 801) {
      return { state: 'waiting', message: '请打开手机「网易云音乐 APP」扫一扫登录' };
    }
    if (code === 802) {
      return {
        state: 'scanned',
        nickname: json?.nickname || '',
        pic: json?.avatarUrl || '',
        message: '已扫码，请在手机上点击确认登录'
      };
    }
    if (code === 803) {
      let musicU = extractCookieValueFromHeaders(headers, 'MUSIC_U');
      if (!musicU && json?.cookie) {
        musicU = parseNeteaseCookie(json.cookie).musicU;
      }
      if (!musicU) {
        return { state: 'waiting', message: '正在同步授权信息…' };
      }

      const profile = await this.fetchAccountProfile(musicU);
      return {
        state: 'authorized',
        platform: 'netease',
        userid: profile?.userid || `ne_${Date.now().toString().slice(-6)}`,
        token: musicU,
        nickname: profile?.nickname || '网易云会员',
        pic: profile?.pic || '',
        message: '网易云音乐登录成功！已开启实时拉取'
      };
    }

    return { state: 'waiting', message: '等待网易云音乐扫码…' };
  }

  async verifyManualCredentials({ cookie = '', token = '', userid = '', nickname = '' } = {}) {
    const parsed = parseNeteaseCookie(cookie, token);
    if (!parsed.musicU || parsed.musicU.length < 16) {
      throw new Error('无效的网易云音乐凭证，请粘贴包含 MUSIC_U 的 Cookie 或直接填入 MUSIC_U 值');
    }

    const profile = await this.fetchAccountProfile(parsed.musicU);
    const resolvedUid = profile?.userid || String(userid || parsed.userid || `ne_${parsed.musicU.slice(0, 8)}`);
    const resolvedNick =
      profile?.nickname ||
      String(nickname || '').trim() ||
      `网易云会员(${resolvedUid.slice(-4)})`;

    return {
      platform: 'netease',
      userid: resolvedUid,
      token: parsed.musicU,
      nickname: resolvedNick,
      pic: profile?.pic || ''
    };
  }

  _normalizeSongItem(rawSong, category = 'chart', allowVip = false) {
    if (!rawSong?.id || !rawSong?.name) return null;
    const artists = Array.isArray(rawSong.ar)
      ? rawSong.ar
      : Array.isArray(rawSong.artists)
        ? rawSong.artists
        : [];
    const singerName = artists.map((a) => a?.name).filter(Boolean).join(' / ') || '华语歌手';
    const durationSec = Math.round(Number(rawSong.dt || rawSong.duration || 0) / 1000);
    const fee = Number(rawSong.fee ?? 0);
    // fee 1 or 4 requires VIP/paid; fee 0 or 8 is free/standard
    const privilege = fee === 1 || fee === 4 ? 10 : 0;

    const syntheticTrack = {
      songname: String(rawSong.name).trim(),
      singername: singerName,
      privilege,
      duration: durationSec
    };
    if (!isValidMandarinSong(syntheticTrack, { allowVip })) return null;

    const canonicalTitle = extractCanonicalTitle(syntheticTrack.songname);
    const normalizedCanonical = normalizeGuess(canonicalTitle);
    if (!normalizedCanonical) return null;

    const albumObj = rawSong.al || rawSong.album || {};
    return {
      platform: 'netease',
      hash: `ne_${rawSong.id}`,
      songId: String(rawSong.id),
      rawSongName: syntheticTrack.songname,
      canonicalTitle,
      normalizedCanonical,
      singerName,
      duration: durationSec,
      privilege,
      albumImg: albumObj.picUrl ? `${albumObj.picUrl}?param=400y400` : '',
      category,
      sourceTag: '网易云音乐'
    };
  }

  /**
   * Real-time dynamic Mandarin song sampling from NetEase's live online catalog.
   */
  async sampleLiveSongs({
    category = 'all',
    allowVip = false,
    customKeyword = '',
    authSession = null
  } = {}) {
    const musicU = authSession?.token || '';
    const candidates = new Map();
    const queries = pickRandomQueriesForCategory(category, 2, customKeyword);
    const tasks = [];

    for (const q of queries) {
      const offset = Math.max(0, (q.page - 1) * 25);
      tasks.push(async () => {
        const { json } = await callNeteaseEapi(
          '/api/cloudsearch/pc',
          {
            s: q.keyword,
            type: 1,
            limit: 30,
            offset,
            total: true
          },
          { musicU, timeoutMs: 4500 }
        );
        const list = json?.result?.songs || [];
        for (const item of list) {
          const norm = this._normalizeSongItem(item, q.category, allowVip);
          if (norm && !candidates.has(norm.hash)) {
            candidates.set(norm.hash, norm);
          }
        }
      });
    }

    if (!String(customKeyword || '').trim()) {
      const matchingCharts =
        category === 'all'
          ? NETEASE_CHARTS
          : NETEASE_CHARTS.filter((c) => c.category === category);
      const chartPool = matchingCharts.length > 0 ? matchingCharts : NETEASE_CHARTS;
      const pickedChart = chartPool[Math.floor(Math.random() * chartPool.length)];
      tasks.push(async () => {
        const { json } = await callNeteaseEapi(
          '/api/v6/playlist/detail',
          { id: pickedChart.id, n: 60, s: 0 },
          { musicU, timeoutMs: 4500 }
        );
        const list = json?.playlist?.tracks || [];
        for (const item of list) {
          const norm = this._normalizeSongItem(item, pickedChart.category, allowVip);
          if (norm && !candidates.has(norm.hash)) {
            candidates.set(norm.hash, norm);
          }
        }
      });
    }

    await Promise.all(tasks.map((fn) => fn()));
    return Array.from(candidates.values());
  }

  async resolveStreamUrl(track, authSession = null) {
    const songId = track?.songId || String(track?.hash || '').replace(/^ne_/, '');
    if (!songId) return null;

    const musicU = authSession?.token || '';
    const { json } = await callNeteaseEapi(
      '/api/song/enhance/player/url/v1',
      {
        ids: JSON.stringify([Number(songId)]),
        level: musicU ? 'exhigh' : 'standard',
        encodeType: 'mp3'
      },
      { musicU, timeoutMs: 5000 }
    );

    const item = json?.data?.[0];
    if (!item || typeof item.url !== 'string' || !item.url.startsWith('http')) {
      return null;
    }
    // Reject 30-second trial snippets so players always get a full-length song
    if (item.freeTrialInfo != null) {
      return null;
    }
    const duration = Math.round(Number(item.time || 0) / 1000) || Number(track?.duration || 0);
    if (!Number.isFinite(duration) || duration < 60) {
      return null;
    }

    return {
      hash: `ne_${songId}`,
      streamUrl: item.url.replace(/^http:\/\//i, 'https://'),
      duration,
      albumImg: track?.albumImg || '',
      fetchedAt: Date.now()
    };
  }
}

export const neteaseProvider = new NeteaseMusicProvider();

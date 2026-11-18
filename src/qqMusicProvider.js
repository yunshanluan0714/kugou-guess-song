import crypto from 'node:crypto';
import {
  extractCanonicalTitle,
  isValidMandarinSong,
  normalizeGuess
} from './songUtils.js';
import { pickRandomQueriesForCategory } from './mandarinCatalog.js';

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const QQ_TOPLISTS = [
  { topId: 26, category: 'chart' }, // 热歌榜
  { topId: 27, category: 'chart' }, // 新歌榜
  { topId: 4, category: 'chart' }, // 流行指数榜
  { topId: 62, category: 'chart' }, // 飙升榜
  { topId: 5, category: 'classic' }, // 内地榜
  { topId: 61, category: 'classic' }, // 台湾地区榜
  { topId: 59, category: 'cantonese_ost' }, // 香港地区榜
  { topId: 58, category: 'chart' } // 说唱榜
];

export function hash33(str, initial = 0) {
  let h = BigInt(initial);
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33n + BigInt(s.charCodeAt(i))) & 2147483647n;
  }
  return Number(h);
}

export function parseQQMusicCookie(cookieStr = '', { userid = '', token = '' } = {}) {
  const kv = {};
  const rawCookie = String(cookieStr || '').trim();
  for (const part of rawCookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) kv[k] = v;
  }

  let musickey =
    kv.qm_keyst || kv.qqmusic_key || kv.musickey || String(token || '').trim();
  if (!musickey && rawCookie && !rawCookie.includes('=') && rawCookie.length >= 16) {
    musickey = rawCookie;
  }

  const rawUin =
    kv.qqmusic_uin ||
    kv.uin ||
    kv.wxuin ||
    kv.p_uin ||
    kv.o_cookie ||
    String(userid || '').trim();

  const cleanUin = String(rawUin).replace(/^o0*/, '').trim();
  return {
    userid: cleanUin,
    musickey
  };
}

function parseSetCookiesMap(headers) {
  const map = {};
  const lines =
    typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers?.get?.('set-cookie')
        ? [headers.get('set-cookie')]
        : [];

  for (const line of lines) {
    const firstPart = String(line).split(';')[0] || '';
    const eq = firstPart.indexOf('=');
    if (eq === -1) continue;
    const k = firstPart.slice(0, eq).trim();
    const v = firstPart.slice(eq + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': WEB_UA,
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

export class QQMusicProvider {
  constructor() {
    this.guid = String(Math.floor(1000000000 + Math.random() * 8999999999));
  }

  getEnvDefaultSession() {
    const envCookie = String(process.env.QQMUSIC_VIP_COOKIE || '').trim();
    const envUin = String(process.env.QQMUSIC_VIP_UIN || '').trim();
    const envKey = String(process.env.QQMUSIC_VIP_KEY || '').trim();
    if (!envCookie && (!envUin || !envKey)) return null;

    const parsed = parseQQMusicCookie(envCookie, { userid: envUin, token: envKey });
    if (!parsed.userid || !parsed.musickey) return null;
    return {
      platform: 'qq',
      userid: parsed.userid,
      token: parsed.musickey,
      nickname: '系统默认QQ音乐会员',
      isEnvDefault: true
    };
  }

  async createQrCode() {
    const params = new URLSearchParams({
      appid: '716027609',
      e: '2',
      l: 'M',
      s: '3',
      d: '72',
      v: '4',
      t: String(Math.random()),
      daid: '383',
      pt_3rd_aid: '100497308'
    });

    const res = await fetchWithTimeout(
      `https://ssl.ptlogin2.qq.com/ptqrshow?${params.toString()}`,
      {
        headers: { Referer: 'https://xui.ptlogin2.qq.com/' }
      }
    );

    if (!res.ok) {
      throw new Error('获取 QQ 音乐登录二维码失败，请稍后重试');
    }

    const cookies = parseSetCookiesMap(res.headers);
    const qrsig = cookies.qrsig;
    if (!qrsig) {
      throw new Error('未获取到 QQ 登录签名 qrsig，请重试');
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const qrImgBase64 = `data:image/png;base64,${buf.toString('base64')}`;

    return {
      platform: 'qq',
      qrKey: qrsig,
      qrImgBase64
    };
  }

  async _exchangeQQOAuth({ uin, ptsigx, qqNick = '' }) {
    const checkParams = new URLSearchParams({
      uin,
      pttype: '1',
      service: 'ptqrlogin',
      nodirect: '0',
      ptsigx,
      s_url: 'https://graph.qq.com/oauth2.0/login_jump',
      ptlang: '2052',
      ptredirect: '100',
      aid: '716027609',
      daid: '383',
      j_later: '0',
      low_login_hour: '0',
      regmaster: '0',
      pt_login_type: '3',
      pt_aid: '0',
      pt_aaid: '16',
      pt_light: '0',
      pt_3rd_aid: '100497308'
    });

    const sigRes = await fetchWithTimeout(
      `https://ssl.ptlogin2.graph.qq.com/check_sig?${checkParams.toString()}`,
      {
        redirect: 'manual',
        headers: { Referer: 'https://xui.ptlogin2.qq.com/' }
      }
    );

    const sigCookies = parseSetCookiesMap(sigRes.headers);
    const pSkey = sigCookies.p_skey;
    if (!pSkey) {
      throw new Error('QQ 互联签名交换失败（缺少 p_skey）');
    }

    const cookieHeader = Object.entries(sigCookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const authForm = new URLSearchParams({
      response_type: 'code',
      client_id: '100497308',
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
      scope: 'get_user_info,get_app_friends',
      state: 'state',
      switch: '',
      from_ptlogin: '1',
      src: '1',
      update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(hash33(pSkey, 5381)),
      auth_time: String(Date.now()),
      ui: crypto.randomUUID()
    });

    const authRes = await fetchWithTimeout('https://graph.qq.com/oauth2.0/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://graph.qq.com/oauth2.0/show',
        Cookie: cookieHeader
      },
      body: authForm.toString()
    });

    const location = authRes.headers.get('location') || '';
    const codeMatch = location.match(/[?&]code=([^&#]+)/);
    if (!codeMatch?.[1]) {
      throw new Error('获取 QQ 音乐授权码 code 失败');
    }

    const loginRes = await fetchWithTimeout('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://y.qq.com/'
      },
      body: JSON.stringify({
        comm: {
          ct: '24',
          cv: '4747474',
          platform: 'yqq.json',
          tmeLoginType: '2',
          g_tk: '5381',
          format: 'json',
          inCharset: 'utf-8',
          outCharset: 'utf-8'
        },
        req: {
          module: 'QQConnectLogin.LoginServer',
          method: 'QQLogin',
          param: { code: codeMatch[1] }
        }
      })
    });

    const loginJson = await loginRes.json();
    const data = loginJson?.req?.data || {};
    const musickey = String(data.musickey || '').trim();
    const musicid = String(data.str_musicid || data.musicid || uin).trim();
    if (!musickey || !musicid) {
      throw new Error('兑换 QQ 音乐会员凭证失败，请重试或使用 Cookie 绑定');
    }

    const displayNick =
      String(qqNick || data.nick || '').trim() || `QQ音乐会员(${musicid.slice(-4)})`;

    return {
      platform: 'qq',
      userid: musicid,
      token: musickey,
      nickname: displayNick
    };
  }

  async checkQrCode(qrsig) {
    if (!qrsig) throw new Error('缺少 QQ 二维码标识 key');

    const params = new URLSearchParams({
      u1: 'https://graph.qq.com/oauth2.0/login_jump',
      ptqrtoken: String(hash33(qrsig, 0)),
      ptredirect: '0',
      h: '1',
      t: '1',
      g: '1',
      from_ui: '1',
      ptlang: '2052',
      action: `0-0-${Date.now()}`,
      js_ver: '20102616',
      js_type: '1',
      pt_uistyle: '40',
      aid: '716027609',
      daid: '383',
      pt_3rd_aid: '100497308',
      has_onekey: '1'
    });

    const res = await fetchWithTimeout(
      `https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`,
      {
        headers: {
          Referer: 'https://xui.ptlogin2.qq.com/',
          Cookie: `qrsig=${qrsig}`
        }
      }
    );

    const text = await res.text();
    const cbMatch = text.match(/ptuiCB\(([\s\S]*?)\)/);
    if (!cbMatch) {
      return { state: 'waiting', message: '等待手机 QQ 扫码登录…' };
    }

    const args = Array.from(cbMatch[1].matchAll(/'((?:\\.|[^'])*)'/g), (m) => m[1]);
    const statusCode = Number(args[0]);

    if (statusCode === 66) {
      return { state: 'waiting', message: '请打开「手机 QQ」扫一扫授权登录 QQ 音乐' };
    }
    if (statusCode === 67) {
      return {
        state: 'scanned',
        nickname: args[5] || '',
        message: '已扫码，请在手机上点击确认授权'
      };
    }
    if (statusCode === 65 || statusCode === 68) {
      return { state: 'expired', message: '二维码已过期或已取消，请点击刷新' };
    }
    if (statusCode === 0 && args[2]) {
      const checkUrl = args[2];
      const sigxMatch = checkUrl.match(/[?&]ptsigx=([^&]+)/);
      const uinMatch = checkUrl.match(/[?&]uin=([^&]+)/);
      if (!sigxMatch?.[1] || !uinMatch?.[1]) {
        throw new Error('解析 QQ 授权跳转链接失败');
      }

      const cred = await this._exchangeQQOAuth({
        uin: uinMatch[1],
        ptsigx: sigxMatch[1],
        qqNick: args[5] || ''
      });
      return {
        state: 'authorized',
        message: 'QQ 音乐登录成功！已开启实时拉取',
        ...cred
      };
    }

    return { state: 'waiting', message: '等待确认中…' };
  }

  async verifyManualCredentials({ cookie = '', userid = '', token = '', nickname = '' } = {}) {
    const parsed = parseQQMusicCookie(cookie, { userid, token });
    if (!parsed.userid || !/^\d+$/.test(parsed.userid) || !parsed.musickey || parsed.musickey.length < 10) {
      throw new Error(
        '无效的 QQ 音乐凭证，请粘贴 y.qq.com 的完整 Cookie（含 uin 与 qm_keyst/qqmusic_key），或分别填写 QQ号/musicid 与 qm_keyst'
      );
    }

    const displayNick =
      String(nickname || '').trim() || `QQ音乐会员(${parsed.userid.slice(-4)})`;

    return {
      platform: 'qq',
      userid: parsed.userid,
      token: parsed.musickey,
      nickname: displayNick
    };
  }

  _normalizeSongItem(rawSong, category = 'chart', allowVip = false) {
    const mid = rawSong?.mid || rawSong?.songmid || '';
    const songname = String(rawSong?.name || rawSong?.title || rawSong?.songname || '').trim();
    if (!mid || !songname) return null;

    const singers = Array.isArray(rawSong.singer) ? rawSong.singer : [];
    const singerName = singers.map((s) => s?.name).filter(Boolean).join(' / ') || '华语歌手';
    const durationSec = Number(rawSong.interval || 0);
    const payPlay = Number(rawSong?.pay?.pay_play ?? rawSong?.pay?.payplay ?? 0);
    const privilege = payPlay === 1 ? 10 : 0;

    const syntheticTrack = {
      songname,
      singername: singerName,
      privilege,
      duration: durationSec
    };
    if (!isValidMandarinSong(syntheticTrack, { allowVip })) return null;

    const canonicalTitle = extractCanonicalTitle(songname);
    const normalizedCanonical = normalizeGuess(canonicalTitle);
    if (!normalizedCanonical) return null;

    const albumMid = rawSong?.album?.mid || rawSong?.albummid || '';
    const mediaMid = rawSong?.file?.media_mid || mid;

    return {
      platform: 'qq',
      hash: `qq_${mid}`,
      mid,
      mediaMid,
      rawSongName: songname,
      canonicalTitle,
      normalizedCanonical,
      singerName,
      duration: durationSec,
      privilege,
      albumImg: albumMid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
        : '',
      category,
      sourceTag: 'QQ音乐'
    };
  }

  /**
   * Real-time dynamic Mandarin song sampling from QQ Music's live online catalog.
   */
  async sampleLiveSongs({
    category = 'all',
    allowVip = false,
    customKeyword = ''
  } = {}) {
    const candidates = new Map();
    const queries = pickRandomQueriesForCategory(category, 2, customKeyword);
    const tasks = [];

    for (const q of queries) {
      tasks.push(async () => {
        try {
          const res = await fetchWithTimeout(
            'https://u.y.qq.com/cgi-bin/musicu.fcg',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Referer: 'https://y.qq.com/'
              },
              body: JSON.stringify({
                comm: { ct: 19, cv: 1859, uin: '0' },
                req: {
                  module: 'music.search.SearchCgiService',
                  method: 'DoSearchForQQMusicDesktop',
                  param: {
                    grp: 1,
                    num_per_page: 30,
                    page_num: q.page,
                    query: q.keyword,
                    search_type: 0
                  }
                }
              })
            },
            4500
          );
          if (!res.ok) return;
          const json = await res.json();
          const list = json?.req?.data?.body?.song?.list || [];
          for (const item of list) {
            const norm = this._normalizeSongItem(item, q.category, allowVip);
            if (norm && !candidates.has(norm.hash)) {
              candidates.set(norm.hash, norm);
            }
          }
        } catch {
          // Ignore individual query timeout
        }
      });
    }

    if (!String(customKeyword || '').trim()) {
      const matchingTops =
        category === 'all'
          ? QQ_TOPLISTS
          : QQ_TOPLISTS.filter((t) => t.category === category);
      const topPool = matchingTops.length > 0 ? matchingTops : QQ_TOPLISTS;
      const pickedTop = topPool[Math.floor(Math.random() * topPool.length)];
      const offset = [0, 30][Math.floor(Math.random() * 2)];

      tasks.push(async () => {
        try {
          const res = await fetchWithTimeout(
            'https://u.y.qq.com/cgi-bin/musicu.fcg',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'QQMusic 20090008(android 13)'
              },
              body: JSON.stringify({
                comm: {
                  ct: '11',
                  cv: '20090008',
                  v: '20090008',
                  chid: '10003505',
                  tmeAppID: 'qqmusic',
                  format: 'json'
                },
                top: {
                  module: 'music.musicToplist.Toplist',
                  method: 'GetDetail',
                  param: {
                    topId: pickedTop.topId,
                    offset,
                    num: 40,
                    withTags: 1
                  }
                }
              })
            },
            4500
          );
          if (!res.ok) return;
          const json = await res.json();
          const list = json?.top?.data?.songInfoList || [];
          for (const item of list) {
            const norm = this._normalizeSongItem(item, pickedTop.category, allowVip);
            if (norm && !candidates.has(norm.hash)) {
              candidates.set(norm.hash, norm);
            }
          }
        } catch {
          // Ignore individual toplist timeout
        }
      });
    }

    await Promise.all(tasks.map((fn) => fn()));
    return Array.from(candidates.values());
  }

  async resolveStreamUrl(track, authSession = null) {
    const mid = track?.mid || String(track?.hash || '').replace(/^qq_/, '');
    if (!mid) return null;
    const mediaMid = track?.mediaMid || mid;

    const uin = authSession?.userid ? String(authSession.userid) : '0';
    const musickey = authSession?.token ? String(authSession.token) : '';
    const loginType = musickey.startsWith('W_X') ? '1' : '2';

    const filenames = musickey
      ? [`M800${mediaMid}.mp3`, `M500${mediaMid}.mp3`, `C400${mediaMid}.m4a`]
      : [`M500${mediaMid}.mp3`, `C400${mediaMid}.m4a`];
    const songmids = filenames.map(() => mid);
    const songtypes = filenames.map(() => 0);

    const headers = {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/'
    };
    const comm = {
      uin,
      format: 'json',
      ct: 24,
      cv: 4747474,
      platform: 'yqq.json',
      g_tk: musickey ? hash33(musickey, 5381) : 5381
    };

    if (musickey && uin !== '0') {
      comm.qq = uin;
      comm.authst = musickey;
      comm.tmeLoginType = loginType;
      headers.Cookie = `uin=${uin}; qqmusic_uin=${uin}; qm_keyst=${musickey}; qqmusic_key=${musickey}`;
    }

    try {
      const res = await fetchWithTimeout(
        'https://u.y.qq.com/cgi-bin/musicu.fcg',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            comm,
            vkey: {
              module: 'vkey.GetVkeyServer',
              method: 'CgiGetVkey',
              param: {
                guid: this.guid,
                filename: filenames,
                songmid: songmids,
                songtype: songtypes,
                uin,
                loginflag: 1,
                platform: '20'
              }
            }
          })
        },
        5000
      );
      if (!res.ok) return null;

      const json = await res.json();
      const vkeyData = json?.vkey?.data;
      const sipList = Array.isArray(vkeyData?.sip) ? vkeyData.sip.filter(Boolean) : [];
      const sipBase = sipList[0] || 'https://isure.stream.qqmusic.qq.com/';
      const midurlinfo = Array.isArray(vkeyData?.midurlinfo) ? vkeyData.midurlinfo : [];

      const matched = midurlinfo.find(
        (m) => typeof m?.purl === 'string' && m.purl.length > 10 && !m.purl.startsWith('RS02')
      );
      if (!matched) return null;

      const duration = Number(track?.duration || 0);
      if (!Number.isFinite(duration) || duration < 60) return null;

      const streamUrl = matched.purl.startsWith('http')
        ? matched.purl
        : `${sipBase.replace(/\/+$/, '')}/${matched.purl.replace(/^\/+/, '')}`;

      return {
        hash: `qq_${mid}`,
        streamUrl,
        duration,
        albumImg: track?.albumImg || '',
        fetchedAt: Date.now()
      };
    } catch {
      return null;
    }
  }
}

export const qqMusicProvider = new QQMusicProvider();

import crypto from 'node:crypto';

const APPID = 1005;
const CLIENTVER = 20489;
const SRCAPPID = 2919;
const VAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DFID_TTL_MS = 6 * 60 * 60 * 1000;

export function md5(input) {
  return crypto.createHash('md5').update(String(input)).digest('hex');
}

export function signWebParams(params, data = '') {
  const salt = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const sorted = Object.keys(params)
    .map((key) => `${key}=${params[key]}`)
    .sort()
    .join('');
  return md5(`${salt}${sorted}${data}${salt}`);
}

export function signAndroidParams(params, data = '') {
  const salt = 'OIlwieks28dk2k092lksi2UIkp';
  const sorted = Object.keys(params)
    .sort()
    .map((key) => {
      const val = params[key];
      return `${key}=${typeof val === 'object' ? JSON.stringify(val) : val}`;
    })
    .join('');
  return md5(`${salt}${sorted}${data}${salt}`);
}

export function signTrackKey(hash, mid, userid = 0, appid = APPID) {
  return md5(`${String(hash).toLowerCase()}57ae12eb6890223e355ccfcb74edf70d${appid}${mid}${userid || 0}`);
}

export function parseCookieCredentials(cookieStr = '') {
  const out = {};
  for (const part of String(cookieStr).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  const token = out.token || out.t || '';
  const userid = out.userid || out.KugooID || out.uid || '';
  const nickname = out.KuGoo ? decodeURIComponent(out.KuGoo).slice(0, 20) : '';
  return { token, userid, nickname };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class KuGouAuthManager {
  constructor() {
    this.midHex = md5(crypto.randomUUID());
    this.uuidHex = md5(`${this.midHex}_uuid`);
    this.decMid = BigInt(`0x${this.midHex}`).toString(10);
    this.dfid = '';
    this.dfidFetchedAt = 0;
    this.dfidPromise = null;
    this.authVault = new Map(); // authTicket -> { userid, token, nickname, pic, createdAt }
  }

  _pruneVault() {
    const now = Date.now();
    for (const [ticket, entry] of this.authVault.entries()) {
      if (now - entry.createdAt > VAULT_TTL_MS) {
        this.authVault.delete(ticket);
      }
    }
  }

  storeAuthSession({ userid, token, nickname, pic = '' }) {
    this._pruneVault();
    const cleanUid = String(userid || '').trim();
    const cleanToken = String(token || '').trim();
    if (!/^\d+$/.test(cleanUid) || cleanToken.length < 8) {
      throw new Error('无效的酷狗 userid 或 token');
    }

    const authTicket = `kg_${crypto.randomBytes(18).toString('hex')}`;
    const displayNick =
      String(nickname || '').trim() || `酷狗会员(${cleanUid.slice(-4)})`;

    const session = {
      userid: cleanUid,
      token: cleanToken,
      nickname: displayNick,
      pic,
      createdAt: Date.now()
    };
    this.authVault.set(authTicket, session);
    return {
      authTicket,
      userid: cleanUid,
      nickname: displayNick,
      pic
    };
  }

  getAuthSession(authTicket) {
    if (!authTicket) return null;
    this._pruneVault();
    return this.authVault.get(authTicket) || null;
  }

  revokeAuthTicket(authTicket) {
    if (authTicket) {
      this.authVault.delete(authTicket);
    }
  }

  getEnvDefaultSession() {
    const userid = String(process.env.KUGOU_VIP_USERID || '').trim();
    const token = String(process.env.KUGOU_VIP_TOKEN || '').trim();
    if (/^\d+$/.test(userid) && token.length >= 8) {
      return {
        userid,
        token,
        nickname: '系统默认会员',
        isEnvDefault: true
      };
    }
    return null;
  }

  async ensureDeviceRegistered() {
    if (this.dfid && Date.now() - this.dfidFetchedAt < DFID_TTL_MS) {
      return this.dfid;
    }
    if (this.dfidPromise) return this.dfidPromise;

    this.dfidPromise = (async () => {
      const regParams = {
        appid: 1014,
        platid: 4,
        clientver: 20000,
        clienttime: Math.floor(Date.now() / 1000),
        mid: this.midHex,
        uuid: this.uuidHex,
        userid: 0,
        'p.token': ''
      };
      const sortedVals = Object.values(regParams).sort().join('');
      regParams.signature = md5(`1014${sortedVals}1014`);

      const payload = Buffer.from(
        JSON.stringify({
          mid: this.midHex,
          uuid: this.uuidHex,
          appid: '1014',
          userid: '0'
        })
      ).toString('base64');

      const url = `https://userservice.kugou.com/risk/v1/r_register_dev?${new URLSearchParams(
        regParams
      ).toString()}`;
      const json = await fetchJsonWithTimeout(url, {
        method: 'POST',
        body: payload
      });

      const resolvedDfid = json?.data?.dfid;
      if (resolvedDfid && typeof resolvedDfid === 'string') {
        this.dfid = resolvedDfid;
        this.dfidFetchedAt = Date.now();
      } else if (!this.dfid) {
        this.dfid = crypto.randomBytes(12).toString('hex');
        this.dfidFetchedAt = Date.now();
      }
      return this.dfid;
    })().finally(() => {
      this.dfidPromise = null;
    });

    return this.dfidPromise;
  }

  /**
   * Generate an official KuGou login QR code (returns key + base64 PNG image).
   */
  async createQrCode() {
    const clienttime = Math.floor(Date.now() / 1000);
    const params = {
      dfid: this.dfid || '-',
      mid: this.decMid,
      uuid: '-',
      appid: 1001,
      clientver: CLIENTVER,
      clienttime,
      type: 1,
      plat: 4,
      qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APPID}&`,
      srcappid: SRCAPPID
    };
    params.signature = signWebParams(params);

    const url = `https://login-user.kugou.com/v2/qrcode?${new URLSearchParams(params).toString()}`;
    const json = await fetchJsonWithTimeout(url);

    const qrKey = json?.data?.qrcode;
    const qrImgBase64 = json?.data?.qrcode_img;
    if (!qrKey || !qrImgBase64) {
      throw new Error('获取酷狗登录二维码失败，请稍后重试');
    }

    return {
      qrKey,
      qrImgBase64,
      qrUrl: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${qrKey}`
    };
  }

  /**
   * Poll QR code scan status:
   * 0 = expired, 1 = waiting, 2 = scanned awaiting confirm, 4 = authorized
   */
  async checkQrCode(qrKey) {
    if (!qrKey) {
      throw new Error('缺少二维码标识 key');
    }

    const clienttime = Math.floor(Date.now() / 1000);
    const params = {
      dfid: this.dfid || '-',
      mid: this.decMid,
      uuid: '-',
      appid: APPID,
      clientver: CLIENTVER,
      clienttime,
      plat: 4,
      srcappid: SRCAPPID,
      qrcode: String(qrKey)
    };
    params.signature = signWebParams(params);

    const url = `https://login-user.kugou.com/v2/get_userinfo_qrcode?${new URLSearchParams(
      params
    ).toString()}`;
    const json = await fetchJsonWithTimeout(url);
    const data = json?.data;

    if (!data || typeof data.status === 'undefined') {
      return { state: 'waiting', message: '等待酷狗 APP 扫码…' };
    }

    const code = Number(data.status);
    if (code === 0) {
      return { state: 'expired', message: '二维码已过期，请点击刷新' };
    }
    if (code === 1) {
      return { state: 'waiting', message: '请打开手机酷狗音乐 APP 扫码' };
    }
    if (code === 2) {
      return {
        state: 'scanned',
        nickname: data.nickname || '',
        pic: data.pic || '',
        message: '已扫码，请在手机上点击确认登录'
      };
    }
    if (code === 4 && data.token && data.userid) {
      const saved = this.storeAuthSession({
        userid: data.userid,
        token: data.token,
        nickname: data.nickname,
        pic: data.pic
      });
      return {
        state: 'authorized',
        message: '登录成功！已解锁会员实时拉取',
        ...saved
      };
    }

    return { state: 'waiting', message: '等待确认中…' };
  }

  /**
   * Resolve full-length stream URL via signed KuGou v5 tracker gateway using user's VIP session.
   */
  async resolveV5StreamUrl({ hash, albumId = 0, albumAudioId = 0, authSession = null }) {
    if (!hash) return null;
    const dfid = await this.ensureDeviceRegistered();
    const clienttime = Math.floor(Date.now() / 1000);
    const userid = Number(authSession?.userid || 0);
    const token = String(authSession?.token || '');
    const cleanHash = String(hash).toLowerCase();

    const params = {
      dfid,
      mid: this.decMid,
      uuid: '-',
      appid: APPID,
      clientver: 11430,
      clienttime,
      album_id: Number(albumId || 0),
      area_code: 1,
      hash: cleanHash,
      ssa_flag: 'is_fromtrack',
      version: 11430,
      page_id: 151369488,
      quality: 128,
      album_audio_id: Number(albumAudioId || 0),
      behavior: 'play',
      pid: 2,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: 0,
      ppage_id: '463467626,350369493,788954147',
      cdnBackup: 1,
      module: ''
    };

    if (token) params.token = token;
    if (userid > 0) params.userid = userid;

    params.key = signTrackKey(cleanHash, this.decMid, userid, APPID);
    params.signature = signAndroidParams(params);

    const url = `https://gateway.kugou.com/v5/url?${new URLSearchParams(params).toString()}`;
    const json = await fetchJsonWithTimeout(url, {
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'x-router': 'trackercdn.kugou.com',
        dfid,
        mid: this.decMid,
        clienttime: String(clienttime),
        'kg-rc': '1',
        'kg-thash': '5d816a0',
        'kg-rec': '1',
        'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F'
      }
    });

    const streamUrl = Array.isArray(json?.url) ? json.url[0] : '';
    const duration = Number(json?.timeLength || 0);
    if (json?.status !== 1 || !streamUrl || !streamUrl.startsWith('http') || duration < 60) {
      return null;
    }

    const coverRaw = json?.trans_param?.union_cover || '';
    return {
      hash: cleanHash,
      streamUrl,
      duration,
      albumImg: coverRaw ? coverRaw.replace('{size}', '400') : '',
      fetchedAt: Date.now()
    };
  }
}

export const kugouAuth = new KuGouAuthManager();
export { KuGouAuthManager };

import { Readable } from 'node:stream';
import {
  extractCanonicalTitle,
  isValidMandarinSong,
  normalizeGuess,
  parseKuGouTrackItem,
  pickRandomFirstHalfOffset
} from './songUtils.js';
import { kugouAuth } from './kugouAuth.js';
import { pickRandomQueriesForCategory } from './mandarinCatalog.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const MANDARIN_RANK_IDS = [
  // 流行热歌 (chart)
  { id: 31308, pages: [1, 2, 3, 4], name: '内地榜', category: 'chart' },
  { id: 8888, pages: [1, 2, 3, 4, 5], name: 'TOP500', category: 'chart' },
  { id: 6666, pages: [1, 2, 3], name: '飙升榜', category: 'chart' },
  { id: 74534, pages: [1, 2, 3], name: '新歌榜', category: 'chart' },
  { id: 85897, pages: [1, 2, 3], name: '国潮音乐榜', category: 'chart' },
  { id: 49224, pages: [1, 2, 3], name: '00后热歌榜', category: 'chart' },
  { id: 44412, pages: [1, 2], name: '说唱先锋榜', category: 'chart' },
  { id: 46910, pages: [1, 2], name: '综艺新歌榜', category: 'chart' },
  { id: 82831, pages: [1, 2], name: '网络热歌榜', category: 'chart' },
  { id: 51340, pages: [1, 2], name: '伤感榜', category: 'chart' },
  // 经典怀旧 (classic)
  { id: 49225, pages: [1, 2, 3], name: '80后热歌榜', category: 'classic' },
  { id: 49223, pages: [1, 2, 3], name: '90后热歌榜', category: 'classic' },
  { id: 54848, pages: [1, 2], name: '台湾地区榜', category: 'classic' },
  { id: 60170, pages: [1], name: '闽南语榜', category: 'classic' },
  // 民谣摇滚 (folk_rock)
  { id: 51341, pages: [1, 2, 3], name: '民谣榜', category: 'folk_rock' },
  { id: 30972, pages: [1, 2], name: '酷狗原创榜', category: 'folk_rock' },
  // 粤语影视 (cantonese_ost)
  { id: 31313, pages: [1, 2], name: '香港地区榜', category: 'cantonese_ost' },
  { id: 33165, pages: [1, 2], name: '粤语金曲榜', category: 'cantonese_ost' },
  { id: 33163, pages: [1, 2], name: '影视金曲榜', category: 'cantonese_ost' },
  { id: 80025, pages: [1], name: '国乐榜', category: 'cantonese_ost' }
];

const MANDARIN_PLAYLISTS = [
  // 经典怀旧
  { id: 7219291, pages: [1, 2, 3, 4, 5, 6], name: '声生不息·华语金曲', category: 'classic' },
  { id: 656333, pages: [1], name: '滚石经典华语', category: 'classic' },
  { id: 510482, pages: [1], name: '台湾民歌四十年', category: 'classic' },
  { id: 18476, pages: [1], name: '80年代怀旧金曲', category: 'classic' },
  { id: 6848366, pages: [1], name: '90后校园华语回忆', category: 'classic' },
  { id: 8552152, pages: [1, 2], name: '歌手历届金曲', category: 'classic' },
  { id: 9569837, pages: [1], name: '歌手经典原曲', category: 'classic' },
  // 民谣摇滚
  { id: 724577, pages: [1], name: '中国摇滚40年', category: 'folk_rock' },
  { id: 33308, pages: [1], name: '中国摇滚编年史', category: 'folk_rock' },
  { id: 360364, pages: [1], name: '华语民谣故事', category: 'folk_rock' },
  { id: 126340, pages: [1], name: '校园毕业民谣', category: 'folk_rock' },
  { id: 154590, pages: [1], name: '青春民谣精选', category: 'folk_rock' },
  { id: 4327475, pages: [1], name: '校园情怀民谣', category: 'folk_rock' },
  { id: 8584632, pages: [1], name: '华语故事感民谣', category: 'folk_rock' },
  // 粤语影视
  { id: 5269215, pages: [1], name: 'BEYOND粤语精选', category: 'cantonese_ost' },
  { id: 2105634, pages: [1], name: '四大名著影视金曲', category: 'cantonese_ost' },
  { id: 117496, pages: [1], name: '华语影视好歌', category: 'cantonese_ost' },
  { id: 611362, pages: [1], name: '经典影视金曲', category: 'cantonese_ost' },
  { id: 2770035, pages: [1], name: '台湾偶像剧OST', category: 'cantonese_ost' },
  { id: 8056298, pages: [1], name: '国风漫游热歌', category: 'cantonese_ost' },
  { id: 8525700, pages: [1], name: '国风精选', category: 'cantonese_ost' },
  // 流行热歌
  { id: 3737336, pages: [1, 2, 3], name: '华语流行热歌', category: 'chart' },
  { id: 9126490, pages: [1, 2], name: '流行热歌大全', category: 'chart' }
];

const CLASSIC_SEED_TITLES = [
  '起风了',
  '后来',
  '小幸运',
  '十年',
  '海阔天空',
  '光辉岁月',
  '日不落',
  '隐形的翅膀',
  '泡沫',
  '演员',
  '平凡之路',
  '突然好想你',
  '传奇',
  '勇气',
  '红豆',
  '最美的太阳',
  '只要有你',
  '宝贝对不起',
  '不值得',
  '无问',
  '龙卷风',
  '一念焚心',
  '着魔',
  '不遗憾',
  '快乐颂',
  '月亮代表我的心',
  '甜蜜蜜',
  '朋友',
  '同桌的你',
  '成都',
  '追光者',
  '体面',
  '偏爱',
  '素颜',
  '嘉宾',
  '孤勇者',
  '青花瓷',
  '晴天',
  '七里香',
  '稻香',
  '告白气球',
  '夜空中最亮的星',
  '南山南',
  '消愁',
  '大鱼'
];

const EXTRA_ICONIC_TITLES = [
  '吻别',
  '水手',
  '大海',
  '爱如潮水',
  '过火',
  '忘情水',
  '童话',
  '遇见',
  '绿光',
  '天黑黑',
  '倒带',
  '欧若拉',
  '曹操',
  '江南',
  '一千年以后',
  '可惜没如果',
  '修炼爱情',
  '好久不见',
  '浮夸',
  '富士山下',
  '红玫瑰',
  'K歌之王',
  '突然的自我',
  '挪威的森林',
  '浪人情歌',
  '蓝莲花',
  '曾经的你',
  '生如夏花',
  '那些花儿',
  '倔强',
  '知足',
  '温柔',
  '小情歌',
  '斑马斑马',
  '理想三旬',
  '春风十里',
  '像我这样的人',
  '平凡的一天',
  '凉凉',
  '年少有为',
  '模特',
  '李白',
  '不将就',
  '说散就散',
  '光年之外',
  '逆战',
  '天下',
  '断桥残雪',
  '庐州月',
  '认真的雪',
  '丑八怪',
  '刚刚好',
  '这世界那么多人',
  '如愿',
  '海底',
  '爱你',
  '遗失的美好',
  '我们的爱',
  '月牙湾',
  '千千阙歌',
  '讲不出再见',
  '真的爱你',
  '喜欢你',
  '不再犹豫'
];

const REPRESENTATIVE_ARTISTS = [
  { name: '周杰伦', category: 'classic' },
  { name: '林俊杰', category: 'classic' },
  { name: '陈奕迅', category: 'classic' },
  { name: '邓紫棋', category: 'chart' },
  { name: '薛之谦', category: 'chart' },
  { name: '毛不易', category: 'folk_rock' },
  { name: '周深', category: 'chart' },
  { name: '张杰', category: 'chart' },
  { name: '李荣浩', category: 'chart' },
  { name: '汪苏泷', category: 'chart' },
  { name: '许嵩', category: 'classic' },
  { name: '王菲', category: 'classic' },
  { name: '那英', category: 'classic' },
  { name: '孙燕姿', category: 'classic' },
  { name: '蔡依林', category: 'classic' },
  { name: '张韶涵', category: 'classic' },
  { name: '梁静茹', category: 'classic' },
  { name: '莫文蔚', category: 'classic' },
  { name: '刘若英', category: 'classic' },
  { name: '五月天', category: 'folk_rock' },
  { name: 'BEYOND', category: 'cantonese_ost' },
  { name: '伍佰', category: 'folk_rock' },
  { name: '张学友', category: 'classic' },
  { name: '刘德华', category: 'classic' },
  { name: '王杰', category: 'classic' },
  { name: '齐秦', category: 'classic' },
  { name: '周华健', category: 'classic' },
  { name: '任贤齐', category: 'classic' },
  { name: '李宗盛', category: 'classic' },
  { name: '罗大佑', category: 'classic' },
  { name: '邓丽君', category: 'classic' },
  { name: '蔡琴', category: 'classic' },
  { name: '张国荣', category: 'cantonese_ost' },
  { name: '梅艳芳', category: 'cantonese_ost' },
  { name: '陈慧娴', category: 'cantonese_ost' },
  { name: '杨千嬅', category: 'cantonese_ost' },
  { name: '容祖儿', category: 'cantonese_ost' },
  { name: '古巨基', category: 'cantonese_ost' },
  { name: '李克勤', category: 'cantonese_ost' },
  { name: '谭咏麟', category: 'cantonese_ost' },
  { name: '陶喆', category: 'classic' },
  { name: '王力宏', category: 'classic' },
  { name: '潘玮柏', category: 'classic' },
  { name: '张震岳', category: 'folk_rock' },
  { name: '苏打绿', category: 'folk_rock' },
  { name: '告五人', category: 'folk_rock' },
  { name: '逃跑计划', category: 'folk_rock' },
  { name: '朴树', category: 'folk_rock' },
  { name: '许巍', category: 'folk_rock' },
  { name: '郑钧', category: 'folk_rock' },
  { name: '汪峰', category: 'folk_rock' },
  { name: '痛仰', category: 'folk_rock' },
  { name: '新裤子', category: 'folk_rock' },
  { name: '赵雷', category: 'folk_rock' },
  { name: '陈粒', category: 'folk_rock' },
  { name: '宋冬野', category: 'folk_rock' },
  { name: '房东的猫', category: 'folk_rock' },
  { name: '凤凰传奇', category: 'chart' },
  { name: '刀郎', category: 'classic' },
  { name: '韩红', category: 'classic' },
  { name: '孙楠', category: 'classic' },
  { name: '李健', category: 'folk_rock' },
  { name: '张信哲', category: 'classic' },
  { name: '张宇', category: 'classic' },
  { name: '林宥嘉', category: 'classic' },
  { name: '萧敬腾', category: 'classic' },
  { name: '杨宗纬', category: 'classic' },
  { name: 'A-Lin', category: 'classic' },
  { name: '张碧晨', category: 'cantonese_ost' },
  { name: '单依纯', category: 'chart' },
  { name: '郁可唯', category: 'cantonese_ost' },
  { name: '胡夏', category: 'cantonese_ost' },
  { name: '周兴哲', category: 'chart' },
  { name: '颜人中', category: 'chart' },
  { name: '王赫野', category: 'chart' },
  { name: '华晨宇', category: 'chart' },
  { name: '张靓颖', category: 'cantonese_ost' },
  { name: '蔡健雅', category: 'classic' },
  { name: '戴佩妮', category: 'classic' },
  { name: '徐佳莹', category: 'classic' },
  { name: '方大同', category: 'classic' },
  { name: '郭顶', category: 'folk_rock' }
];

const DYNAMIC_PLAYLIST_KEYWORDS = [
  { kw: '华语金曲', category: 'classic' },
  { kw: '华语经典', category: 'classic' },
  { kw: '华语民谣', category: 'folk_rock' },
  { kw: '华语摇滚', category: 'folk_rock' },
  { kw: '粤语经典', category: 'cantonese_ost' },
  { kw: '影视金曲', category: 'cantonese_ost' },
  { kw: '国风热歌', category: 'cantonese_ost' },
  { kw: '校园民谣', category: 'folk_rock' }
];

const POOL_TTL_MS = 30 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': MOBILE_UA,
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonSafe(url, options = {}, timeoutMs = 5500) {
  try {
    const res = await fetchWithTimeout(url, options, timeoutMs);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function runWithConcurrency(taskFns, limit = 15) {
  if (!taskFns.length) return;
  let nextIdx = 0;
  const workerCount = Math.min(limit, taskFns.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < taskFns.length) {
      const idx = nextIdx;
      nextIdx += 1;
      try {
        await taskFns[idx]();
      } catch {
        // Ignore individual source failure
      }
    }
  });
  await Promise.all(workers);
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class KuGouMandarinService {
  constructor() {
    this.pool = [];
    this.vipPool = [];
    this.lastLoadedAt = 0;
    this.loadingPromise = null;
    this.expandPromise = null;
    this.streamCache = new Map();
  }

  async ensurePoolLoaded(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.pool.length > 0 && now - this.lastLoadedAt < POOL_TTL_MS) {
      return this.pool;
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this._buildMandarinPool()
      .then(({ freeSongs, vipSongs }) => {
        if (freeSongs.length > 0) {
          this.pool = freeSongs;
          this.vipPool = vipSongs;
          this.lastLoadedAt = Date.now();
        }
        return this.pool;
      })
      .finally(() => {
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  getPoolStats() {
    const categories = {
      classic: 0,
      chart: 0,
      folk_rock: 0,
      cantonese_ost: 0
    };
    const canonicalSet = new Set();
    const allWithVipSet = new Set();
    for (const s of this.pool) {
      if (Object.hasOwn(categories, s.category)) {
        categories[s.category] += 1;
      } else {
        categories.chart += 1;
      }
      canonicalSet.add(s.normalizedCanonical);
      allWithVipSet.add(s.normalizedCanonical);
    }
    for (const v of this.vipPool) {
      allWithVipSet.add(v.normalizedCanonical);
    }
    return {
      totalTracks: this.pool.length,
      uniqueSongs: canonicalSet.size,
      vipTracks: this.vipPool.length,
      totalWithVipUniqueSongs: allWithVipSet.size,
      classicCount: categories.classic,
      chartCount: categories.chart,
      categories
    };
  }

  _collectCandidate(freeMap, vipMap, rawItem, category, sourceTag) {
    const parsed = parseKuGouTrackItem(rawItem);
    if (!parsed.hash || !isValidMandarinSong(parsed, { allowVip: true })) return;

    const canonicalTitle = extractCanonicalTitle(parsed.songname);
    const normalizedCanonical = normalizeGuess(canonicalTitle);
    if (!normalizedCanonical) return;

    const targetMap = parsed.privilege === 10 ? vipMap : freeMap;
    if (!targetMap) return;

    const existing = targetMap.get(parsed.hash);
    if (existing) {
      if (category === 'classic' && existing.category === 'chart') {
        existing.category = 'classic';
      }
      return;
    }

    targetMap.set(parsed.hash, {
      platform: 'kugou',
      hash: parsed.hash,
      albumId: parsed.albumId,
      albumAudioId: parsed.albumAudioId,
      rawSongName: parsed.songname,
      canonicalTitle,
      normalizedCanonical,
      singerName: parsed.singername || '华语群星',
      duration: parsed.duration,
      privilege: parsed.privilege,
      category,
      sourceTag: '酷狗音乐'
    });
  }

  _deduplicateTracks(candidateMap, existingTracks = []) {
    const seenHashes = new Set(existingTracks.map((t) => t.hash));
    const perTitleCount = new Map();
    for (const t of existingTracks) {
      perTitleCount.set(
        t.normalizedCanonical,
        (perTitleCount.get(t.normalizedCanonical) || 0) + 1
      );
    }

    const merged = [...existingTracks];
    for (const track of candidateMap.values()) {
      if (seenHashes.has(track.hash)) continue;
      const cnt = perTitleCount.get(track.normalizedCanonical) || 0;
      if (cnt >= 2) continue;
      seenHashes.add(track.hash);
      perTitleCount.set(track.normalizedCanonical, cnt + 1);
      merged.push(track);
    }
    return merged;
  }

  async _buildMandarinPool() {
    const freeMap = new Map();
    const vipMap = new Map();
    const tasks = [];

    for (const pl of MANDARIN_PLAYLISTS) {
      for (const page of pl.pages) {
        const url = `http://mobilecdn.kugou.com/api/v3/special/song?format=json&specialid=${pl.id}&page=${page}&pagesize=100`;
        tasks.push(async () => {
          const data = await fetchJsonSafe(url);
          const list = data?.data?.info || [];
          for (const item of list) {
            this._collectCandidate(freeMap, vipMap, item, pl.category, pl.name);
          }
        });
      }
    }

    for (const rank of MANDARIN_RANK_IDS) {
      for (const page of rank.pages) {
        const url = `http://m.kugou.com/rank/info/?rankid=${rank.id}&page=${page}&json=true`;
        tasks.push(async () => {
          const data = await fetchJsonSafe(url);
          const list = data?.songs?.list || [];
          for (const item of list) {
            this._collectCandidate(freeMap, vipMap, item, rank.category, `酷狗${rank.name}`);
          }
        });
      }
    }

    for (const kw of CLASSIC_SEED_TITLES) {
      const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(
        kw
      )}&page=1&pagesize=20`;
      const targetNorm = normalizeGuess(kw);
      tasks.push(async () => {
        const data = await fetchJsonSafe(url);
        const list = data?.data?.info || [];
        let freeAdded = 0;
        let vipAdded = 0;
        for (const item of list) {
          const parsed = parseKuGouTrackItem(item);
          if (!isValidMandarinSong(parsed, { allowVip: true })) continue;
          const canon = extractCanonicalTitle(parsed.songname);
          if (normalizeGuess(canon) !== targetNorm) continue;
          if (parsed.privilege === 10 && vipAdded < 2) {
            this._collectCandidate(freeMap, vipMap, item, 'classic', 'VIP华语经典');
            vipAdded += 1;
          } else if (parsed.privilege !== 10 && freeAdded < 2) {
            this._collectCandidate(freeMap, vipMap, item, 'classic', '华语经典曲库');
            freeAdded += 1;
          }
        }
      });
    }

    await runWithConcurrency(tasks, 15);
    return {
      freeSongs: this._deduplicateTracks(freeMap),
      vipSongs: this._deduplicateTracks(vipMap)
    };
  }

  /**
   * Deep background crawl for the live server daemon: expands the Mandarin pool
   * across 80+ representative Chinese artists, additional classic titles, and dynamic playlists.
   */
  async expandPoolInBackground() {
    if (this.expandPromise) return this.expandPromise;

    this.expandPromise = (async () => {
      await this.ensurePoolLoaded();
      const freeMap = new Map();
      const vipMap = new Map();
      const tasks = [];

      for (const artist of REPRESENTATIVE_ARTISTS) {
        const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(
          artist.name
        )}&page=1&pagesize=30`;
        tasks.push(async () => {
          const data = await fetchJsonSafe(url);
          const list = data?.data?.info || [];
          for (const item of list) {
            this._collectCandidate(freeMap, vipMap, item, artist.category, `华语精选·${artist.name}`);
          }
        });
      }

      for (const kw of EXTRA_ICONIC_TITLES) {
        const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(
          kw
        )}&page=1&pagesize=20`;
        const targetNorm = normalizeGuess(kw);
        tasks.push(async () => {
          const data = await fetchJsonSafe(url);
          const list = data?.data?.info || [];
          let freeAdded = 0;
          let vipAdded = 0;
          for (const item of list) {
            const parsed = parseKuGouTrackItem(item);
            if (!isValidMandarinSong(parsed, { allowVip: true })) continue;
            const canon = extractCanonicalTitle(parsed.songname);
            if (normalizeGuess(canon) !== targetNorm) continue;
            if (parsed.privilege === 10 && vipAdded < 2) {
              this._collectCandidate(freeMap, vipMap, item, 'classic', 'VIP华语经典');
              vipAdded += 1;
            } else if (parsed.privilege !== 10 && freeAdded < 2) {
              this._collectCandidate(freeMap, vipMap, item, 'classic', '华语经典曲库');
              freeAdded += 1;
            }
          }
        });
      }

      for (const entry of DYNAMIC_PLAYLIST_KEYWORDS) {
        tasks.push(async () => {
          const searchUrl = `http://mobilecdn.kugou.com/api/v3/search/special?format=json&keyword=${encodeURIComponent(
            entry.kw
          )}&page=1&pagesize=5`;
          const searchData = await fetchJsonSafe(searchUrl);
          const playlists = (searchData?.data?.info || []).filter((p) => p.specialid).slice(0, 3);
          for (const sp of playlists) {
            const listUrl = `http://mobilecdn.kugou.com/api/v3/special/song?format=json&specialid=${sp.specialid}&page=1&pagesize=100`;
            const listData = await fetchJsonSafe(listUrl);
            const items = listData?.data?.info || [];
            for (const item of items) {
              this._collectCandidate(freeMap, vipMap, item, entry.category, sp.specialname || entry.kw);
            }
          }
        });
      }

      await runWithConcurrency(tasks, 12);
      if (freeMap.size > 0) {
        this.pool = this._deduplicateTracks(freeMap, this.pool);
      }
      if (vipMap.size > 0) {
        this.vipPool = this._deduplicateTracks(vipMap, this.vipPool);
      }
      if (freeMap.size > 0 || vipMap.size > 0) {
        this.lastLoadedAt = Date.now();
      }
      return this.pool;
    })().finally(() => {
      this.expandPromise = null;
    });

    return this.expandPromise;
  }

  async resolvePlayInfo(hash) {
    const cached = this.streamCache.get(hash);
    if (cached && Date.now() - cached.fetchedAt < STREAM_CACHE_TTL_MS) {
      return cached;
    }

    const url = `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`;
    const info = await fetchJsonSafe(
      url,
      {
        headers: {
          Referer: `http://m.kugou.com/play/info/${hash}`
        }
      },
      5500
    );

    if (!info || typeof info.url !== 'string' || !info.url.startsWith('http')) {
      return null;
    }

    const duration = Number(info.timeLength || 0);
    if (!Number.isFinite(duration) || duration < 60) {
      return null;
    }

    const albumImgRaw = info.album_img || info.imgUrl || '';
    const albumImg = albumImgRaw.replace('{size}', '400');

    const resolved = {
      hash,
      streamUrl: info.url,
      duration,
      albumImg,
      fetchedAt: Date.now()
    };
    this.streamCache.set(hash, resolved);
    return resolved;
  }

  /**
   * Pick a verified playable Mandarin track not yet used in this match,
   * and compute a random playback start offset strictly in [0, duration * 0.5).
   * When authSession (or env VIP) is active, unlocks VIP studio tracks in real time.
   */
  async pickPlayableRoundSong({
    usedHashes = new Set(),
    usedCanonicalTitles = new Set(),
    category = 'all',
    authSession = null
  } = {}) {
    await this.ensurePoolLoaded();
    if (this.pool.length === 0 && this.vipPool.length === 0) {
      throw new Error('酷狗华语曲库加载失败，请稍后重试');
    }

    const effectiveAuth = authSession || kugouAuth.getEnvDefaultSession();
    const validFilterCategories = new Set(['classic', 'chart', 'folk_rock', 'cantonese_ost']);

    const filterByCriteria = (list) => {
      let filtered = list.filter((item) => {
        if (usedHashes.has(item.hash)) return false;
        if (usedCanonicalTitles.has(item.normalizedCanonical)) return false;
        if (validFilterCategories.has(category)) {
          return item.category === category;
        }
        return true;
      });
      if (filtered.length < 5) {
        filtered = list.filter(
          (item) =>
            !usedHashes.has(item.hash) &&
            !usedCanonicalTitles.has(item.normalizedCanonical)
        );
      }
      if (filtered.length === 0) {
        filtered = list.filter((item) => !usedHashes.has(item.hash));
      }
      if (filtered.length === 0) {
        filtered = [...list];
      }
      return filtered;
    };

    const freeCandidates = shuffleArray(filterByCriteria(this.pool)).slice(0, 14);
    let candidates = freeCandidates;

    if (effectiveAuth && this.vipPool.length > 0) {
      const vipCandidates = shuffleArray(filterByCriteria(this.vipPool)).slice(0, 10);
      // Interleave VIP studio tracks with free tracks so VIP accounts get rich studio hits
      // while non-VIP accounts gracefully fall back to free tracks in the same pass
      candidates = [];
      const maxLen = Math.max(vipCandidates.length, freeCandidates.length);
      for (let i = 0; i < maxLen; i += 1) {
        if (i < vipCandidates.length) candidates.push(vipCandidates[i]);
        if (i < freeCandidates.length) candidates.push(freeCandidates[i]);
      }
    }

    for (const candidate of candidates) {
      let info = null;
      if (effectiveAuth) {
        const cacheKey = `${candidate.hash}:${effectiveAuth.userid}`;
        const cached = this.streamCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < STREAM_CACHE_TTL_MS) {
          info = cached;
        } else {
          info = await kugouAuth.resolveV5StreamUrl({
            hash: candidate.hash,
            albumId: candidate.albumId,
            albumAudioId: candidate.albumAudioId,
            authSession: effectiveAuth
          });
          if (info) {
            this.streamCache.set(cacheKey, info);
          }
        }
      }

      if (!info && candidate.privilege !== 10) {
        info = await this.resolvePlayInfo(candidate.hash);
      }
      if (!info) continue;

      const duration = info.duration;
      const startOffset = pickRandomFirstHalfOffset(duration);
      const startPercent = Number(((startOffset / duration) * 100).toFixed(1));

      return {
        hash: candidate.hash,
        canonicalTitle: candidate.canonicalTitle,
        normalizedCanonical: candidate.normalizedCanonical,
        rawSongName: candidate.rawSongName,
        singerName: candidate.singerName,
        duration,
        startOffset,
        startPercent,
        albumImg: info.albumImg,
        sourceTag: candidate.sourceTag,
        category: candidate.category,
        isVipTrack: candidate.privilege === 10,
        streamUrl: info.streamUrl
      };
    }

    throw new Error('暂无可用的酷狗华语播放源，请稍后重试');
  }

  async getStreamUrlForHash(hash, authSession = null) {
    const effectiveAuth = authSession || kugouAuth.getEnvDefaultSession();
    const cacheKey = effectiveAuth ? `${hash}:${effectiveAuth.userid}` : hash;
    const cached = this.streamCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STREAM_CACHE_TTL_MS) {
      return cached.streamUrl;
    }
    if (effectiveAuth) {
      const vipResolved = await kugouAuth.resolveV5StreamUrl({
        hash,
        authSession: effectiveAuth
      });
      if (vipResolved) {
        this.streamCache.set(cacheKey, vipResolved);
        return vipResolved.streamUrl;
      }
    }
    const resolved = await this.resolvePlayInfo(hash);
    return resolved ? resolved.streamUrl : null;
  }

  /**
   * Real-time dynamic Mandarin song sampling from KuGou's live online search catalog
   * (deep random pagination across 260+ Chinese artists & themes, or custom keyword).
   */
  async sampleLiveSongs({
    category = 'all',
    allowVip = false,
    customKeyword = ''
  } = {}) {
    const freeMap = new Map();
    const vipMap = new Map();
    const queries = pickRandomQueriesForCategory(category, 2, customKeyword);

    await Promise.all(
      queries.map(async (q) => {
        const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(
          q.keyword
        )}&page=${q.page}&pagesize=30`;
        const data = await fetchJsonSafe(url, {}, 4500);
        const list = data?.data?.info || [];
        for (const item of list) {
          this._collectCandidate(freeMap, vipMap, item, q.category, '酷狗音乐');
        }
      })
    );

    const out = [...freeMap.values()];
    if (allowVip) {
      out.push(...vipMap.values());
    }
    return out;
  }

  async proxyAudioStream(req, res, streamUrl) {
    const upstreamHeaders = {
      'User-Agent': MOBILE_UA
    };
    if (/music\.126\.net/i.test(streamUrl)) {
      upstreamHeaders.Referer = 'https://music.163.com/';
    } else if (/qq\.com/i.test(streamUrl)) {
      upstreamHeaders.Referer = 'https://y.qq.com/';
    }
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const controller = new AbortController();
    let readable = null;

    const handleClose = () => {
      controller.abort();
      if (readable && !readable.destroyed) {
        readable.destroy();
      }
    };
    req.on('close', handleClose);

    try {
      const upstream = await fetch(streamUrl, {
        headers: upstreamHeaders,
        signal: controller.signal
      });

      if (!upstream.ok && upstream.status !== 206) {
        res.status(502).json({ error: '音频流获取失败' });
        return;
      }

      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
      const acceptRanges = upstream.headers.get('accept-ranges') || 'bytes';
      const contentRange = upstream.headers.get('content-range');
      const contentLength = upstream.headers.get('content-length');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', acceptRanges);
      if (contentRange) res.setHeader('Content-Range', contentRange);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Cache-Control', 'private, max-age=180');

      if (!upstream.body) {
        res.end();
        return;
      }

      readable = Readable.fromWeb(upstream.body);
      readable.on('error', () => {
        if (!res.headersSent) res.status(502).end();
        else if (!res.writableEnded) res.end();
      });
      readable.pipe(res);
    } catch (err) {
      if (err?.name !== 'AbortError' && !res.headersSent) {
        res.status(502).json({ error: '音频代理异常' });
      }
    } finally {
      req.off('close', handleClose);
    }
  }
}

export const kugouService = new KuGouMandarinService();
export { KuGouMandarinService };

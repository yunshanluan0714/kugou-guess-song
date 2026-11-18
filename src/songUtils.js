/**
 * Pure utilities for KuGou Mandarin song filtering, title normalization,
 * exact guess matching, first-50% random playback offset, and player ranking.
 */

const UNSUITABLE_TAG_REGEX =
  /伴奏|纯音乐|器乐|钢琴|吉他曲|古筝|二胡|笛子|萨克斯|铃声|串烧|慢摇|DJ|喊麦|加快|倍速|0\.8x|1\.2x|片段|试听|助眠|白噪音|胎教|儿歌|Remix/i;

const FOREIGN_SCRIPT_REGEX =
  /[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0e00-\u0e7f\u0600-\u06ff]/;

const CHINESE_CHAR_REGEX = /[\u4e00-\u9fff]/;

const PUNCT_AND_SPACE_REGEX =
  /[\s"'“”‘’《》〈〉【】\[\]()（）,，.。!！?？:：;；·・\-—_~～/\\]+/g;

/**
 * Extract canonical song title by removing bracketed annotations, Live tags,
 * feat. credits, and book title marks.
 * @param {string} rawSongName
 * @returns {string}
 */
export function extractCanonicalTitle(rawSongName) {
  if (typeof rawSongName !== 'string') return '';
  let title = rawSongName.normalize('NFKC').trim();

  // Remove wrapping book-title marks like 《晴天》
  title = title.replace(/[《》〈〉]/g, '');

  // Iteratively strip bracketed suffixes/prefixes like (Live), （合唱版）, 【DJ】, [电影主题曲]
  let prev;
  do {
    prev = title;
    title = title
      .replace(/\s*[\(\[（【][^\)\]）】]*[\)\]）】]\s*/g, ' ')
      .trim();
  } while (title !== prev);

  // Strip trailing "- Live", "- Live版", "Live版", "feat. ..." / "ft. ..."
  title = title
    .replace(/\s*[-—–]\s*(?:live(?:\s*version)?|live版|现场版).*$/i, '')
    .replace(/\s+(?:live(?:\s*version)?|live版)$/i, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, '')
    .trim();

  return title;
}

/**
 * Parse a KuGou track object from search, rank, or playlist responses into
 * normalized { songname, singername, privilege, duration }.
 * @param {Record<string, any>} item
 */
export function parseKuGouTrackItem(item) {
  let songname = (item?.songname || '').trim();
  let singername = (item?.singername || '').trim();

  if ((!songname || !singername) && typeof item?.filename === 'string') {
    const idx = item.filename.indexOf(' - ');
    if (idx !== -1) {
      if (!singername) singername = item.filename.slice(0, idx).trim();
      if (!songname) songname = item.filename.slice(idx + 3).trim();
    } else if (!songname) {
      songname = item.filename.trim();
    }
  }

  return {
    hash: item?.hash || '',
    albumId: String(item?.album_id || ''),
    albumAudioId: Number(item?.album_audio_id ?? item?.MixSongID ?? 0),
    songname,
    singername,
    privilege: Number(item?.privilege ?? -1),
    duration: Number(item?.duration ?? item?.timeLength ?? 0)
  };
}

/**
 * Validate whether a KuGou track is a playable Chinese/Mandarin vocal song
 * suitable for multiplayer guess-the-song gameplay.
 * @param {{ songname?: string, singername?: string, privilege?: number, duration?: number }} track
 * @param {{ allowVip?: boolean }} [options]
 * @returns {boolean}
 */
export function isValidMandarinSong(track, { allowVip = false } = {}) {
  if (!track) return false;
  const privilege = Number(track.privilege);
  const duration = Number(track.duration);

  const validPriv = allowVip
    ? privilege === 0 || privilege === 8 || privilege === 10
    : privilege === 0 || privilege === 8;
  if (!validPriv) return false;
  if (!Number.isFinite(duration) || duration < 90 || duration > 480) return false;

  const songname = String(track.songname || '').trim();
  const singername = String(track.singername || '').trim();
  if (!songname) return false;

  const combined = `${songname} ${singername}`;
  if (FOREIGN_SCRIPT_REGEX.test(combined)) return false;
  if (UNSUITABLE_TAG_REGEX.test(combined)) return false;

  const canonicalTitle = extractCanonicalTitle(songname);
  if (canonicalTitle.length < 1 || canonicalTitle.length > 15) return false;
  if (!CHINESE_CHAR_REGEX.test(canonicalTitle)) return false;

  return true;
}

/**
 * Normalize a user guess or song title for punctuation-insensitive exact comparison.
 * @param {string} text
 * @returns {string}
 */
export function normalizeGuess(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(PUNCT_AND_SPACE_REGEX, '');
}

/**
 * Determine whether a user's guess matches the target song name exactly
 * (after normalizing punctuation, whitespace, and case — never substring matching).
 * @param {string} guessText
 * @param {{ canonicalTitle: string, rawSongName?: string }} song
 * @returns {boolean}
 */
export function isSongNameMatch(guessText, song) {
  if (!song) return false;
  const normalizedGuess = normalizeGuess(guessText);
  if (!normalizedGuess) return false;

  const normalizedCanonical = normalizeGuess(song.canonicalTitle || '');
  if (normalizedCanonical && normalizedGuess === normalizedCanonical) {
    return true;
  }

  const normalizedRaw = normalizeGuess(song.rawSongName || '');
  if (normalizedRaw && normalizedGuess === normalizedRaw) {
    return true;
  }

  return false;
}

/**
 * Pick a random playback start offset (in seconds) strictly within the first 50%
 * of the song duration: 0 <= offset < durationSec * 0.5.
 * @param {number} durationSec
 * @returns {number}
 */
export function pickRandomFirstHalfOffset(durationSec) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return 0;

  const half = duration * 0.5;
  if (half <= 1) return 0;

  let offset;
  if (half > 4) {
    const minOffset = 2;
    const maxExclusive = half - 0.5;
    offset = minOffset + Math.random() * (maxExclusive - minOffset);
  } else {
    offset = Math.random() * half;
  }

  const rounded = Number(offset.toFixed(1));
  const maxAllowed = Number(Math.max(0, half - 0.1).toFixed(1));
  return Math.max(0, Math.min(rounded, maxAllowed));
}

/**
 * Sort and rank players after or during a match.
 * Players with equal scores share the same competition rank (1, 1, 3).
 * @param {Array<Record<string, any>>} players
 * @returns {Array<Record<string, any>>}
 */
export function computeRankings(players) {
  const sorted = [...(players || [])].sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;

    const correctDiff = (b.correctCount || 0) - (a.correctCount || 0);
    if (correctDiff !== 0) return correctDiff;

    const timeDiff = (a.totalCorrectTimeMs ?? Infinity) - (b.totalCorrectTimeMs ?? Infinity);
    if (timeDiff !== 0) return timeDiff;

    return (a.joinedAt || 0) - (b.joinedAt || 0);
  });

  let currentRank = 1;
  return sorted.map((player, index) => {
    if (index > 0 && (player.score || 0) < (sorted[index - 1].score || 0)) {
      currentRank = index + 1;
    }
    return {
      clientId: player.clientId,
      nickname: player.nickname,
      avatarColor: player.avatarColor,
      isBot: Boolean(player.isBot),
      score: player.score || 0,
      correctCount: player.correctCount || 0,
      totalCorrectTimeMs: player.totalCorrectTimeMs || 0,
      rank: currentRank,
      displayOrder: index + 1
    };
  });
}

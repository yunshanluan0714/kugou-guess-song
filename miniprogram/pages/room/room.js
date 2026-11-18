const config = require('../../utils/config');
const app = getApp();

function formatSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

Page({
  data: {
    clientId: '',
    room: null,
    readyCount: 0,
    selfReady: false,
    hasBot: false,
    countdownLeft: 3,
    roundSecondsLeft: 45,
    startOffsetLabel: '00:00',
    durationLabel: '00:00',
    guessText: '',
    showVipPanel: false,
    vipPlatform: 'kugou',
    qrImgBase64: '',
    qrStatusText: '请使用对应音乐 APP 扫码登录',
    vipCookie: ''
  },

  onLoad(options) {
    this.options = options || {};
    this.setData({ clientId: app.globalData.clientId });

    this.audioCtx = wx.createInnerAudioContext();
    this.audioCtx.obeyMuteSwitch = false;
    this.currentAudioKey = null;
    this.seekDoneForRound = false;

    this.audioCtx.onCanplay(() => {
      if (!this.seekDoneForRound && this.pendingSeekOffset > 0) {
        this.seekDoneForRound = true;
        this.audioCtx.seek(this.pendingSeekOffset);
      }
    });

    this.connectSocket();
    this.tickTimer = setInterval(() => this._updateCountdowns(), 300);
  },

  onUnload() {
    clearInterval(this.tickTimer);
    clearInterval(this.qrTimer);
    if (this.socketTask) {
      this._send({ type: 'leave_room' });
      this.socketTask.close();
    }
    if (this.audioCtx) {
      this.audioCtx.stop();
      this.audioCtx.destroy();
    }
  },

  onShareAppMessage() {
    const code = this.data.room?.code || '';
    return {
      title: `来酷狗华语曲库猜歌房 #${code} 一起抢答！`,
      path: `/pages/index/index?room=${code}`
    };
  },

  connectSocket() {
    const task = wx.connectSocket({ url: config.WS_BASE });
    this.socketTask = task;

    task.onOpen(() => {
      const { mode, code, category, duration } = this.options;
      if (mode === 'create') {
        this._send({
          type: 'create_room',
          clientId: app.globalData.clientId,
          nickname: app.globalData.nickname,
          category: category || 'all',
          roundDurationSec: Number(duration || 45),
          isPublic: true
        });
      } else {
        this._send({
          type: 'join_room',
          code,
          clientId: app.globalData.clientId,
          nickname: app.globalData.nickname
        });
      }
    });

    task.onMessage((res) => {
      let msg;
      try {
        msg = JSON.parse(res.data);
      } catch {
        return;
      }
      this._handleMessage(msg);
    });
  },

  _send(payload) {
    if (!this.socketTask) return;
    this.socketTask.send({ data: JSON.stringify(payload) });
  },

  _handleMessage(msg) {
    if (msg.room) {
      const room = msg.room;
      const players = room.players || [];
      const self = players.find((p) => p.clientId === this.data.clientId);
      const round = room.activeRound;

      this.setData({
        room,
        readyCount: players.filter((p) => p.ready).length,
        selfReady: Boolean(self?.ready),
        hasBot: players.some((p) => p.isBot),
        startOffsetLabel: round ? formatSec(round.startOffset) : '00:00',
        durationLabel: round ? formatSec(round.duration) : '00:00'
      });

      if (room.status === 'playing' && round) {
        this._playRoundAudio(room.code, round);
      } else {
        this._stopAudio();
      }
    }

    if (msg.type === 'feed_item' && msg.item && this.data.room) {
      const feed = [...(this.data.room.feed || []), msg.item].slice(-30);
      this.setData({ 'room.feed': feed });
    }

    if (msg.type === 'guess_result') {
      this.setData({ guessText: '' });
    }

    if (msg.type === 'error' && msg.message) {
      wx.showToast({ title: msg.message, icon: 'none' });
    }
  },

  _playRoundAudio(code, round) {
    const key = `${code}:${round.roundNumber}`;
    if (this.currentAudioKey === key) return;
    this.currentAudioKey = key;
    this.seekDoneForRound = false;
    this.pendingSeekOffset = Number(round.startOffset || 0);

    this.audioCtx.stop();
    this.audioCtx.startTime = this.pendingSeekOffset;
    this.audioCtx.src = `${config.HTTP_BASE}${round.audioUrl}`;
    this.audioCtx.play();
  },

  _stopAudio() {
    this.currentAudioKey = null;
    if (this.audioCtx) {
      this.audioCtx.stop();
    }
  },

  _updateCountdowns() {
    const room = this.data.room;
    if (!room) return;
    if (room.status === 'countdown' && room.countdownEndsAt) {
      this.setData({
        countdownLeft: Math.max(1, Math.ceil((room.countdownEndsAt - Date.now()) / 1000))
      });
    }
    if (room.status === 'playing' && room.activeRound?.endsAt) {
      this.setData({
        roundSecondsLeft: Math.max(0, Math.ceil((room.activeRound.endsAt - Date.now()) / 1000))
      });
    }
  },

  onToggleReady() {
    this._send({ type: 'toggle_ready' });
  },

  onSoloStart() {
    this._send({ type: 'solo_start' });
  },

  onAddBot() {
    this._send({ type: 'add_bot' });
  },

  onRemoveBot() {
    this._send({ type: 'remove_bot' });
  },

  onVoteSkip() {
    this._send({ type: 'vote_skip' });
  },

  onGuessInput(e) {
    this.setData({ guessText: e.detail.value });
  },

  onSubmitGuess() {
    const text = (this.data.guessText || '').trim();
    if (!text) return;
    this._send({ type: 'submit_guess', text });
    this.setData({ guessText: '' });
  },

  onPlayAgain() {
    this._send({ type: 'play_again' });
  },

  onToggleVipPanel() {
    const next = !this.data.showVipPanel;
    this.setData({ showVipPanel: next });
    if (next) {
      this.onRefreshQr();
    } else {
      clearInterval(this.qrTimer);
    }
  },

  onSelectVipPlatform(e) {
    const plat = e.currentTarget.dataset.platform || 'kugou';
    this.setData({ vipPlatform: plat });
    this.onRefreshQr();
  },

  onRefreshQr() {
    clearInterval(this.qrTimer);
    const plat = this.data.vipPlatform || 'kugou';
    const appHints = {
      kugou: '请使用手机「酷狗音乐 APP」扫码',
      netease: '请使用手机「网易云音乐 APP」扫码',
      qq: '请使用「手机 QQ」扫码授权登录 QQ音乐'
    };
    this.setData({ qrStatusText: '正在获取二维码…', qrImgBase64: '' });
    wx.request({
      url: `${config.HTTP_BASE}/api/auth/${plat}/qr/create`,
      method: 'POST',
      success: (res) => {
        if (!res.data?.ok) {
          this.setData({ qrStatusText: res.data?.error || '获取二维码失败' });
          return;
        }
        const qrKey = res.data.qrKey;
        this.setData({
          qrImgBase64: res.data.qrImgBase64,
          qrStatusText: appHints[plat] || '请扫码登录'
        });
        this.qrTimer = setInterval(() => {
          wx.request({
            url: `${config.HTTP_BASE}/api/auth/${plat}/qr/check?key=${encodeURIComponent(qrKey)}`,
            success: (chkRes) => {
              const chk = chkRes.data;
              if (!chk?.ok) return;
              if (chk.state === 'expired') {
                clearInterval(this.qrTimer);
                this.setData({ qrStatusText: '二维码已过期，请点击刷新' });
              } else if (chk.state === 'scanned') {
                this.setData({ qrStatusText: '已扫码，请在手机端确认登录' });
              } else if (chk.state === 'authorized' && chk.authTicket) {
                clearInterval(this.qrTimer);
                this._send({ type: 'bind_vip', authTicket: chk.authTicket });
                this.setData({ showVipPanel: false });
                wx.showToast({ title: '已解锁会员曲库', icon: 'success' });
              }
            }
          });
        }, 2000);
      }
    });
  },

  onVipCookieInput(e) {
    this.setData({ vipCookie: e.detail.value });
  },

  onSubmitVipCookie() {
    const cookie = (this.data.vipCookie || '').trim();
    if (!cookie) return;
    const plat = this.data.vipPlatform || 'kugou';
    wx.request({
      url: `${config.HTTP_BASE}/api/auth/${plat}/manual`,
      method: 'POST',
      data: { cookie },
      success: (res) => {
        if (res.data?.ok && res.data.authTicket) {
          clearInterval(this.qrTimer);
          this._send({ type: 'bind_vip', authTicket: res.data.authTicket });
          this.setData({ showVipPanel: false, vipCookie: '' });
          wx.showToast({ title: '绑定成功', icon: 'success' });
        } else {
          wx.showToast({ title: res.data?.error || '凭证无效', icon: 'none' });
        }
      }
    });
  },

  onUnbindVip() {
    this._send({ type: 'unbind_vip' });
  },

  onLeaveRoom() {
    wx.navigateBack();
  }
});

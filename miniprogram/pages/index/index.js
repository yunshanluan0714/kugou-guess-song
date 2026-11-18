const config = require('../../utils/config');
const app = getApp();

Page({
  data: {
    nickname: '',
    roomCode: '',
    category: 'all',
    roundDurationSec: 45,
    poolText: '正在连接酷狗华语曲库…',
    publicRooms: [],
    categories: [
      { value: 'all', label: '全部华语' },
      { value: 'classic', label: '经典怀旧' },
      { value: 'chart', label: '流行热歌' },
      { value: 'folk_rock', label: '民谣摇滚' },
      { value: 'cantonese_ost', label: '粤语影视' }
    ],
    durations: [30, 45, 60]
  },

  onLoad(options) {
    this.setData({
      nickname: app.globalData.nickname || '微信歌友',
      roomCode: options?.room || ''
    });
    this.loadHealth();
    this.loadPublicRooms();
  },

  onShow() {
    this.loadPublicRooms();
  },

  loadHealth() {
    wx.request({
      url: `${config.HTTP_BASE}/api/health`,
      success: (res) => {
        if (res.data?.ok) {
          this.setData({
            poolText: `已接入 ${res.data.uniqueSongs || res.data.poolSize} 首酷狗华语歌曲`
          });
        }
      },
      fail: () => {
        this.setData({ poolText: '请确认本地后端服务已启动' });
      }
    });
  },

  loadPublicRooms() {
    wx.request({
      url: `${config.HTTP_BASE}/api/rooms`,
      success: (res) => {
        this.setData({
          publicRooms: res.data?.rooms || []
        });
      }
    });
  },

  onNicknameInput(e) {
    const nickname = e.detail.value;
    this.setData({ nickname });
    app.globalData.nickname = nickname;
    wx.setStorageSync('kugou_guess_nickname', nickname);
  },

  onRoomCodeInput(e) {
    this.setData({ roomCode: e.detail.value });
  },

  onSelectCategory(e) {
    this.setData({ category: e.currentTarget.dataset.val });
  },

  onSelectDuration(e) {
    this.setData({ roundDurationSec: Number(e.currentTarget.dataset.val) });
  },

  _checkNickname() {
    const nick = (this.data.nickname || '').trim();
    if (!nick) {
      wx.showToast({ title: '请先输入昵称', icon: 'none' });
      return null;
    }
    app.globalData.nickname = nick;
    wx.setStorageSync('kugou_guess_nickname', nick);
    return nick;
  },

  onCreateRoom() {
    if (!this._checkNickname()) return;
    const { category, roundDurationSec } = this.data;
    wx.navigateTo({
      url: `/pages/room/room?mode=create&category=${category}&duration=${roundDurationSec}`
    });
  },

  onJoinByCode() {
    if (!this._checkNickname()) return;
    const code = (this.data.roomCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入 6 位房间号', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/room/room?mode=join&code=${code}`
    });
  },

  onJoinPublic(e) {
    if (!this._checkNickname()) return;
    const code = e.currentTarget.dataset.code;
    wx.navigateTo({
      url: `/pages/room/room?mode=join&code=${code}`
    });
  }
});

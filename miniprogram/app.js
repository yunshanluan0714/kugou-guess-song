App({
  globalData: {
    clientId: '',
    nickname: ''
  },

  onLaunch() {
    let clientId = wx.getStorageSync('kugou_guess_client_id');
    if (!clientId) {
      clientId = `wx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      wx.setStorageSync('kugou_guess_client_id', clientId);
    }
    this.globalData.clientId = clientId;
    this.globalData.nickname = wx.getStorageSync('kugou_guess_nickname') || '微信歌友';
  }
});

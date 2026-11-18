# 华语猜歌 · 酷狗华语曲库多人线上猜歌小程序

极简风格的多人在线实时华语猜歌小程序，基于 Node.js + Express + WebSocket 构建，实时接入酷狗音乐纯华语曲库，支持**酷狗 APP 扫码/Cookie 登录会员解锁全量 VIP 原版曲库**，并已内置完整的 **GitHub + 云平台免费部署** 配置，同时提供网页端（H5）与原生微信小程序（`miniprogram/`）。

---

## 核心特性

- **千首级纯华语曲库**：分页拉取酷狗 20 个华语榜单、23 个华语主题歌单与 80+ 位华语代表歌手曲目，支持 `全部华语`、`经典怀旧`、`流行热歌`、`民谣摇滚`、`粤语影视` 五大分类，严格过滤外语歌及伴奏/纯音乐/DJ 混音版。
- **会员扫码实时拉取（一人登录，全房共享）**：房间内任意玩家通过酷狗音乐 APP 扫码（或粘贴 Cookie/Token）登录会员后，服务端通过酷狗 v5 签名网关实时解锁周杰伦、林俊杰、陈奕迅等 VIP 原版录音室音轨；凭证仅存于房间内存、绝不落盘，也不会泄露给同房其他玩家。
- **全员就绪即开局**：房间内所有在线玩家全部点击「准备就绪」后自动倒计时开局；支持添加 AI 歌友陪练。
- **前 50% 随机节点切入**：每轮随机抽取一首歌，从总时长前 `50%` 区间内随机节点开始流式播放（支持 HTTP `206` Range 秒跳与防作弊隐藏歌名）。
- **十轮抢答积分排名**：底部输入框提交歌名（内置中文输入法防误触回车），歌名一致即结束本轮并 `+1` 分，满 10 轮后按得分生成最终排行榜与歌单回顾。

---

## 本地运行

```bash
npm install
npm start
```

浏览器访问 `http://localhost:3000`（打开多个标签页即可模拟多人联机）。运行自动化测试：

```bash
npm test
```

---

## GitHub + 云平台免费部署指南

本项目已内置 `Dockerfile`、`zeabur.json`、`railway.json`、`render.yaml` 及 GitHub Actions 工作流，按以下两步即可免费上线：

### 第一步：上传代码到你的 GitHub 仓库

1. 登录 GitHub 新建一个空仓库（例如命名为 `kugou-guess-song`）。
2. 在本项目根目录执行以下命令推送代码：

```bash
git remote add origin https://github.com/你的用户名/kugou-guess-song.git
git branch -M main
git push -u origin main
```

### 第二步：选择任意免费云平台一键绑定 GitHub 部署

> **节点选择提示**：酷狗音乐音频 CDN 对部分欧美海外 IP 有地区版权限制。部署时优先选择**香港/亚太节点**（如 Zeabur 香港/东京节点，或 Railway 亚太区），可确保国内曲库 100% 流畅拉取。

#### 方案 A：Zeabur 部署（推荐，支持亚太节点且对国内访问友好）
1. 打开 [Zeabur](https://zeabur.com) 并使用 GitHub 登录。
2. 创建项目（地区建议选香港或东京） -> 点击 **Add Service** -> **Git** -> 选择刚上传的 `kugou-guess-song` 仓库。
3. Zeabur 会自动识别 `zeabur.json` / `Dockerfile` 完成构建并启动。
4. 在服务的 **Networking** 中点击 **Generate Domain** 生成免费 HTTPS 域名，发给朋友点开即可直接联机！

#### 方案 B：Railway / Render 免费部署
- **Railway**：登录 [Railway](https://railway.app) -> **New Project** -> **Deploy from GitHub repo** -> 选中 `kugou-guess-song`（自动读取 `railway.json`）-> 在 Settings -> Networking 生成公网域名即可。
- **Render**：登录 [Render](https://render.com) -> **New** -> **Blueprint**（或 Web Service）-> 连接 GitHub 仓库 `kugou-guess-song`（自动读取 `render.yaml` 使用 Free 套餐部署）。

#### 可选进阶：使用 GitHub Pages 作为前端入口域名
云平台本身已自带完整前后端网页，直接访问云平台网址即可游玩。如果你还希望绑定 `https://你的用户名.github.io/kugou-guess-song/` 网址：
1. 在 GitHub 仓库进入 **Settings -> Pages**，将 **Source** 设为 **GitHub Actions**。
2. 进入 **Settings -> Secrets and variables -> Actions -> Variables**，新增变量 `CLOUD_API_ORIGIN`，值填你的云平台后端地址（例如 `https://kugou-guess.zeabur.app`，末尾不加斜杠）。
3. 仓库内置的 `.github/workflows/deploy-pages.yml` 会自动将前端发布到 GitHub Pages 并对接你的云端后端（也可以直接在网址后加 `?api=https://你的云后端地址` 动态切换）。

---

## 导入原生微信小程序

1. 打开「微信开发者工具」，导入本项目下的 `miniprogram/` 目录。
2. 将 `miniprogram/utils/config.js` 中的 `HTTP_BASE` 与 `WS_BASE` 改为你部署后的云平台 `https://...` 与 `wss://...` 域名即可真机联机。

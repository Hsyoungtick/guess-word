# 词频对决

试玩：[https://hsyoungtick.github.io/guess-word/](https://hsyoungtick.github.io/guess-word/)

多人在线向量语义猜词游戏。玩家加入同一个房间后轮流猜词，服务端使用中文向量模型计算猜词与答案的语义相似度，并通过历史分数锚点维持整局的相对排序。

## 游戏规则

- 创建或加入一个六位数字房间。
- 昵称可以留空，系统会随机生成 `玩家ABCDEF` 格式昵称。
- 一个房间最多支持 8 位玩家。
- 房主开始游戏后，服务端从词库随机抽取一个 1～8 字答案。
- 答案只保存在服务端，玩家只能看到猜词的语义关联度。
- 玩家按顺序轮流猜词，每回合 60 秒。
- 猜词提交后，倒计时暂停并显示向量计算状态。
- 猜中答案获得胜利。
- 房间只剩一名玩家时自动暂停，其他玩家加入后恢复。
- 房主退出后，剩余玩家中最早加入的人接任房主。
- 没有在线玩家的房间显示 `0/8`，并在五分钟后自动销毁。

## 功能特性

- 🎮 多人在线轮流猜词
- 🌐 六位数字房间与在线房间大厅
- 👥 最多 8 人同房间实时同步
- 🧠 中文向量语义相似度评分
- 📊 红黄绿百分比关联度显示
- 🔢 猜测历史按时间或百分比排序
- 💾 浏览器房间记录与原房间恢复
- ⏱️ 60 秒回合与向量计算期间倒计时冻结
- 🧹 空房检测、销毁倒计时与自动清理
- 📱 响应式设计

## 技术栈

- **前端**: React 18 + TypeScript
- **构建工具**: Vite 6
- **样式**: CSS
- **实时同步**: Supabase Realtime + Edge Function
- **语义评分**: SiliconFlow `BAAI/bge-m3` Embeddings
- **数据库**: Supabase PostgreSQL
- **图标**: Lucide React + SVG favicon
- **部署**: GitHub Pages（前端）+ Supabase（数据库与 Edge Function）

## 快速开始

### 环境要求

- Node.js 18+
- npm
- Supabase CLI（部署数据库和 Edge Function 时需要）

### 安装与启动

```bash
# 安装依赖
npm install

# 创建环境文件
cp .env.example .env

# 启动开发服务器
npm run dev
```

访问 <http://localhost:5173> 开始游戏。

### 检查与构建

```bash
# TypeScript 检查
npm run check

# ESLint
npm run lint

# 单元测试
npm test

# 构建生产版本
npm run build
```

## 项目结构

```text
guess-word/
├── src/
│   ├── pages/
│   │   └── Home.tsx                 # 首页、大厅和游戏房间
│   ├── hooks/
│   │   └── useOnlineGame.ts         # 房间状态同步
│   ├── api.ts                       # 前端 API 客户端
│   ├── types.ts                     # 前端类型定义
│   └── index.css                    # 全局样式
├── supabase/
│   ├── functions/game/
│   │   ├── index.ts                 # 游戏 Edge Function
│   │   ├── game-logic.ts            # 向量评分与历史锚点约束
│   │   └── game-logic.test.ts       # 评分逻辑测试
│   └── migrations/                  # 数据库迁移
├── public/
│   └── favicon.svg                  # 网站图标
├── index.html                       # 页面入口
├── .env.example                     # 前端与服务端配置示例
└── package.json                     # 项目脚本与依赖
```

## 向量评分

游戏服务端使用 OpenAI 兼容的 Embeddings API，默认配置为 SiliconFlow 的 `BAAI/bge-m3`。

每次猜词时：

1. 服务端解密答案，但不会将答案返回给客户端。
2. 一次请求答案、历史猜词和当前猜词的向量。
3. 在 Edge Function 内计算余弦相似度。
4. 将相似度校准为 `0~99` 的整数分数。
5. 按向量相似度生成历史词排序。
6. 通过历史分数锚点限制新分数的合法区间。
7. 将最终分数写入猜测记录。

向量服务密钥只配置在 Supabase Edge Function Secrets，不会进入前端构建产物。生产部署前必须设置有效的 SiliconFlow API Key。

## 配置向量服务

`.env.example` 中的 `VITE_*` 变量用于前端，本地开发时可以写入 `.env`。

服务端配置通过 Supabase Secrets 设置：

```bash
npx supabase login
npx supabase link --project-ref your-project-ref

npx supabase secrets set SUPABASE_URL=https://your-project.supabase.co
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
npx supabase secrets set GAME_SECRET=your-random-secret-at-least-32-characters
npx supabase secrets set ALLOWED_ORIGIN=https://your-name.github.io,http://localhost:5173
npx supabase secrets set EMBEDDING_CONFIG='{"baseUrl":"https://api.siliconflow.cn/v1","apiKey":"your-siliconflow-api-key","model":"BAAI/bge-m3","timeoutMs":10000,"scoreFloor":0.2,"scoreCeiling":0.8}'
```

`scoreFloor` 和 `scoreCeiling` 是相似度校准区间。不同向量模型需要根据实际中文词语样本重新校准，不建议直接套用其他模型的区间。

## 部署方案

### 1. 部署 Supabase

```bash
# 登录并链接项目
npx supabase login
npx supabase link --project-ref your-project-ref

# 推送数据库迁移
npx supabase db push

# 部署游戏 Edge Function
npx supabase functions deploy game
```

数据库迁移会创建和更新：

- 房间、玩家、猜测记录和词库。
- 60 秒回合与向量计算锁。
- 房主转移和单人暂停。
- 空房五分钟销毁任务。
- 每 30 秒心跳清理任务。
- 在线大厅和销毁时间字段。

### 2. 部署 GitHub Pages

项目已配置 GitHub Actions。推送到 `main` 分支后会自动构建并发布。

前端构建变量：

```text
VITE_SUPABASE_FUNCTION_URL=https://your-project.supabase.co/functions/v1/game
VITE_BASE_PATH=/guess-word/
```

也可以手动构建：

```bash
npm run build
```

构建产物位于 `dist/` 目录。

## 架构说明

```text
┌──────────────┐        HTTPS        ┌──────────────────────┐
│  Browser A   │◄───────────────────►│                      │
└──────────────┘                     │  Supabase Edge       │
                                     │  Function: game      │
┌──────────────┐        HTTPS        │                      │
│  Browser B   │◄───────────────────►│  房间状态 / 回合锁    │
└──────────────┘                     │  向量评分 / 权限校验  │
                                     └──────────┬───────────┘
                                                │
                    ┌───────────────────────────┼────────────────────┐
                    │                           │                    │
              PostgreSQL                 Embeddings API       Realtime Events
              房间与猜测记录              SiliconFlow              状态同步
```

- **前端**：负责页面交互、倒计时展示、房间大厅和本地浏览器记录。
- **Edge Function**：负责玩家身份、房间权限、回合状态、答案解密、向量请求和分数提交。
- **PostgreSQL**：保存房间、玩家、词库、猜测记录和房间事件。
- **向量服务**：只接收服务端发起的语义向量请求，不直接暴露给浏览器。
- **历史锚点**：保证后续猜词的分数不会破坏之前已经建立的远近关系。

## 许可证

[MIT](LICENSE)

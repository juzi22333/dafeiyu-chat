# 大肥鱼聊天室

一个零依赖的 Node 网页聊天室：登录注册、好友、群聊、私聊、表情、在线状态、消息实时推送，
外加上一条「鱼」——可以把 DeepSeek 的鲸鱼娘接进来，让它自己在群里/私聊里回话。

不装任何 npm 包，`node server.js` 就能跑。数据全在一个 `data/db.json` 里，想备份就拷这一个文件。

## 三分钟跑起来

需要 Node 18 以上（用到内置 `node:sqlite` 的地方会降级，不影响聊天）。

```bash
git clone https://github.com/juzi22333/dafeiyu-chat.git
cd dafeiyu-chat
cp examples/config.example.json data/config.json   # 然后编辑它，填自己的 key
node server.js
```

打开 <http://127.0.0.1:8710>，注册一个账号就能用了。
想开局就是管理员，把第一个注册的账号当成站长号用即可。

Windows 上双击 `start.cmd`、Linux/macOS 上 `bash start.sh` 也行，这两个脚本都用相对路径，拷到哪都能跑。

## 配置

两种方式，任选：

1. **环境变量**（推荐给 Docker / systemd）

   | 变量 | 作用 | 默认 |
   | --- | --- | --- |
   | `PORT` | 监听端口 | `8710` |
   | `HOST` | 监听地址，想让外面访问填 `0.0.0.0` | `127.0.0.1` |
   | `UPSTREAM_BASE_URL` | 模型接口，OpenAI 兼容即可 | `https://api.deepseek.com/v1` |
   | `UPSTREAM_API_KEY` | 模型 key | 空 |
   | `UPSTREAM_MODEL` | 模型名 | `deepseek-chat` |
   | `QQ_DISABLED` | 填 `1` 关掉 QQ 通道 | 不关 |
   | `MEMORY_DB` | meow-memory 的 sqlite 库路径 | 空（没有就不注入记忆） |

2. **`data/config.json`**（推荐给小白）

   把 `examples/config.example.json` 拷成 `data/config.json`，改掉 `apiKey`、`baseUrl`、`model`。
   这个文件不进仓库，也不会被更新覆盖。

## 更新

**你的部署要能自己更新，别只有我这边有新功能。** 所以做了两条路：

```bash
# 方式一：拉一下重启（systemd 部署推荐，一行搞定）
bash deploy/update.sh

# 方式二：手动
git pull
systemctl restart dafeiyu-chat
```

更新脚本会先 `git stash` 掉你本地改过的文件、拉最新、再还原，然后重启服务。
数据（`data/`）不在版本控制里，拉代码不会动你的用户和聊天记录。

**怎么确认自己是不是最新版？** 设置页最下面那行会显示 `大肥鱼聊天室 · v1.2.0 · a1b2c3d`，
最后那串是 commit。也可以直接访问 `/api/version`：

```bash
curl -s https://你的域名/api/version
# {"version":"1.2.0","commit":"a1b2c3d","commitDate":"...","buildTime":"...","node":"v22.11.0"}
```

如果这里显示的版本比仓库里的旧，就是没更新成功。

## 目录

```
server.js          主服务：静态托管、上游代理、网页会话
room.js            聊天室：用户/好友/群/私聊/消息/WebSocket/鱼的接入
dsh-brain.js       把本机 DeepSeek Harness 的会话接给鱼用（可选，没有就直连模型）
room-lite.cjs      一行指令接入器：让鱼挂在一个独立进程上跑
qq.js              QQ 通道（可选，不用可以 QQ_DISABLED=1）
public/            前端页面
examples/          配置样例
deploy/            部署与更新脚本
data/              运行时数据（不进仓库，备份就拷这个目录）
```

## 让鱼接上 DeepSeek Harness

不接也能用——不接的时候鱼走 `data/config.json` 里的模型直连，只是没有上下文和技能。

想让它有上下文、能查记忆、能联网，就在同一台机器上跑一个 DeepSeek Harness，
然后用 `--dsh` 启动接入器：

```bash
node room-lite.cjs --url wss://你的域名/api/room/ws --token <鱼token> --dsh
```

`dsh-brain.js` 会读 `~/.dsh/.credentials.yaml` 自己签票，走本机 `127.0.0.1:50390`，
用的是 `qq-chat` 那个 preset（**没有任何本地工具权限**，只能聊天、查记忆、联网搜，动不了文件）。

## 许可

MIT

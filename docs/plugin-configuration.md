# 插件 JSON 配置

入口：**设置 → 插件 → 选择插件包或独立扩展 → 插件配置**。

此功能编辑插件已有的 JSON 文件，不增加 Pi 专用配置协议，也不会执行插件代码来猜测配置位置。独立扩展需采用自己的目录和 `index.ts` / `index.js` 入口，例如 `~/.pi/agent/extensions/hindsight-distill/index.ts`；读取同目录的 `config.json` / `config.example.json`。共享扩展目录下的单文件 `foo.ts` 暂不推断配置归属。

## 文件发现

| 发现情况 | 行为 |
| --- | --- |
| 根目录有 `config.json` 和 `config.example.json` | 展示现有值；可显式添加示例中尚未配置的字段 |
| 只有 `config.example.json` | 显示拟创建的根目录 `config.json` 路径；确认插件读取此位置后，可选择字段并保存 |
| 只有 `config.json` | 编辑已存在的字段；不推断其他可用字段 |
| 两者都没有，且未适配外部配置 | 显示未发现可编辑配置，不创建空文件 |

只查插件包根目录或独立扩展入口所在目录，不递归查找，不把 `package.json`、`tsconfig.json` 等普通 JSON 当作插件配置。API 根据已注册插件的 source/scope 或 SDK 实际发现的独立扩展路径/scope 定位目录，不接受任意配置路径。独立扩展发现使用只含 extensions 设置的内存视图，不解析包、不安装依赖、不执行扩展。项目扩展仍须信任。

示例不是 JSON Schema，不能推断必填、枚举或数值范围。示例值不会自动复制进配置：点击“添加字段”才将该字段加入草稿；敏感示例不会回传，需要自行输入。

仅支持以对象为根的 JSON。JSONC、YAML、环境变量及插件写入 `settings.json` 的自定义键不在此入口的自动发现范围。

### 已适配的外部配置

外部配置只编辑**已存在的文件**，不创建新的配置目录或覆盖层。适配以 npm source 身份为准，本地包仅在 package.json 中声称同名不会获得这些路径的访问权。

- `pi-web-access`：`web-search.json`。遵循插件 `utils.ts` 的位置选择：显式 `PI_CODING_AGENT_DIR`；否则检查 `XDG_CONFIG_HOME/pi` 或 `~/.pi/agent`，并按插件规则回退到 `~/.pi/web-search.json`。
- `pi-lsp`：遵循插件 `_shared/config.ts`，全局位置为 `PI_AGENT_DIR/lsp.json`，否则 `$HOME/.pi/agent/lsp.json`（该插件使用的是 **PI_AGENT_DIR**）。受信任项目还可编辑当前 cwd 的 `.pi/lsp.json`。插件自身可向父目录查找，但此编辑器不扩展 cwd 授权到父目录。插件自己的配置哈希信任判断仍然有效。
- `@juicesharp/rpiv-ask-user-question`：遵循 `@juicesharp/rpiv-config`，优先 `XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`，缺失时回退 `~/.config/rpiv-ask-user-question/config.json`。相对 XDG 路径无效，`~` 按插件规则展开。

新增适配时，应核实插件当前版本的实际读取源码和路径优先级，并加入路径、缺失、冲突、身份与越界测试。不要只根据 README 中任意文本生成写入权限。

## 编辑与生效

- 字符串、有限数字和布尔值使用相应控件；普通嵌套对象展开为字段；数组、空对象和 `null` 使用 JSON 编辑。容器内的结构可以整体修改。
- 只发送和更新修改的字段，其余字段保持不变。“移除字段”删除该键，“撤销”恢复当前读取状态，“取消修改”丢弃本次草稿。
- 保存前检查配置和示例是否发生外部变化。冲突保留草稿，不覆盖新文件；重新打开插件读取最新内容后再编辑。
- 保存不自动重载会话、不启动新会话、不重启服务。按插件说明重新加载或重启；部分插件每次调用重新读取，部分会缓存。
- 包安装目录内的文件可能在插件更新或卸载时丢失。创建前确认该路径是插件实际读取的位置；存在示例文件本身不能证明这一点。

## 安全与边界

- API 沿用登录、Host/Origin、cwd 访问及项目信任检查；配置响应禁止缓存。
- 识别到的 password、token、API key、凭据 URL 等敏感值不回传、不写日志；含敏感值的对象/数组作为一个隐藏字段替换或移除。自定义字段名或私有凭据格式仍可能无法识别，不能当作完整的秘密检测系统。
- 配置与示例限 128 KiB、16 层、5,000 个 JSON 节点、300 个编辑字段。损坏、超限、非普通文件、根目录以下的符号链接和硬链接均拒绝编辑。
- 保存使用 SDK 文件队列、跨进程锁、写前版本检查和同目录临时文件；已有文件原子替换，新文件独占发布，权限为 0600。锁只能协调合作的写入者，不能保证与不使用锁的任意外部编辑器实现文件系统级比较交换。
- 服务端仅接受发现出的字段路径，拒绝原型污染键；示例与未修改字段不会被重置。

## 验证

```sh
node --experimental-strip-types --test lib/plugin-config.test.mjs app/api/plugins/config/route.test.mjs
node e2e/plugin-config.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

浏览器测试使用隔离的临时 HOME / agent 目录和真实 API、登录校验，不修改用户插件。若默认 Playwright 浏览器未安装，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已安装 Chromium。测试不运行 `next build`，不需要重启 30141 服务。

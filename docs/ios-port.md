# dsh 移植到越狱 iOS（rootless / Dopamine）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）移植到越狱 iOS 的完整工程：
- **Node.js 22.23.2** 交叉编译为 iOS arm64（rootless `/var/jb` 布局），**V8 完整 JIT（mprotect W^X 补丁）+ small-icu**（Unicode 正则可用）
- **node-pty** 交叉编译真模块（真实 forkpty，终端功能完整）
- **sharp / node-addon-require-builtin** 用 JS shim 替代（libvips 无法在 iOS 编译）
- **fetch-shim**：undici（wasm llhttp）在 A14 上不可用，`fetch` 经 `node:http`（native parser）转发
- 标准 **.deb** 交付（`iphoneos-arm64`，dpkg 管理，postinst 自动 ldid 签名）

## 目录

| 路径 | 说明 |
|---|---|
| `.github/workflows/build-dsh-ios.yml` | GitHub Actions：云端全自动交叉编译 + 打包（macOS runner + Xcode） |
| `scripts/ios/apply_patches.py` | 源码补丁（幂等）：node / node-pty / V8 W^X |
| `scripts/ios/build-node-ios.sh` | 编译 Node 22 → nodejs deb |
| `scripts/ios/build-dsh-ios.sh` | 编译 node-pty addon + 打包 dsh 全量依赖 → dsh-ios deb（`TARGET=roothide` 切 roothide 变体） |
| `scripts/ios/repack-node-roothide.sh` | 把 rootless 版 nodejs deb 零编译重排为 roothide 包模型 |
| `scripts/ios/fetch-shim.cjs` | 运行时垫片：WebAssembly stub + node:http fetch（vendor 自配方仓库，随 deb 分发） |
| `ios-sdk-shim/mach/mach_vm.h` | iOS SDK 缺失的 mach_vm 声明（libSystem 运行时实际导出） |

> 独立的 **Node.js-for-ios 配方仓库**：[`ddddddedcds/Node.js-for-ios`](https://github.com/ddddddedcds/Node.js-for-ios)
> （V8 W^X 补丁脚本 / ninja 修复 / fetch-shim / launcher / clang 包装 / CI，附真机验证状态）。
> fetch-shim 已 vendor 进本仓库 `scripts/ios/fetch-shim.cjs`，随 dsh-ios deb 分发。

## 安装（设备端，root）

```sh
# Dopamine / rootless（iphoneos-arm64）：
dpkg -i nodejs_22.23.2-4_iphoneos-arm64.deb dsh-ios_0.1.5-rc.2-1_iphoneos-arm64.deb
dsh-ios    # 浏览器打开 http://127.0.0.1:3080

# RootHide Bootstrap / roothide（iphoneos-arm64e）：
dpkg -i nodejs_22.23.2-4_iphoneos-arm64e.deb dsh-ios_0.1.5-rc.2-1_iphoneos-arm64e.deb
dsh-ios    # 同上；launcher 全相对路径，无 /var/jb 也可解析
```

## 关键设计决策

### 1. JIT：V8 W^X 补丁（mprotect 切权限），不用 MAP_JIT
A14（arm64e）实测（C probe，dynamic-codesigning 签名）：

```
[wx-mprotect] PASS (exec ret=0)   ← mmap(RW) → 写代码 → mprotect(RX) → 执行：可用
[rwx-mmap   ] mapped
[map-jit    ] FAIL                ← MAP_JIT 死路（SIGBUS）
```

V8 默认 darwin 路径用 `MAP_JIT`（A14 上拿不到可执行页 → `KERN_PROTECTION_FAILURE` / SIGBUS）。
解法：移植 [openclaw-ios](https://github.com/j0shua-SYSON/openclaw-ios) 的 **V8 W^X 补丁**（`apply-v8-jit.py`，
7 文件 9 处）——代码区改走普通 mmap + mprotect 切权限。**设备实测完整 JIT 可用**（`JIT_OK`，无需 `--jitless`）。
entitlements 用 **dynamic-codesigning**（`platform-application` + `no-container` + `get-task-allow`），
`allow-jit` 单独无效。

### 2. 不用 `-DTARGET_OS_IPHONE`
定义该宏会让 V8 走 `V8_OS_IOS` 内存路径（MAP_JIT 问题 + 更多 iOS 专属分支），真机启动即崩。
不定义 → `V8_OS_MACOS` + `V8_TARGET_OS_IOS`（后者由 gyp `dest-os=ios` 的 flavor 机制自动设置）。

### 3. 关键系统限制（真机实测，A14 / iOS 16.7 / Dopamine rootless）
- `mmap(MAP_JIT)`：**失败**（SIGBUS，即使 CS_JIT 已授予）
- 普通 `mmap(RW)` + `mprotect(RX)`：**可用**（W^X 补丁的根基）
- **W^X race**：mprotect 切页与后台编译线程并发会崩 → 必须 `--predictable --single-threaded`
- **wasm 双路径不可用**：实例化崩（`WasmMemoryObject::UseInInstance`）+ 代码 GC 崩
  （`WasmCodeAllocator::FreeCode` decommit OOM）→ 见 fetch-shim 段

### 4. 其他补丁摘要（详见 apply_patches.py）
- c-ares：`HAVE_SYS_RANDOM_H` 关闭（macOS 独有头，改走 arc4random_buf）
- v8.gyp：trap handler 源提升到 target 顶层（原嵌套在 maglev 块内，maglev 关闭时不求值，mksnapshot 缺符号）
- node.gypi：CoreFoundation/Security framework 链接对 ios 生效
- crypto_context.cc：macOS 专属 SecTrustSettings 代码对 iOS 排除
- ninja 生成器：configure 后需去掉 host 变体与 target 冲突的 gen 输出规则（`fix-ninja.py`）
- node-pty `src/unix/pty.cc`：`libproc.h` 与 `pthread_chdir_np`/`pthread_fchdir_np` externs 是 macOS 专有，
  用 `#if defined(__APPLE__) && !defined(__aarch64__)` guard；`HANDLE_EINTR` 宏**必须留在 guard 外**
  （iOS 的 kqueue 等待块仍要用它）。
  - **踩坑修复（0.1.1-rc.2 构建）**：构建脚本的 python 补丁曾多插一个无配 `#endif` 的 `#if`，
    预处理失衡 → `error: unterminated conditional directive`，连带把块内 `HANDLE_EINTR` 宏吞掉 →
    后续 7 处 `HANDLE_EINTR` 报 `undeclared`。已修（`#if`/`#endif` 平衡，19/19）。
    同时把 node-gyp 失败从 `>/dev/null 2>&1 || true` 改为吐真实日志。

## 运行时垫片（fetch-shim）

**背景**：dsh 0.1.1 的 HTTP 客户端是 node 内建 **undici**，其 HTTP parser（llhttp）由 **WebAssembly** 编译；
A14 上 wasm 双路径都崩（见上），且 `--jitless` 时代还叠加 wasm 被禁。解法是**不碰 undici**——用一个
基于 `node:http`（native parser，无 wasm）的 `fetch` 覆盖全局：

- `globalThis.WebAssembly` 被 stub 为永不 settle 的 promise → undici 的 lazy llhttp 初始化永远挂起、不崩
- `globalThis.fetch` 覆盖为 `node:http` 实现（支持 SSE `getReader`、`AbortSignal.timeout`），
  内部使用**原生** `Request`/`Response`/`Headers`（构造时 resolve 相对 URL）
- **必须补 `User-Agent` 头**：node:http 默认不带 UA，DeepSeek API 网关把无 UA 的调用当机器人拒
  （401 governor）——shim 默认补 `user-agent: node`（这是"设备 401 / Mac 200"的真因，不是 TLS 指纹）
- **不要**加 `--no-experimental-fetch` / `--no-experimental-websocket`：它们会把 undici 的
  `Request`/`Response`/`Headers` **全局类也禁掉**，dsh 插件树（webRuntime→connection→apiProxy 链）
  启动时依赖这些类 → apiProxy 服务静默不激活 → 所有 `/api/*` 返回 404

launcher 完整参数见「推荐启动姿势」。

## 真机验证记录（iPhone 12 Pro Max, A14, iOS 16.7, Dopamine rootless）

- **JIT**：`node -e "console.log(1+1)"` 不带 `--jitless` → `JIT_OK`（W^X 补丁生效）
- **WebAssembly 本体**：`WebAssembly.compile/instantiate` 单次可用（`WASM_OK 42`），但**反复编译/GC 崩**（见上），故运行时整体 stub
- **ICU**：`process.versions.icu` = 78.2，`/\p{L}+/u.test("中文abc")` → true
- **fetch-shim**：30 次连续 HTTPS fetch 压力测试 `OK 30 / ERR 0`（曾必崩）；SSE 流式读取 2 事件 PASS
- **dsh web**：`dsh-ios` 启动后 `http://127.0.0.1:3080` 返回 **HTTP 200**（HTML 页），进程稳定、日志干净
- **LLM**：直连 `api.deepseek.com` chat 200 正常回复（shim 补 UA 后；此前 401 governor）
- **前端兼容**：`AbortSignal.any()` 需 iOS 17.4+ 的 Safari，iOS 16.7 需在 `index.html` 注入 polyfill（已注入）

## 运行时环境与通用性约束（真机实测 2026-08-27）

dsh-ios 附带的 nodejs 是**标准 Node.js 22.23.2**（arm64 iOS），任何**纯 JS** 程序都能运行；实际边界：

1. **JIT 可用但需防 race**：`--predictable --single-threaded` 必需（W^X 切页与编译线程竞争会 SIGBUS）；
   代价是 `worker_threads` 不可用（dsh 的 subagent 走子进程，不受影响）。
2. **WebAssembly 不可用（stub）**：A14 上 wasm 实例化与代码 GC 双路径崩（见上）。
   依赖 wasm 的库/工具无法使用（wasm 打包的压缩/加密/sqlite 等）。
3. **global fetch 用 shim**：undici（wasm llhttp）在 A14 上不可用 → `fetch` 走 `node:http` shim
   （native parser）。shim 随 dsh-ios deb 内置到 `/var/jb/usr/local/lib/fetch-shim.cjs`，
   `dsh-ios` launcher 自动 `--require` 挂载；其他 fetch 工具手动加
   `--require /var/jb/usr/local/lib/fetch-shim.cjs`。

其它注意：
- **原生 addon（.node）**：npm 现成 prebuilt 多为 macOS/Linux，iOS 无法 dlopen，需交叉编译 arm64 iOS 版
  （node-pty 已做）；纯 JS 包无此限制。
- **nodejs deb 只含 node 二进制，不含 npm CLI**：装其他工具需从开发机拷 `node_modules` 或自行补 npm。
- **Unicode 正则**：已带 ICU（small-icu），任意 `\p{...}` 属性正则可用。

## iOS 插件 stub（koffi / sandbox / subprocess）

dsh 0.1.1 的 `dsh-sandbox-local` / `dsh-subprocess-local` 依赖 **koffi**（FFI 原生 addon，
无 iOS prebuilt），sandbox 还依赖 Linux landlock 与 Windows ACL——**iOS 上这些能力本就不存在**
（toolpkg manifest 的 `disabled_features` 早已标注 "koffi - no ios prebuilt"）。但插件的硬
`import koffi` 会直接挡死 dsh web 启动。

**解法（已实测，dsh web 3080 返回 HTTP 200）**：把两个插件的 `lib/index.js` 替换为
**extends 基类的惰性 stub**（基类 `SandboxProvider` / `SubprocessRuntime` 是纯 JS，服务注册
`ctx.sandbox` / `ctx.subprocess` 仍生效，`dsh-bash-sandbox` / `dsh-permission-presets` 可正常
激活）：

```js
// dsh-sandbox-local/lib/index.js
import { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
export default class LocalSandboxProvider extends SandboxProvider {
  async start() {}
}
// dsh-subprocess-local/lib/index.js
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
export default class LocalSubprocessRuntime extends SubprocessRuntime {
  async start() {}
}
```

代价：沙箱隔离与 FFI 子进程在 iOS 上不可用（Node 内置 `child_process`/`fork` 仍可用）；
聊天气泡、Web UI、文件、会话等核心功能不受影响。若后续需要真 koffi，可交叉编译
（node-gyp，纯 C，15–30 分钟量级）。

> ✅ **stub 已固化进构建脚本**：`build-dsh-ios.sh` 打包时写入两个 stub
> （`dsh-sandbox-local`/`dsh-subprocess-local` 的 `lib/index.js`）。0.1.1-rc.2-2/-3 时代的
> stub 是构建脚本外的手工步骤，CI 重建会丢失，现已脚本化，重装设备不会回到 koffi 硬挡。

### 推荐启动姿势（dsh）
```sh
# /var/jb/usr/local/bin/dsh-ios —— 0.1.5-rc.2-1 起 deb 自带 launcher 已内置以下
# 全部参数（含 --require fetch-shim），无需手动敲：
node --predictable --single-threaded \
     --wasm-enforce-bounds-checks --wasm-max-mem-pages=16384 \
     --wasm-max-code-space-size-mb=64 --wasm-max-committed-code-mb=32 \
     --require /var/jb/usr/local/lib/fetch-shim.cjs \
     --expose-internals /var/jb/usr/local/bin/dsh web
```

### 推荐启动姿势（其他工具）
```sh
NODE_OPTIONS="--predictable --single-threaded \
  --require /var/jb/usr/local/lib/fetch-shim.cjs"
/var/jb/usr/local/bin/node your-tool.js
```

## Credits / 血缘

本 iOS 移植的思路与 recipe 借鉴自以下公开工作（**血缘/思路来源，非代码直接拷贝**）：
- [davghz/node22-ios-source](https://github.com/davghz/node22-ios-source) — Node 22 iOS 交叉编译 recipe
- [j0shua-SYSON/node-ios](https://github.com/j0shua-SYSON/node-ios) — Node iOS 移植参考
- [j0shua-SYSON/openclaw-ios](https://github.com/j0shua-SYSON/openclaw-ios) — **V8 W^X 补丁来源**（A9 验证，本工程适配 A14/arm64e）
- [imcynic/nodejs-ios](https://github.com/imcynic/nodejs-ios) — V8/iOS 无 MAP_JIT 路径实测（Node 18 行为对齐；该仓库无独立 LICENSE，仅思路参考）

## roothide 变体（RootHide Bootstrap）

roothide 不是 rootless：它把 bootstrap 装在**随机命名的 jbroot** 里（无固定 `/var/jb`），
deb 包模型为 [TheAppleWiki 记载](https://theapplewiki.com/wiki/Roothide) 的
**`Architecture: iphoneos-arm64e` + rootful 风格路径**——`./usr/...` 由 roothide 的
dpkg 在安装时迁入 jbroot。两个变体的差异只在打包层，构建产物同源：

- **nodejs**：`repack-node-roothide.sh` 把 rootless deb 的 data.tar 零编译重排
  （`./var/jb/usr/local/*` → `./usr/local/*`，架构改 `iphoneos-arm64e`），
  postinst 签名逻辑相同，trustcache 尝试 `jbctl`（Dopamine）后尝试 `trustcache`（Procursus 系）。
- **dsh-ios**：`build-dsh-ios.sh` 加 `TARGET=roothide`，同一套 node-pty 编译 + npm 依赖 +
  stub/shim，仅布局与架构不同。roothide launcher **全部相对脚本目录解析**
  （`$(dirname "$0")/node`、`../lib/fetch-shim.cjs`、`dsh` 符号链接）——bootstrap CLI 以
  jbroot 为默认根，相对路径在任何根语义下都成立；`DSH_HOME` 默认 `/var/mobile/.dsh`
  （roothide 下由 bootstrap 的根语义解析，dsh 会自动创建）。

> ⚠️ **roothide 变体未真机验证**：V8 W^X 补丁与 entitlements 签名在 roothide 上的行为
> 预期与 Dopamine 一致（同为 Fugu15 系），但未实测。设备装好后先跑
> `node -e "console.log(1+1)"`（应输出 2 且无 SIGKILL），再看 `/var/mobile/.dsh/postinst.log`
> 确认 ldid 签名与 trustcache 记录。

## 当前发布状态

- 最新 deb（两个越狱体系各一套，内容同源）：
  **rootless（Dopamine）**：`dsh-ios_0.1.5-rc.2-1_iphoneos-arm64.deb` +
  `nodejs_22.23.2-4_iphoneos-arm64.deb`；
  **roothide（RootHide Bootstrap，未真机验证）**：`dsh-ios_0.1.5-rc.2-1_iphoneos-arm64e.deb` +
  `nodejs_22.23.2-4_iphoneos-arm64e.deb`。
  dsh-ios 基于 `@deepseek-ai/dsh` **0.1.5-rc.2**（npm 显式 pin；**内含 koffi 插件 stub +
  fetch-shim**，launcher 自动 `--require fetch-shim.cjs`）。安装顺序：nodejs → dsh-ios。
  四个 deb 提交在 `dist/`。
- 仓库：`ios-port` 已合并上游 `deepseek-ai/deepseek-harness` master 至 **0.1.5-rc.2**
  （merge `fe89d19f`）；GitHub Actions（macOS runner）自动交叉编译 + 打包，产物见 workflow artifact。
- **0.1.5 未做真机回归**：上面的真机验证记录属于 0.1.1-rc.2；0.1.5 新增依赖均为纯 JS
  （hooks / webhook / sdk / http-proxy 等），无新原生 addon，stub/shim 兼容性待设备复核。
- 已知限制：WebAssembly 不可用（stub，见上）；沙箱/FFI 子进程不可用（koffi stub，见上）；
  sharp/libvips 图片附件不可用（shim）；worker_threads 不可用（--single-threaded）；
  iOS 16.7 Safari 缺 `AbortSignal.any`（17.4+ 才有）：**deb 未注入前端 polyfill**
  （0.1.1-rc.2 的注入是设备端手工操作，未固化；Safari 17.4+ 或升级 iOS 不受影响）。

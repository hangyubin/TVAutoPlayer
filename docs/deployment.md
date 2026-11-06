# 部署说明

## 测试部署

1. 从 [GitHub Release v1.6.3](https://github.com/hangyubin/TVAutoPlayer/releases/tag/v1.6.3) 下载 `TVAutoPlayer-v1.6.3-debug.apk` 并复制到 U 盘。
2. 电视开启“允许安装未知来源应用”。
3. 安装 APK，首次打开后授予照片和视频只读权限，在内置媒体库中选择图片或视频。
4. 在电视的应用/电池/后台管理中允许本应用自启动和后台运行。
5. 完全断电后重新上电，执行冷启动验收。

ADB 安装：

```powershell
adb install -r .\TVAutoPlayer-v1.6.0-debug.apk
```

模拟开机广播（仅测试，不等同于真实冷启动）：

```powershell
adb shell am broadcast -a android.intent.action.BOOT_COMPLETED com.chenwei.tvautoplay
```

## 正式发布签名

不要把密钥或密码提交到仓库。由企业安全保管发布 keystore，通过 Android Studio 的 “Generate Signed Bundle / APK” 或 CI 密钥库注入签名配置，生成 Release APK。以后升级必须保持 applicationId `com.chenwei.tvautoplay` 和签名证书不变。

## 版本升级

- 相同签名：`adb install -r 新版本.apk`，保留 SharedPreferences 和选片设置。
- 从 V1.0.0 升级到 V1.1.0 时，原单视频设置会自动转换为一项播放列表。
- 从 V1.0.0～V1.1.2 升级到 V1.2.0 时保留原播放列表和播放偏好；原系统文件选择器 URI 仍可继续播放。
- 从 V1.0.0～V1.3.1 升级到 V1.4.0 时保留旧播放列表；旧条目自动按视频处理，图片停留时间默认 10 秒。
- 首次使用 V1.4.0 图片功能时，Android 13+ 可能要求补充照片读取权限；拒绝不会删除已有配置或原文件。
- 从 V1.4.0 或更早版本升级到 V1.5.0 时，原默认播放列表和全部播放偏好保持不变；时间段总开关默认关闭，规则列表默认为空。
- V1.5.0 的时间段规则保存在应用私有 SharedPreferences；不复制媒体、不创建数据库、不改变原文件。
- 应用自动跟随电视系统语言：简体或繁体中文区域使用默认中文资源，英文区域使用英文资源，其他语言回退到中文。
- 不同签名：Android 会拒绝覆盖，必须卸载旧版，设置与 URI 授权将被清除。
- 图片和视频始终位于用户选择的原位置，卸载应用不会删除原媒体。

## 无系统文件选择器电视的操作

1. 在 U 盘创建 `Movies/TVAutoPlay` 和 `Pictures/TVAutoPlay`，分别放入视频和图片后安全弹出。
2. 把 U 盘插到电视并等待系统完成媒体索引。
3. 打开应用，允许读取照片和视频；进入内置媒体库后使用遥控器确认键逐个勾选。
4. 如果列表为空，重新插拔 U 盘、等待约 30 秒并选择“重新扫描”。不同厂商的媒体索引时机可能不同。
5. “使用系统文件选择器（可选）”按钮只会在电视确实存在可处理该请求的应用时显示。

## 时间段播放部署

1. 先配置默认播放列表，作为没有任何时间段生效时的回退内容。
2. 进入“时间段自动切换”，新增规则并以 30 分钟步进选择开始和结束时间。
3. 为每个规则从内置媒体库选择独立的图片/视频列表；启用规则不能重叠，结束早于开始表示跨午夜。
4. 保持应用在前台运行；时间边界会在约 30 秒内触发切换。
5. 若只配置未来时间段且默认列表为空，应用开机后显示等待页，到点后自动开始；这仍受电视厂商自启动限制。

## 服务端部署

服务端是零依赖的 Node.js 程序（要求 Node.js 22.5 及以上，使用内置 `node:sqlite`），负责媒体存储、默认节目单、直播源和时段计划，并向电视端下发 manifest。数据保存在 `server/data.db`，媒体文件保存在 `server/media/`。

### Linux

1. 安装 Node.js 22.5+（推荐 24）：

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   node -v
   ```

2. 在项目目录启动：

   ```bash
   cd /path/to/TVAutoPlayer/server
   PORT=8300 node server.js
   ```

3. 浏览器访问 `http://服务器IP:8300/`，默认账户 `admin / admin`，登录后立即修改密码。
4. 放行端口：`sudo ufw allow 8300/tcp`；云服务器还需要在安全组中放行。
5. 需要旧封装 MKV 自动重封装时安装 ffmpeg：`sudo apt install -y ffmpeg`。不安装只影响旧 MKV 上传，其他功能正常。

常驻运行并开机自启（systemd 用户服务，不需要 root）：

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tvautoplayer.service <<'EOF'
[Unit]
Description=TVAutoPlayer Server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/path/to/TVAutoPlayer/server
Environment=PORT=8300
Environment=PATH=/home/youruser/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tvautoplayer
loginctl enable-linger "$USER"
```

- `ExecStart` 的 node 路径用 `which node` 的结果替换，`WorkingDirectory` 改成实际目录，`PATH` 里的用户名和 node 目录按实际修改（需要包含 node 和 ffmpeg 所在目录）。
- `loginctl enable-linger` 必须执行，否则用户未登录时服务不会随开机启动。
- 查看状态与日志：`systemctl --user status tvautoplayer`、`journalctl --user -u tvautoplayer -f`。
- 进程异常退出会自动在 5 秒后重启；重启系统后可访问 `http://服务器IP:8300/` 确认已自动运行。

> 升级时只替换 `.js` 文件与 `public/` 目录，不要覆盖 `data.db` 和 `media/`；这两项需要定期备份。升级后执行 `systemctl --user restart tvautoplayer`。

### Windows（免安装绿色包）

1. 下载 Release 中的 `TVAutoPlayer-Server-Windows.zip` 并解压，建议使用纯英文短路径。
2. 双击 `启动服务.bat`。首次运行时 Windows 防火墙提示请点「允许访问」，否则电视端无法连接。
3. 浏览器会自动打开 `http://localhost:8300/`，默认账户 `admin / admin`，登录后立即修改密码。
4. 需要旧封装 MKV 自动重封装时，双击 `安装ffmpeg.bat`；不安装只影响旧 MKV。
5. 关闭命令行窗口即停止服务。需要开机自启时，把 `启动服务.bat` 的快捷方式放入「启动」文件夹（`shell:startup`）。

### 管理后台使用

| 页签 | 用途 |
|---|---|
| 媒体库 | 上传图片/视频，按内容哈希去重，支持预览和删除；也可扫描服务器文件夹批量导入 |
| 节目单 | 默认播放内容，无时段命中时循环播放；支持批量添加和拖动排序 |
| 直播源 | 保存多个 HLS/m3u8 源，添加时实测延迟与码率，可启停、复测、删除 |
| 时段 | 30 分钟步进，一个时段只绑定一个内容，可绑定媒体或直播源 |

所有保存操作都会通过长轮询在约 1 秒内推送到电视端。修改时段时间不会打断当前播放；内容结构未变化时电视端不重建播放器。

批量导入媒体：

- 扫描的就是媒体目录 `server/media/`（Windows 包内为 `TVAutoPlayer-Server\media\`），与网页上传共用同一个目录，没有额外目录。
- 把图片/视频复制到该目录（可含子目录），在「媒体库」点「扫描媒体文件夹」即可。
- 入库后文件会重命名为「内容哈希.扩展名」，是移动而不是复制，不额外占用磁盘；子目录中的文件会移动到媒体目录根目录。
- 已在库中的文件按文件名直接跳过；内容与库中某文件重复时保留原文件并跳过。
- 网页端不能指定其他路径，避免误扫描服务器系统目录。
- 扫描会递归子目录（最多 5 层），旧封装 MKV 自动重封装（需要 ffmpeg）。
- 单次最多处理 200 个新文件，超出会提示再次扫描。

直播源说明：

- 地址必须以 `http://` 或 `https://` 开头，内容需为 m3u8 播放列表。
- 添加时若延迟超过 3 秒或码率低于约 500 KB/s 会提示偏慢，可选择强制保存。
- 直播源全部播放失败时，电视端自动回落默认节目单并进入 5 分钟冷却，避免反复重试。
- 部分频道源存在地域或防盗链限制，请先用 VLC 在电视所在网络验证。

### 电视端接入

1. 电视与服务器需在同一局域网（或服务器可从公网访问）。
2. 应用设置中把「播放模式」切换为「服务器」。
3. 「服务器地址」填写 IP 或域名，例如 `192.168.2.166`，不需要 `http://` 前缀。
4. 设置页会显示连接状态、内容版本号和上次更新时间。

### 备份与迁移

- 备份 `server/data.db`（含账户、媒体索引、节目单、直播源、时段）和 `server/media/`。
- 迁移到新机器：复制这两项，加上 `server/*.js` 与 `server/public/`，使用相同端口启动即可。
- 服务器重启后电视端会自动重连，无需重新配置。

## 大规模无人值守部署

普通侧载 APK 的开机拉起受 Android 和厂商限制。大量设备或必须百分之百开机播放时，建议：

- 使用 Android Enterprise Device Owner / Dedicated Device（Kiosk）。
- 由电视/盒子厂商预装为系统应用或加入自启动白名单。
- 固定发布签名、设备型号、固件版本和媒体编码配置。
- 在上线前执行断电恢复、网络断开、U 盘松动、连续播放和存储损坏演练。

# IG Cookie 轮换守则（kyestu）

> 与 idol-bbq-utils `docs/zh/ig-cookie-rotation.md` 同源同则。依据：Instagram
> Android 443.0.0.48.82 / iOS 442.0.0 双端静态逆向（2026-08，`scratch/instagram-re/spider-intel.md` §1.1）。

## 承重 cookie 与设备级语义

| Cookie | 语义 | 轮换守则 |
|---|---|---|
| `sessionid` / `ds_user_id` | 账号身份主凭据 | 账号级：换账号时随之更换；死亡不可静默恢复（app 无静默重登类，检测到死就早换） |
| `csrftoken` | POST 防 CSRF | 每会话轮换；代码发起的 `web_profile_info` 是 GET，无需 `X-CSRFToken`，不动 |
| `mid` / `ig_did` | **设备指纹** | **设备级**：Android 登出不清除设备 ID（实测）；换账号 cookie 时**保留原值** |
| `datr` | 浏览器/设备标识（FB 系） | **设备级**（iOS keychain `com.facebook.datr` 实测）：保留 |
| `rur` / `shbid` / `shbts` | 路由/区域提示 | 服务端经响应头轮换，无需手动维护 |

## 换账号操作（同一 browser profile 内）

1. **保留** `mid`、`ig_did`、`datr`；
2. **替换** `sessionid`、`ds_user_id`、`csrftoken`；
3. 不要清整个 cookie jar——全清等于每次换"新设备"。

## 环境一致性

一套 cookie 绑定固定 **profile + UA + IP**。`delta_login_review` challenge 表示环境
指纹变化而非 cookie 过期——换回原环境比换 cookie 有效（intel §1.3）。spider 侧
会话死亡三谓词检测（`instagram_session_dead`）记录于 vendored spider
（`packages/spider/src/spiders/instagram.ts`），cooldown 侧
（`src/pipeline/cooldown.ts`）将其归 auth 类、6h IG 覆盖冷却。

# CI 诊断报告

- 生成时间：2026-09-26T11:59:23Z
- 触发事件：push
- 提交：ea29441
- 仓库：VaIMod/VaIMod

## 仓库元信息（private / visibility / has_pages / default_branch）
```json
  "private": false,
  "owner": {
  "has_pages": true,
  "visibility": "public",
  "default_branch": "main",
{
  "id": 1377241024,
  "node_id": "R_kgDOUhcHwA",
  "name": "VaIMod",
  "full_name": "VaIMod/VaIMod",
  "private": false,
  "owner": {
    "login": "VaIMod",
    "id": 331295874,
    "node_id": "O_kgDOE78sgg",
    "avatar_url": "https://avatars.githubusercontent.com/u/331295874?v=4",
    "gravatar_id": "",
    "url": "https://api.github.com/users/VaIMod",
    "html_url": "https://github.com/VaIMod",
    "followers_url": "https://api.github.com/users/VaIMod/followers",
    "following_url": "https://api.github.com/users/VaIMod/following{/other_user}",
    "gists_url": "https://api.github.com/users/VaIMod/gists{/gist_id}",
    "starred_url": "https://api.github.com/users/VaIMod/starred{/owner}{/repo}",
    "subscriptions_url": "https://api.github.com/users/VaIMod/subscriptions",
    "organizations_url": "https://api.github.com/users/VaIMod/orgs",
    "repos_url": "https://api.github.com/users/VaIMod/repos",
    "events_url": "https://api.github.com/users/VaIMod/events{/privacy}",
    "received_events_url": "https://api.github.com/users/VaIMod/received_events",
    "type": "Organization",
    "user_view_type": "public",
    "site_admin": false
  },
  "html_url": "https://github.com/Va
```

## 账号计划（Free 私有仓库不支持 Pages）
```json
{
  "message": "Resource not accessible by integration",
  "documentation_url": "https://docs.github.com/rest/users/users#get-the-authenticated-user",
  "status": "403"
}

```

## Pages 当前状态（HTTP 404 = 从未启用）
```
GET /pages -> HTTP 200
{
  "url": "https://api.github.com/repos/VaIMod/VaIMod/pages",
  "status": null,
  "cname": null,
  "custom_404": false,
  "html_url": "https://vaimod.github.io/VaIMod/",
  "build_type": "workflow",
  "source": {
    "branch": "main",
    "path": "/"
  },
  "public": true,
  "protected_domain_state": null,
  "pending_domain_unverified_at": null,
  "https_enforced": true
}

```

## 尝试启用 Pages（build_type=workflow，失败原因写在响应体里）
```
POST /pages -> HTTP 403
{
  "message": "Resource not accessible by integration",
  "documentation_url": "https://docs.github.com/rest/pages/pages#create-a-apiname-pages-site",
  "status": "403"
}

```

## 最近 5 次工作流运行
```json
      "name": "Build & Deploy",
      "head_sha": "ea29441c0ada8d981e5599ced3f2642be91f5c81",
      "event": "push",
      "status": "in_progress",
      "conclusion": null,
      "created_at": "2026-09-26T11:59:18Z",
          "name": "Maxkore-Geek",
          "name": "Maxkore-Geek",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "1f1f4b601f3b806eb7bc8d1afa03a6595cf43af0",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-09-26T11:32:04Z",
          "name": "Maxkore-Geek",
          "name": "Maxkore-Geek",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "87089a2ece6b2dd012fdc1e59eab0dde3ca3d00c",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-09-26T09:47:05Z",
          "name": "Maxkore",
          "name": "Maxkore",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "2a2a64faae42a0af626ca55fa9a3bdf9732ac5cd",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-09-26T05:48:36Z",
          "name": "Maxkore",
          "name": "Maxkore",
        "name": "VaIMod",
        "name": "VaIMod",
```

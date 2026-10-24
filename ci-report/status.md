# CI 诊断报告

- 生成时间：2026-10-24T09:29:58Z
- 触发事件：push
- 提交：0389e40
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
      "head_sha": "0389e40352fb9cb0b372750c99ab625c44069baa",
      "event": "push",
      "status": "in_progress",
      "conclusion": null,
      "created_at": "2026-10-24T09:29:53Z",
          "name": "Maxkore",
          "name": "Maxkore",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "eb8401692b928bd5105bb887aa01280fb00a6c7d",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-10-24T07:20:07Z",
          "name": "Maxkore",
          "name": "Maxkore",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "9cd0121b477d0153b052f8248c37e513e64c5fa2",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-10-24T07:18:39Z",
          "name": "Maxkore",
          "name": "Maxkore",
        "name": "VaIMod",
        "name": "VaIMod",
      "name": "Build & Deploy",
      "head_sha": "725ea47a1862cad83e1eb3b539fa3c05a2b7f8a5",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2026-10-24T05:34:16Z",
          "name": "Maxkore",
          "name": "Maxkore",
        "name": "VaIMod",
        "name": "VaIMod",
```
